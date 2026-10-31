/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BACKUP_BUCKET } from "./backup";

/**
 * Retention purge (spec §14). SERVICE-ROLE ONLY (job admin.retention_purge); every query filters workspace_id (S2).
 * Rules:
 *  - Only categories with an explicitly APPROVED policy row (approved_at set by an admin in /settings/retention) are
 *    purged. Seeded spec defaults are proposals, not approvals, so a fresh tenant purges nothing.
 *  - legal_hold on a category overrides deletion. retain_days null => keep (with provenance/staleness labels).
 *  - Rows that carry provenance are kept; only the bulky/sensitive payload is removed and the purge is recorded.
 *  - Audit records are never hard-deleted by the app (append-only); the job reports how many are past retention so
 *    the platform operator can archive them under the corporate policy.
 */
type Admin = SupabaseClient<any, any, any>;
type Row = Record<string, any>;

const AUDIO_EXT = /\.(m4a|mp3|wav|webm|ogg|oga|aac|amr|3gp|flac|opus)$/i;

export interface PurgeReport {
  workspace_id: string;
  ran_at: string;
  dryRun: boolean;
  categories: Record<string, { status: "purged" | "skipped"; reason?: string; affected: number; cutoff?: string }>;
}

function cutoffFor(days: number, now: Date) {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export async function purgeWorkspace(admin: Admin, workspaceId: string, opts: { now?: Date; dryRun?: boolean } = {}): Promise<PurgeReport> {
  const now = opts.now ?? new Date();
  const dryRun = !!opts.dryRun;
  const { data: policies, error } = await admin.from("retention_policy").select("*").eq("workspace_id", workspaceId);
  if (error) throw new Error(`retention_policy: ${error.message}`);
  const report: PurgeReport = { workspace_id: workspaceId, ran_at: now.toISOString(), dryRun, categories: {} };
  const byCat = new Map(((policies ?? []) as Row[]).map((p) => [p.category as string, p]));

  const gate = (cat: string): { ok: false; reason: string } | { ok: true; cutoff: string } => {
    const p = byCat.get(cat);
    if (!p) return { ok: false, reason: "no policy row" };
    if (!p.approved_at) return { ok: false, reason: "policy not approved by an admin" };
    if (p.legal_hold) return { ok: false, reason: "legal hold" };
    if (!p.retain_days) return { ok: false, reason: "retained indefinitely" };
    return { ok: true, cutoff: cutoffFor(Number(p.retain_days), now) };
  };
  const skip = (cat: string, reason: string) => { report.categories[cat] = { status: "skipped", reason, affected: 0 }; };

  // raw_audio: audio files of reviewed captures older than N days (transcript verified). Capture row and transcript stay.
  {
    const g = gate("raw_audio");
    if (!g.ok) skip("raw_audio", g.reason);
    else {
      const { data } = await admin.from("capture").select("id, storage_paths, source_at, status")
        .eq("workspace_id", workspaceId).eq("status", "reviewed").in("kind", ["audio", "mixed"]).lt("source_at", g.cutoff).limit(1000);
      let affected = 0;
      for (const c of (data ?? []) as Row[]) {
        const paths = ((c.storage_paths ?? []) as string[]);
        // Only this workspace's objects; never trust a path from another prefix.
        const audio = paths.filter((p) => AUDIO_EXT.test(p) && p.startsWith(`${workspaceId}/`));
        if (!audio.length) continue;
        affected += audio.length;
        if (dryRun) continue;
        await admin.storage.from(BACKUP_BUCKET).remove(audio);
        await admin.from("capture").update({ storage_paths: paths.filter((p) => !audio.includes(p)) }).eq("workspace_id", workspaceId).eq("id", c.id);
      }
      report.categories.raw_audio = { status: "purged", affected, cutoff: g.cutoff };
    }
  }

  // working_transcripts: clear transcript text of reviewed captures older than N days (extraction + approved changes stay).
  {
    const g = gate("working_transcripts");
    if (!g.ok) skip("working_transcripts", g.reason);
    else {
      const base = () => admin.from("capture").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)
        .eq("status", "reviewed").not("transcript", "is", null).lt("source_at", g.cutoff);
      const { count } = await base();
      if (!dryRun && count) {
        await admin.from("capture").update({ transcript: null }).eq("workspace_id", workspaceId).eq("status", "reviewed")
          .not("transcript", "is", null).lt("source_at", g.cutoff);
      }
      report.categories.working_transcripts = { status: "purged", affected: count ?? 0, cutoff: g.cutoff };
    }
  }

  // research_downloads: stored web downloads older than N days; the source_object row (provenance) is kept and marked.
  {
    const g = gate("research_downloads");
    if (!g.ok) skip("research_downloads", g.reason);
    else {
      const { data } = await admin.from("source_object").select("id, uri, meta").eq("workspace_id", workspaceId)
        .eq("kind", "web").lt("retrieved_at", g.cutoff).limit(1000);
      const stored = ((data ?? []) as Row[]).filter((s) => typeof s.uri === "string" && s.uri.startsWith(`${workspaceId}/`) && !s.meta?.purged_at);
      if (!dryRun) {
        for (const s of stored) {
          await admin.storage.from(BACKUP_BUCKET).remove([s.uri]);
          await admin.from("source_object").update({ meta: { ...(s.meta ?? {}), purged_at: now.toISOString(), purged_by: "retention_policy" } })
            .eq("workspace_id", workspaceId).eq("id", s.id);
        }
      }
      report.categories.research_downloads = { status: "purged", affected: stored.length, cutoff: g.cutoff };
    }
  }

  // audit_records: append-only — report only.
  {
    const g = gate("audit_records");
    if (!g.ok) skip("audit_records", g.reason);
    else {
      const { count } = await admin.from("audit_event").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).lt("occurred_at", g.cutoff);
      report.categories.audit_records = { status: "skipped", reason: `append-only: ${count ?? 0} event(s) past retention, archive via platform operator`, affected: 0, cutoff: g.cutoff };
    }
  }

  for (const cat of ["public_fact_observations", "contact_relationship_records"]) {
    skip(cat, byCat.get(cat)?.retain_days ? "no automatic purge for this category; review manually" : "retained indefinitely");
  }

  if (!dryRun) {
    await admin.from("audit_event").insert({
      workspace_id: workspaceId, actor_kind: "job", action: "retention_purge", entity_type: "retention_policy",
      after: report.categories, classification: "corporate_confidential",
    });
  }
  return report;
}

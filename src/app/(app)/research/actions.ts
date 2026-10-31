"use server";
import { formAction, str } from "@/modules/intelligence/ui/actions";
import { upsertWatch, addPastedEvidence, generateDossier, webResearch, detectSignalsForOrg } from "@/modules/intelligence/research/service";
import { saveSource, setSourceAllowed } from "@/modules/intelligence/research/registry";
import { runPatrol } from "@/modules/intelligence/research/patrol-service";
import { setFindingStatus } from "@/modules/intelligence/research/queries";
import type { ResearchTier } from "@/modules/intelligence/common";

const tierOf = (v: string | null): ResearchTier => (v === "critical" || v === "active" ? v : "universe");

export async function watchAction(form: FormData) {
  const orgId = str(form, "org_id") ?? "";
  const back = str(form, "back") ?? "/research";
  await formAction(back, "editor", async (ctx) => {
    if (!orgId) throw new Error("Choose a company.");
    const r = await upsertWatch(ctx.db, ctx.workspaceId, { orgId, tier: tierOf(str(form, "tier")), reason: str(form, "reason"), userId: ctx.userId });
    return r.warning ? `Saved. ${r.warning}` : "Saved to the research watchlist.";
  });
}

export async function generateAction(form: FormData) {
  const orgId = str(form, "org_id") ?? "";
  await formAction(`/research/${orgId}`, "editor", async (ctx) => {
    const r = await generateDossier(ctx.db, ctx.workspaceId, orgId, { force: form.get("force") === "1", userId: ctx.userId });
    if (r.status === "skipped") return "No new evidence and the refresh interval has not elapsed — dossier unchanged (no AI spend).";
    return r.synthesis_status === "fallback_no_ai" ? `Dossier v${r.dossier.version} built from stored evidence; AI synthesis unavailable (${r.degraded_reason}).` : `Dossier v${r.dossier.version} generated (${r.reason.replace(/_/g, " ")}).`;
  });
}

export async function evidenceAction(form: FormData) {
  const orgId = str(form, "org_id") ?? "";
  await formAction(`/research/${orgId}`, "editor", async (ctx) => {
    await addPastedEvidence(ctx.db, ctx.workspaceId, {
      orgId, claimType: (str(form, "claim_type") ?? "other") as never, text: str(form, "text") ?? "", url: str(form, "url"),
      publishedOn: str(form, "published_on"), observedOn: str(form, "observed_on"), evidenceTier: (str(form, "evidence_tier") ?? "single_unverified") as never,
      function: str(form, "function"), location: str(form, "location"),
      sourceId: str(form, "source_id") === "manual" ? null : str(form, "source_id"), manualNote: str(form, "source_id") === "manual",
    }, ctx.userId);
    return "Evidence stored (status: reported); any business signals in it were added as hypotheses. Refresh the dossier to include it.";
  });
}

export async function webResearchAction(form: FormData) {
  const orgId = str(form, "org_id") ?? "";
  await formAction(`/research/${orgId}`, "editor", async (ctx) => {
    const r = await webResearch(ctx.db, ctx.workspaceId, orgId, { userId: ctx.userId });
    return r.status === "ok" ? `${r.added} new cited claim(s) added as unverified evidence.` : r.reason;
  });
}

export async function patrolAction() {
  await formAction("/research", "editor", async (ctx) => {
    const r = await runPatrol(ctx.db, ctx.workspaceId);
    return `Patrol checked visible records: ${r.detected} finding(s), ${r.inserted} new.`;
  });
}

export async function findingAction(form: FormData) {
  await formAction("/research", "editor", async (ctx) => {
    await setFindingStatus(ctx.db, ctx.workspaceId, str(form, "id") ?? "", form.get("status") === "resolved" ? "resolved" : "dismissed");
    return "Finding updated.";
  });
}

export async function detectAction(form: FormData) {
  const orgId = str(form, "org_id") ?? "";
  await formAction(`/research/${orgId}`, "editor", async (ctx) => {
    const r = await detectSignalsForOrg(ctx.db, ctx.workspaceId, orgId, ctx.userId);
    return r.created ? `${r.created} signal hypothesis(es) added from stored evidence. Refresh the dossier to include them.` : "No new signals found in the stored evidence.";
  });
}

const csv = (v: string | null) => (v ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/\s+/g, "_")).filter(Boolean);

export async function sourceAction(form: FormData) {
  await formAction("/research/sources", "admin", async (ctx) => {
    const id = str(form, "id");
    const extra = form.getAll("prohibited").map(String);
    await saveSource(ctx.db, ctx.workspaceId, {
      name: str(form, "name") ?? "", kind: (str(form, "kind") ?? "website") as never, baseUrl: str(form, "base_url"), acquisitionMethod: (str(form, "acquisition_method") ?? "manual_paste") as never,
      licence: str(form, "licence"), licensedSourceId: str(form, "licensed_source_id"), rateLimitPerDay: str(form, "rate_limit_per_day"), refreshCadenceDays: str(form, "refresh_cadence_days"),
      storageRights: str(form, "storage_rights"), reuseRights: str(form, "reuse_rights"), credentialsOwner: str(form, "credentials_owner"), failurePolicy: str(form, "failure_policy"),
      sourceOwner: str(form, "source_owner"), allowed: form.get("allowed") === "on", prohibitedMethods: [...extra, ...csv(str(form, "prohibited_other"))],
    }, { id, expectedVersion: id ? Number(str(form, "row_version")) : null, userId: ctx.userId });
    return id ? "Source updated." : "Source added to the registry.";
  });
}

export async function sourceToggleAction(form: FormData) {
  await formAction("/research/sources", "admin", async (ctx) => {
    const allowed = form.get("allowed") === "1";
    await setSourceAllowed(ctx.db, ctx.workspaceId, str(form, "id") ?? "", allowed, ctx.userId);
    return allowed ? "Source enabled." : "Source disabled — it can no longer be cited or searched.";
  });
}

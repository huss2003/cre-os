import "server-only";
/**
 * Brief generation, versioning and delivery. Deterministic sections first (builder.ts), optional AI synthesis second
 * (synthesis.ts). A new brief version is written only when the deterministic content changed (content hash), so
 * repeated generation / retried jobs never duplicate. Delivery = delivered_at + one private outbox notification per
 * user/date (dedupe key) — never an external message (S3).
 */
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, type AiMode } from "@/lib/ai/policy";
import type { Db } from "@/lib/supabase/server";
import { stableHash } from "@/lib/util/crypto";
import { atLocal } from "@/lib/util/time";
import { buildBrief, type BriefContent, type BriefInputs, type BriefKind } from "./builder";
import { addDays } from "./dates";
import { notify } from "./db";
import { loadApprovals, loadApproaches, loadIntel, loadMeetings, loadOpenTasks, loadPipeline, loadReplies, loadSources, type LoadCtx } from "./data";
import { buildDailyPlan, computeDailyPlan, latestPlan } from "./plan";
import { loadRadar } from "./radar-data";
import type { BriefSettings } from "./settings";
import { synthesise, type StructuredCaller, type SynthesisOutcome } from "./synthesis";

export interface StoredBrief {
  id: string;
  user_id: string;
  brief_date: string;
  kind: BriefKind;
  subject_key: string;
  version: number;
  generated_at: string;
  content: BriefContent & { synthesis?: SynthesisOutcome; content_hash?: string; generated_by?: string; meeting?: unknown };
  synthesis_status: "ok" | "fallback_no_ai" | "partial";
  source_health: Record<string, unknown>;
  delivered_at: string | null;
}

const BRIEF_COLS = "id, user_id, brief_date, kind, subject_key, version, generated_at, content, synthesis_status, source_health, delivered_at";

export const gatewayCaller: StructuredCaller = (call) => callStructured(call as never) as never;

/** Caller used by the watchdog fallback: never touches the AI provider. */
export const noAiCaller: StructuredCaller = async () => {
  throw Object.assign(new Error("watchdog fallback"), { reason: "watchdog" });
};

/** `persistPlan: false` (page preview) computes a missing plan in memory instead of storing it. */
export async function gatherBriefInputs(c: LoadCtx, settings: BriefSettings, date: string, now: Date, opts: { persistPlan?: boolean } = {}): Promise<BriefInputs> {
  const plan = (await latestPlan(c, date)) ?? (opts.persistPlan === false
    ? { ...(await computeDailyPlan(c, settings, date)), generatedAt: null as string | null }
    : await buildDailyPlan(c, settings, date));
  const prev = await latestBrief(c.db, c.workspaceId, c.userId, addDays(date, -1), "daily");
  const since = prev?.generated_at ?? atLocal(addDays(date, -1), settings.briefTime, c.tz).toISOString();
  const [sources, tasks, meetings, radar, replies, approvals, intel, pipeline, approaches] = await Promise.all([
    loadSources(c, settings, now), loadOpenTasks(c), loadMeetings(c, date),
    loadRadar(c.db, c.workspaceId, date, settings, c.access ?? undefined), loadReplies(c, since), loadApprovals(c),
    loadIntel(c, date), loadPipeline(c, date), loadApproaches(c, date),
  ]);
  return {
    kind: "daily", date, tz: c.tz, now: now.toISOString(), mode: plan?.mode ?? "workday", sources,
    targets: plan?.targets ?? [], displaced: plan?.displaced ?? [], capacity: plan?.capacity ?? null, planGeneratedAt: plan?.generatedAt ?? null,
    agenda: plan?.agenda ?? null,
    tasks, meetings, radar: radar.items, replies, approvals, intel, pipeline,
    approachesThisMonth: approaches.thisMonth, cohortTarget: settings.cohortTarget, workdays: settings.workdays, staleTaskAfterDays: settings.staleTaskAfterDays,
  };
}

/** Hash of the deterministic content, ignoring timestamps that change on every run. */
export function contentHash(c: BriefContent): string {
  const rest: Partial<BriefContent> = { ...c };
  delete rest.fallbackText;
  delete rest.planGeneratedAt;
  return stableHash({ ...rest, sources: c.sources.map((s) => ({ k: s.key, st: s.state, ls: s.lastSuccessAt })) });
}

export async function latestBrief(db: Db, workspaceId: string, userId: string, date: string, kind: BriefKind = "daily", subjectKey = ""): Promise<StoredBrief | null> {
  const { data } = await db.from("brief").select(BRIEF_COLS).eq("workspace_id", workspaceId).eq("user_id", userId)
    .eq("brief_date", date).eq("kind", kind).eq("subject_key", subjectKey).is("archived_at", null)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  return (data as StoredBrief) ?? null;
}

/** Persist a brief version unless the latest version has identical deterministic content (then return it). */
export async function saveBriefVersion(db: Db, c: Pick<LoadCtx, "workspaceId" | "userId">, opts: {
  date: string; kind: BriefKind; subjectKey?: string; content: Record<string, unknown> & { content_hash: string }; synthesisStatus: "ok" | "fallback_no_ai" | "partial"; sourceHealth: Record<string, unknown>;
}): Promise<{ brief: StoredBrief; created: boolean }> {
  const subjectKey = opts.subjectKey ?? "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = await latestBrief(db, c.workspaceId, c.userId, opts.date, opts.kind, subjectKey);
    if (prev && prev.content?.content_hash === opts.content.content_hash && (prev.synthesis_status === opts.synthesisStatus || opts.synthesisStatus === "fallback_no_ai")) {
      return { brief: prev, created: false };
    }
    const { data, error } = await db.from("brief").insert({
      workspace_id: c.workspaceId, user_id: c.userId, owner_user_id: c.userId, brief_date: opts.date, kind: opts.kind, subject_key: subjectKey,
      version: (prev?.version ?? 0) + 1, content: opts.content, synthesis_status: opts.synthesisStatus, source_health: opts.sourceHealth,
    }).select(BRIEF_COLS).single();
    if (!error) return { brief: data as StoredBrief, created: true };
    if ((error as { code?: string }).code !== "23505") throw error; // concurrent writer took this version: retry
  }
  throw new Error("brief version conflict");
}

export interface GenerateOpts { date: string; now?: Date; caller?: StructuredCaller; generatedBy?: string; mode?: AiMode }

/** Generate (or reuse) today's daily brief for the user in `c`. */
export async function generateDailyBrief(c: LoadCtx, settings: BriefSettings, opts: GenerateOpts): Promise<{ brief: StoredBrief; created: boolean }> {
  const now = opts.now ?? new Date();
  const inputs = await gatherBriefInputs(c, settings, opts.date, now);
  const content = buildBrief(inputs);
  const mode = opts.mode ?? await getAiMode(c.db, c.workspaceId, "brief.synthesis");
  const synth = await synthesise(content, c.workspaceId, opts.caller ?? gatewayCaller, mode);
  const hash = contentHash(content);
  const sourceHealth = Object.fromEntries(content.sources.map((s) => [s.key, { state: s.state, last_success_at: s.lastSuccessAt, error: s.error, stale: s.state !== "ok" }]));
  return saveBriefVersion(c.db, c, {
    date: opts.date, kind: "daily",
    content: { ...content, synthesis: synth, content_hash: hash, generated_by: opts.generatedBy ?? "user" },
    synthesisStatus: synth.status, sourceHealth,
  });
}

/** Mark delivered and queue exactly one private "brief_ready" notification per user/date. Admin client (jobs) only. */
export async function deliverBrief(admin: Db, workspaceId: string, brief: StoredBrief, now = new Date()): Promise<void> {
  if (!brief.delivered_at) {
    const { error } = await admin.from("brief").update({ delivered_at: now.toISOString() }).eq("workspace_id", workspaceId).eq("id", brief.id).is("delivered_at", null);
    if (error) throw error;
  }
  // The orchestrator's daily plan (which extends this brief) already notified the user for this day → no second 08:00 ping.
  const { data: planNote } = await admin.from("outbox").select("id").eq("workspace_id", workspaceId).eq("dedupe_key", `orch:daily_plan:${brief.user_id}:${brief.brief_date}`).limit(1);
  if (planNote?.length) return;
  await notify(admin, workspaceId, brief.user_id, "brief_ready", `brief_ready:${brief.user_id}:${brief.brief_date}`, {
    brief_id: brief.id, date: brief.brief_date, version: brief.version, synthesis_status: brief.synthesis_status,
    stale_sections: brief.content?.staleSections ?? [], href: "/today",
  });
}

export async function deliveredBrief(db: Db, workspaceId: string, userId: string, date: string): Promise<StoredBrief | null> {
  const { data } = await db.from("brief").select(BRIEF_COLS).eq("workspace_id", workspaceId).eq("user_id", userId).eq("brief_date", date)
    .eq("kind", "daily").not("delivered_at", "is", null).is("archived_at", null).order("version", { ascending: false }).limit(1).maybeSingle();
  return (data as StoredBrief) ?? null;
}

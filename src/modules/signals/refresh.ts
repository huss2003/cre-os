/**
 * Refresh system (spec §15) on the existing job queue — no new infrastructure, no paid services.
 *  - Tiers: watchlist critical = weekly, active = monthly, universe = quarterly (watchlist.refresh_cadence_days overrides).
 *  - Bounded active universe: at most `universeCap` companies (default 1,200, configurable) — never the whole database.
 *  - Lease events: handled by the daily `signals.scan` with per-type windows (rules.leaseWindowDays).
 *  - Event-triggered: `triggerEventRefresh` (e.g. a new claim / capture) — one job per company per day (dedupe key).
 *  - researched_at (watchlist.last_researched_at) is recorded even when nothing new is found.
 *  - Duplicate-job prevention: queue dedupe keys + unique `source_sync_run.dedupe_key`.
 *  - Failed-job visibility: `refreshStatus` (sync runs, failed source items, failed jobs for admins).
 */
import type { Db } from "@/lib/supabase/server";
import { localDate } from "@/lib/util/time";
import { settings, scanClaims, scanWorkspace, type OrgContext } from "./service";
import { useSource, markSourceResult, SourceAccessError } from "./sources";
import { SignalError } from "./service";

type Row = Record<string, any>;
export const TIER_CADENCE_DAYS: Record<string, number> = { critical: 7, active: 30, universe: 90 };
export const TIER_LABEL: Record<string, string> = { critical: "High-priority named accounts (weekly)", active: "Medium-priority accounts (monthly)", universe: "Watchlist accounts (quarterly)" };
export const DEFAULT_UNIVERSE_CAP = 1200;

export interface WatchRow { org_id: string; tier: string; next_due_at: string; last_researched_at: string | null; active: boolean }
/** Pure: the bounded universe (tier order, then oldest research first) and which of it is due now. */
export function selectDue(rows: WatchRow[], cap: number, now: Date): { universe: WatchRow[]; due: WatchRow[] } {
  const rank: Record<string, number> = { critical: 0, active: 1, universe: 2 };
  const universe = rows.filter((r) => r.active).sort((a, b) => (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3) || String(a.last_researched_at ?? "").localeCompare(String(b.last_researched_at ?? ""))).slice(0, Math.max(0, cap));
  return { universe, due: universe.filter((r) => Date.parse(r.next_due_at) <= now.getTime()) };
}

async function openRun(db: Db, ws: string, registryId: string | null, trigger: string, dedupeKey: string | null, orgId: string | null, userId?: string) {
  const { data, error } = await db.from("source_sync_run").insert({ workspace_id: ws, registry_id: registryId, adapter: "database", trigger, status: "running", dedupe_key: dedupeKey, org_id: orgId, owner_user_id: userId }).select("id").single();
  if (error) { if (/duplicate key/.test(error.message)) return null; throw new SignalError(error.message); }
  return data.id as string;
}
async function closeRun(db: Db, ws: string, id: string, patch: Row) {
  await db.from("source_sync_run").update({ ...patch, finished_at: new Date().toISOString() }).eq("workspace_id", ws).eq("id", id);
}

/** Refresh one company from Module 1 records (claims + lease context). Records researched_at even with nothing new. */
export async function refreshCompany(db: Db, ws: string, orgId: string, opts: { trigger?: "manual" | "scheduled" | "event" | "retry"; dedupeKey?: string | null; actorUserId?: string } = {}) {
  const today = localDate();
  let reg: Row;
  try { reg = await useSource(db, ws, "database", today); }
  catch (e) { if (e instanceof SourceAccessError) return { skipped: e.message, created: 0 }; throw e; }
  const runId = await openRun(db, ws, reg.id, opts.trigger ?? "manual", opts.dedupeKey ?? null, orgId, opts.actorUserId);
  if (!runId) return { skipped: "Already refreshed in this slot (duplicate job prevented).", created: 0 };
  try {
    const s = await settings(db, ws);
    const created = await scanClaims(db, ws, s, { today, orgIds: [orgId] }, new Map<string, OrgContext>());
    const { data: w } = await db.from("watchlist").select("id, tier, refresh_cadence_days").eq("workspace_id", ws).eq("org_id", orgId).maybeSingle();
    if (w) {
      const days = w.refresh_cadence_days ?? TIER_CADENCE_DAYS[w.tier] ?? 90;
      await db.from("watchlist").update({ last_researched_at: new Date().toISOString(), next_due_at: new Date(Date.now() + days * 86_400_000).toISOString() }).eq("workspace_id", ws).eq("id", w.id);
    }
    await closeRun(db, ws, runId, { status: "done", items_seen: 1, items_new: created });
    await markSourceResult(db, ws, reg.id, true);
    return { runId, created };
  } catch (e) {
    await closeRun(db, ws, runId, { status: "failed", items_failed: 1, error: String((e as Error).message).slice(0, 500) });
    await markSourceResult(db, ws, reg.id, false, (e as Error).message);
    throw e;
  }
}

/** Manual refresh: one company, or the whole workspace scan (lease windows + claims + commercial). */
export async function refreshNow(db: Db, ws: string, opts: { orgId?: string; actorUserId?: string } = {}) {
  if (opts.orgId) return refreshCompany(db, ws, opts.orgId, { trigger: "manual", actorUserId: opts.actorUserId });
  const today = localDate();
  const reg = await useSource(db, ws, "database", today).catch((e) => { throw new SignalError(e.message); });
  const runId = await openRun(db, ws, reg.id, "manual", null, null, opts.actorUserId);
  try {
    const r = await scanWorkspace(db, ws, { today });
    await closeRun(db, ws, runId!, { status: "done", items_new: r.lease + r.claims + (r.commercial ?? 0) });
    await markSourceResult(db, ws, reg.id, true);
    return { runId, ...r };
  } catch (e) {
    await closeRun(db, ws, runId!, { status: "failed", error: String((e as Error).message).slice(0, 500) });
    await markSourceResult(db, ws, reg.id, false, (e as Error).message);
    throw e;
  }
}

/** Due companies inside the bounded universe (used by the daily planner). */
export async function dueCompanies(db: Db, ws: string, now = new Date()) {
  const s = await settings(db, ws);
  const { data } = await db.from("watchlist").select("org_id, tier, next_due_at, last_researched_at, active").eq("workspace_id", ws).eq("active", true).is("archived_at", null).limit(10_000);
  return { cap: s.universeCap, ...selectDue((data ?? []) as WatchRow[], s.universeCap, now) };
}

export async function setUniverseCap(db: Db, ws: string, cap: number) {
  if (!Number.isFinite(cap) || cap < 50 || cap > 8000) throw new SignalError("Universe size must be between 50 and 8,000 companies.");
  const { data: cur } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", "signals").maybeSingle();
  const { error } = await db.from("workspace_setting").upsert({ workspace_id: ws, key: "signals", value: { ...((cur?.value as object) ?? {}), universeCap: Math.round(cap) }, updated_at: new Date().toISOString() });
  if (error) throw new SignalError(error.message);
  return Math.round(cap);
}

export async function refreshStatus(db: Db, ws: string) {
  const [runs, failedItems, jobs, due] = await Promise.all([
    db.from("source_sync_run").select("id, adapter, trigger, status, org_id, items_seen, items_new, items_failed, error, started_at, finished_at").eq("workspace_id", ws).order("started_at", { ascending: false }).limit(30).then((r) => r.data ?? []),
    db.from("signal_source_item").select("id, adapter, title, source_name, error, attempts, updated_at").eq("workspace_id", ws).eq("status", "failed").order("updated_at", { ascending: false }).limit(50).then((r) => r.data ?? []),
    // job rows are visible to workspace admins only (RLS); others get an empty list.
    db.from("job").select("id, job_type, state, attempts, last_error, updated_at").eq("workspace_id", ws).like("job_type", "signals.%").in("state", ["failed", "dead"]).order("updated_at", { ascending: false }).limit(30).then((r) => r.data ?? [], () => []),
    dueCompanies(db, ws),
  ]);
  return { syncRuns: runs, failedItems, failedJobs: jobs, universe: { cap: due.cap, size: due.universe.length }, due: due.due.length, tiers: TIER_LABEL };
}

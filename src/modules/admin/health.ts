/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICING, PRICING_VERSION } from "@/lib/ai/pricing";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { heartbeatState, SUPERVISOR } from "./supervisor";
import { jobsPauseState } from "./killswitch";

type Client = SupabaseClient<any, any, any>;
type Row = Record<string, any>;

/** Backup objectives (spec §14): RPO 24h, RTO one working day, monthly restore sample, quarterly full drill. */
export const BACKUP_POLICY = { rpoHours: 24, restoreSampleDays: 31, fullDrillDays: 92 };

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"] as const;

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface SpendSummary {
  monthStart: string;
  spentUsd: number;
  spentInr: number;
  budgetInr: number;
  pctOfBudget: number | null;
  calls: number;
  failedCalls: number;
  mockedCalls: number;
  byWorkflow: { workflow: string; usd: number; calls: number }[];
  pricingVersions: string[];
  currentPricingVersion: string;
  fxInrPerUsd: number;
}

export async function spendSummary(db: Client, workspaceId: string, budgetInr: number, now = new Date()): Promise<SpendSummary> {
  const start = monthStart(now);
  // One grouped SQL aggregate (was: page through every model_usage row of the month).
  const { data, error } = await db.schema("mudar_app").rpc("model_spend_since", { p_workspace: workspaceId, p_since: start });
  if (error) throw error;
  const groups = ((data ?? []) as { workflow: string; usd: number | string; calls: number | string; failed: number | string; mocked: number | string; pricing_versions: string[] | null }[]);
  const usd = groups.reduce((a, g) => a + (Number(g.usd) || 0), 0);
  const inr = usd * PRICING.fxInrPerUsd;
  return {
    monthStart: start, spentUsd: usd, spentInr: inr, budgetInr,
    pctOfBudget: budgetInr > 0 ? (inr / budgetInr) * 100 : null,
    calls: groups.reduce((a, g) => a + Number(g.calls), 0),
    failedCalls: groups.reduce((a, g) => a + Number(g.failed), 0),
    mockedCalls: groups.reduce((a, g) => a + Number(g.mocked), 0),
    byWorkflow: groups.map((g) => ({ workflow: g.workflow, usd: Number(g.usd) || 0, calls: Number(g.calls) })).sort((a, b) => b.usd - a.usd),
    pricingVersions: [...new Set(groups.flatMap((g) => g.pricing_versions ?? []))],
    currentPricingVersion: PRICING_VERSION,
    fxInrPerUsd: PRICING.fxInrPerUsd,
  };
}

export function backupStatus(runs: Row[], now = new Date()) {
  const lastOk = (kind: string) => runs.find((r) => r.kind === kind && (r.status === "succeeded" || r.status === "warning"));
  const export_ = lastOk("logical_export");
  const sample = lastOk("restore_sample");
  const drill = lastOk("restore_drill");
  const ageH = (r?: Row) => (r ? (now.getTime() - Date.parse(r.finished_at ?? r.started_at)) / 3_600_000 : null);
  const exportAge = ageH(export_);
  const sampleAge = ageH(sample);
  const drillAge = ageH(drill);
  return {
    lastExport: export_ ?? null,
    lastRestoreSample: sample ?? null,
    lastFullDrill: drill ?? null,
    lastFailure: runs.find((r) => r.status === "failed") ?? null,
    rpoMet: exportAge !== null && exportAge <= BACKUP_POLICY.rpoHours,
    exportAgeHours: exportAge,
    restoreSampleDue: sampleAge === null || sampleAge > BACKUP_POLICY.restoreSampleDays * 24,
    fullDrillDue: drillAge === null || drillAge > BACKUP_POLICY.fullDrillDays * 24,
  };
}

/** GET /v1/admin/health — jobs, connectors, spend, imports, backups. Caller must be admin (RLS on job/model_usage/backup_run). */
export async function getHealth(db: Client, workspaceId: string, now = new Date()) {
  // Workspace row runs alongside the other queries; only the spend summary waits for its budget.
  const wsP = Promise.resolve(db.from("workspace").select("id, name, status, ai_paused, monthly_ai_budget_inr, timezone").eq("id", workspaceId).single())
    .then((r: { data: Row | null }) => r.data);

  // One grouped count (was one count query per job state).
  const countStates = async () => {
    const { data, error } = await db.schema("mudar_app").rpc("job_state_counts", { p_workspace: workspaceId });
    if (error) throw error;
    const by = new Map(((data ?? []) as { state: string; n: number | string }[]).map((r) => [r.state, Number(r.n)]));
    return JOB_STATES.map((st) => [st, by.get(st) ?? 0] as const);
  };
  const [stateCounts, failures, retrying, accounts, cursors, runs, spend, imports, latency, slowest, heartbeat, alerts, pause] = await Promise.all([
    countStates(),
    db.from("job").select("id, job_type, state, attempts, max_attempts, last_error, updated_at, due_at").eq("workspace_id", workspaceId)
      .in("state", ["failed", "dead"]).order("updated_at", { ascending: false }).limit(25),
    db.from("job").select("id, job_type, state, attempts, max_attempts, last_error, updated_at, due_at").eq("workspace_id", workspaceId)
      .eq("state", "queued").gt("attempts", 0).order("updated_at", { ascending: false }).limit(25),
    db.from("connector_account").select("id, user_id, provider, account_email, status, last_error, token_expires_at, updated_at").eq("workspace_id", workspaceId),
    db.from("connector_cursor").select("connector_account_id, resource, last_success_at, last_attempt_at, last_error").eq("workspace_id", workspaceId),
    db.from("backup_run").select("*").eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(50),
    wsP.then((w) => spendSummary(db, workspaceId, Number(w?.monthly_ai_budget_inr ?? 0), now)),
    importsSummary(db, workspaceId),
    latencySummary(db, workspaceId, now),
    db.from("job").select("id, job_type, state, attempts, duration_ms, started_at, finished_at").eq("workspace_id", workspaceId)
      .gte("finished_at", new Date(now.getTime() - 86_400_000).toISOString()).not("duration_ms", "is", null)
      .order("duration_ms", { ascending: false }).limit(10),
    schedulerHeartbeat(db, now),
    db.from("supervisor_alert").select("id, kind, subject, severity, title, action_href, opened_at, last_seen_at, resolved_at, acknowledged_at, notified_at")
      .eq("workspace_id", workspaceId).or(`resolved_at.is.null,opened_at.gte.${new Date(now.getTime() - 7 * 86_400_000).toISOString()}`)
      .order("opened_at", { ascending: false }).limit(100),
    jobsPauseState(db, workspaceId).then((p) => ({ ...p, checked: true }), () => ({ workspacePaused: false, globalPaused: false, pausedAt: null, reason: null, globalPausedAt: null, checked: false })),
  ]);
  const ws = await wsP;
  if (!ws) throw badRequest("workspace not visible");

  const staleAfterH = 26;
  const connectors = ((accounts.data ?? []) as Row[]).map((a): Row & { resources: Row[]; healthy: boolean } => {
    const cs = ((cursors.data ?? []) as Row[]).filter((c) => c.connector_account_id === a.id);
    return {
      ...a,
      // connector_account.status is connected | mock | expired | revoked | error
      healthy: a.status === "connected" || a.status === "mock",
      resources: cs.map((c): Row => ({
        ...c,
        stale: !c.last_success_at || (now.getTime() - Date.parse(c.last_success_at)) / 3_600_000 > staleAfterH,
        failing: !!c.last_error && (!c.last_success_at || (c.last_attempt_at && c.last_attempt_at > c.last_success_at)),
      })),
    };
  });

  return {
    generatedAt: now.toISOString(),
    workspace: { id: ws.id, name: ws.name, status: ws.status, aiPaused: ws.ai_paused, timezone: ws.timezone },
    jobs: {
      counts: Object.fromEntries(stateCounts) as Record<(typeof JOB_STATES)[number], number>,
      recentFailures: (failures.data ?? []) as Row[],
      retrying: (retrying.data ?? []) as Row[],
      latency,
      slowest: (slowest.data ?? []) as Row[],
      paused: pause,
    },
    scheduler: heartbeat,
    alerts: {
      checked: !alerts.error,
      open: ((alerts.data ?? []) as Row[]).filter((a) => !a.resolved_at),
      recent: ((alerts.data ?? []) as Row[]).filter((a) => !!a.resolved_at).slice(0, 20),
    },
    connectors,
    spend: { ...spend, budgetExceeded: spend.budgetInr > 0 && spend.spentInr >= spend.budgetInr },
    imports,
    backups: { ...backupStatus((runs.data ?? []) as Row[], now), recent: ((runs.data ?? []) as Row[]).slice(0, 10) },
  };
}

export interface LatencyRow {
  jobType: string; runs24h: number; failed24h: number; p50Ms: number | null; p95Ms: number | null; maxMs: number | null;
  runsBaseline: number; p95BaselineMs: number | null; drift: boolean;
}

/** Drift = p95 over the last 24 h is > 2x the previous 7 days' p95 (and > 1 s slower), with >= 5 baseline runs. */
export function latencyDrift(p95: number | null, baseline: number | null, baselineRuns: number) {
  return p95 !== null && baseline !== null && baselineRuns >= 5 && p95 > 2 * baseline && p95 - baseline > 1000;
}

/** p50/p95 per job type (mudar_app.job_latency_stats, SECURITY INVOKER => job RLS: admins only). */
export async function latencySummary(db: Client, workspaceId: string, now = new Date()) {
  const { data, error } = await db.schema("mudar_app").rpc("job_latency_stats", { p_workspace: workspaceId, p_now: now.toISOString() });
  if (error) return { checked: false, error: error.message, rows: [] as LatencyRow[] };
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const rows = ((data ?? []) as Row[]).map((r): LatencyRow => {
    const p95 = num(r.p95_ms), base = num(r.p95_baseline_ms);
    return { jobType: r.job_type, runs24h: r.runs_24h, failed24h: r.failed_24h, p50Ms: num(r.p50_ms), p95Ms: p95, maxMs: num(r.max_ms),
      runsBaseline: r.runs_baseline, p95BaselineMs: base, drift: latencyDrift(p95, base, r.runs_baseline) };
  });
  return { checked: true, error: null as string | null, rows };
}

/** Scheduler heartbeat. `checked: false` when the heartbeat could not be read — never reported as healthy. */
export async function schedulerHeartbeat(db: Client, now = new Date()) {
  const { data, error } = await db.schema("mudar_app").rpc("scheduler_heartbeat");
  if (error || !data) return { checked: false, error: error?.message ?? "no data", ...heartbeatState(null, now), staleAfterMinutes: SUPERVISOR.heartbeatStaleMinutes, ticks24h: null, ticksWithErrors24h: null, maxGapMinutes24h: null, p95TickMs24h: null };
  const d = data as Row;
  return {
    checked: true, error: null as string | null, ...heartbeatState(d.last_tick_at, now), staleAfterMinutes: SUPERVISOR.heartbeatStaleMinutes,
    ticks24h: Number(d.ticks_24h ?? 0), ticksWithErrors24h: Number(d.ticks_with_errors_24h ?? 0),
    maxGapMinutes24h: d.max_gap_minutes_24h === null ? null : Number(d.max_gap_minutes_24h),
    p95TickMs24h: d.p95_tick_ms_24h === null ? null : Number(d.p95_tick_ms_24h),
  };
}

/** Acknowledge an alert (stops further notifications; it stays listed until the condition clears). Admin RLS. */
export async function acknowledgeAlert(db: Client, workspaceId: string, alertId: string, userId: string) {
  const { data, error } = await db.from("supervisor_alert").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
    .eq("workspace_id", workspaceId).eq("id", alertId).select("id");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw notFound("alert");
}

/** Import batches are owned by the imports module; read defensively (table name may differ or be absent). */
async function importsSummary(db: Client, workspaceId: string) {
  for (const table of ["import_batch", "import_run"]) {
    const { data, error } = await db.from(table).select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(10);
    if (!error) {
      const rows = (data ?? []) as Row[];
      const byStatus: Record<string, number> = {};
      for (const r of rows) byStatus[String(r.status ?? r.state ?? "unknown")] = (byStatus[String(r.status ?? r.state ?? "unknown")] ?? 0) + 1;
      return { available: true, table, recent: rows, byStatus };
    }
  }
  const { data: jobs } = await db.from("job").select("id, job_type, state, updated_at, last_error").eq("workspace_id", workspaceId)
    .like("job_type", "imports.%").order("updated_at", { ascending: false }).limit(10);
  return { available: false, table: null, recent: (jobs ?? []) as Row[], byStatus: {} as Record<string, number> };
}

export async function retryJob(db: Client, jobId: string) {
  const { error } = await db.schema("mudar_app").rpc("retry_job", { p_job: jobId });
  if (!error) return;
  if (error.code === "42501") throw forbidden("admin role required to retry jobs");
  if (error.code === "P0002") throw notFound("job");
  if (error.code === "23505") throw conflict(error.message);
  throw badRequest(error.message);
}

export interface AuditFilter { entityType?: string; action?: string; actorKind?: string; from?: string; to?: string; entityId?: string; page?: number }

export async function listAudit(db: Client, workspaceId: string, f: AuditFilter = {}) {
  const pageSize = 50;
  const page = Math.max(0, f.page ?? 0);
  let q = db.from("audit_event").select("id, occurred_at, actor_user_id, actor_kind, action, entity_type, entity_id, before, after, request_id, job_id, model, change_proposal_id, classification", { count: "exact" })
    .eq("workspace_id", workspaceId);
  if (f.entityType) q = q.eq("entity_type", f.entityType);
  if (f.action) q = q.eq("action", f.action);
  if (f.actorKind) q = q.eq("actor_kind", f.actorKind);
  if (f.entityId && /^[0-9a-f-]{36}$/i.test(f.entityId)) q = q.eq("entity_id", f.entityId);
  if (f.from) q = q.gte("occurred_at", `${f.from}T00:00:00+05:30`);
  if (f.to) q = q.lte("occurred_at", `${f.to}T23:59:59.999+05:30`);
  const { data, count, error } = await q.order("occurred_at", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw badRequest(error.message);
  return { rows: (data ?? []) as Row[], total: count ?? 0, page, pageSize };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRICING, PRICING_VERSION } from "@/lib/ai/pricing";
import { badRequest, conflict, forbidden, notFound } from "./errors";

type Client = SupabaseClient<any, "public", any>;
type Row = Record<string, any>;

/** Backup objectives (spec §14): RPO 24h, RTO one working day, monthly restore sample, quarterly full drill. */
export const BACKUP_POLICY = { rpoHours: 24, restoreSampleDays: 31, fullDrillDays: 92 };

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"] as const;

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Page through a PostgREST select (max_rows = 1000). */
async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>, cap = 20000) {
  const out: Row[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
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
  const rows = await fetchAll((f, t) => db.from("model_usage").select("workflow, model, estimated_usd, pricing_version, ok")
    .eq("workspace_id", workspaceId).gte("occurred_at", start).order("id").range(f, t) as never);
  const by = new Map<string, { usd: number; calls: number }>();
  let usd = 0;
  for (const r of rows) {
    const v = Number(r.estimated_usd) || 0;
    usd += v;
    const cur = by.get(r.workflow) ?? { usd: 0, calls: 0 };
    cur.usd += v; cur.calls += 1;
    by.set(r.workflow, cur);
  }
  const inr = usd * PRICING.fxInrPerUsd;
  return {
    monthStart: start, spentUsd: usd, spentInr: inr, budgetInr,
    pctOfBudget: budgetInr > 0 ? (inr / budgetInr) * 100 : null,
    calls: rows.length,
    failedCalls: rows.filter((r) => r.ok === false).length,
    mockedCalls: rows.filter((r) => String(r.model).startsWith("mock:")).length,
    byWorkflow: [...by.entries()].map(([workflow, v]) => ({ workflow, ...v })).sort((a, b) => b.usd - a.usd),
    pricingVersions: [...new Set(rows.map((r) => r.pricing_version as string))],
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
  const { data: ws } = await db.from("workspace").select("id, name, status, ai_paused, monthly_ai_budget_inr, timezone").eq("id", workspaceId).single();
  if (!ws) throw badRequest("workspace not visible");

  const countState = async (state: string) => {
    const { count } = await db.from("job").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("state", state);
    return [state, count ?? 0] as const;
  };
  const [stateCounts, failures, retrying, accounts, cursors, runs, spend, imports] = await Promise.all([
    Promise.all(JOB_STATES.map(countState)),
    db.from("job").select("id, job_type, state, attempts, max_attempts, last_error, updated_at, due_at").eq("workspace_id", workspaceId)
      .in("state", ["failed", "dead"]).order("updated_at", { ascending: false }).limit(25),
    db.from("job").select("id, job_type, state, attempts, max_attempts, last_error, updated_at, due_at").eq("workspace_id", workspaceId)
      .eq("state", "queued").gt("attempts", 0).order("updated_at", { ascending: false }).limit(25),
    db.from("connector_account").select("id, user_id, provider, account_email, status, last_error, token_expires_at, updated_at").eq("workspace_id", workspaceId),
    db.from("connector_cursor").select("connector_account_id, resource, last_success_at, last_attempt_at, last_error").eq("workspace_id", workspaceId),
    db.from("backup_run").select("*").eq("workspace_id", workspaceId).order("started_at", { ascending: false }).limit(50),
    spendSummary(db, workspaceId, Number(ws.monthly_ai_budget_inr ?? 0), now),
    importsSummary(db, workspaceId),
  ]);

  const staleAfterH = 26;
  const connectors = ((accounts.data ?? []) as Row[]).map((a): Row & { resources: Row[] } => {
    const cs = ((cursors.data ?? []) as Row[]).filter((c) => c.connector_account_id === a.id);
    return {
      ...a,
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
    },
    connectors,
    spend: { ...spend, budgetExceeded: spend.budgetInr > 0 && spend.spentInr >= spend.budgetInr },
    imports,
    backups: { ...backupStatus((runs.data ?? []) as Row[], now), recent: ((runs.data ?? []) as Row[]).slice(0, 10) },
  };
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
  const { error } = await db.schema("app").rpc("retry_job", { p_job: jobId });
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

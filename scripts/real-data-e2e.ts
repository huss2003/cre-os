/**
 * Real-data end-to-end run (local only). Imports the tenant's six real Pune workbooks into a SEPARATE workspace
 * "Pune real-data test" (slug pune-real-test), proves re-import idempotency and drives the downstream workflows.
 * Never touches WS1/WS2. Source files are read-only inputs (untrusted evidence).
 *
 *   npx tsx --conditions=react-server --env-file=.env.local scripts/real-data-e2e.ts [--fresh] [--phase=all|import|reimport|workflows] [--data=/tmp/pune-data]
 *   (--conditions=react-server lets the server-only service modules load outside Next.js)
 *
 * Re-runnable: the workspace has a fixed id; the import pipeline is idempotent (same hash = no-op, deterministic ids).
 * Results are written as JSON under <data>/out/.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client as Pg } from "pg";

type Db = SupabaseClient<any, any, any>;

export const WS_ID = "5e000000-0000-4000-8000-00000000e2e1";
export const WS_SLUG = "pune-real-test";
const OWNER = "00000000-0000-4000-8000-000000000001";
const PROTECTED = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];

const args = process.argv.slice(2);
const opt = (n: string, d: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const PHASE = opt("phase", "all");
const DATA = opt("data", "/tmp/pune-data");
const OUT = path.join(DATA, "out");

function assertLocal() {
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error(`refusing to run against non-local Supabase ${host}`);
  if (PROTECTED.includes(WS_ID)) throw new Error("workspace id collides with a protected tenant");
}

const admin = (): Db => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false }, db: { schema: "mudar" } }) as Db;
async function ownerClient(): Promise<Db> {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, db: { schema: "mudar" } });
  const { error } = await c.auth.signInWithPassword({ email: "owner@cre-os.local", password: "password123" });
  if (error) throw error;
  return c as Db;
}

const save = (name: string, v: unknown) => writeFileSync(path.join(OUT, name), JSON.stringify(v, null, 2));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------------------------ setup */

/** --fresh: remove this test workspace (cascade) and its stored originals/documents, then rebuild. Never touches other workspaces. */
async function wipe() {
  const a = admin();
  if (PROTECTED.includes(WS_ID)) throw new Error("refusing to wipe a protected workspace");
  const bucket = a.storage.from("mudar-workspace-files");
  const walk = async (prefix: string): Promise<string[]> => {
    const { data } = await bucket.list(prefix, { limit: 1000 });
    const out: string[] = [];
    for (const o of data ?? []) {
      const p = `${prefix}/${o.name}`;
      if (o.id) out.push(p);
      else out.push(...(await walk(p)));
    }
    return out;
  };
  const files = await walk(WS_ID);
  for (let i = 0; i < files.length; i += 100) await bucket.remove(files.slice(i, i + 100));
  // cascade delete is too slow for the PostgREST statement timeout: run it directly (local DB only, this workspace only)
  const pg = new Pg({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    await pg.query("set statement_timeout = 0");
    await pg.query("delete from mudar.workspace where id = $1", [WS_ID]);
  } finally {
    await pg.end();
  }
  log("wiped workspace", WS_ID, "and", files.length, "stored files");
}

async function setup() {
  const a = admin();
  const { data: bySlug } = await a.from("workspace").select("id").eq("slug", WS_SLUG).maybeSingle();
  if (bySlug && bySlug.id !== WS_ID) throw new Error(`slug ${WS_SLUG} already used by ${bySlug.id}`);
  const w = await a.from("workspace").upsert({ id: WS_ID, name: "Pune real-data test", slug: WS_SLUG, timezone: "Asia/Kolkata", currency: "INR", status: "active" }, { onConflict: "id" });
  if (w.error) throw w.error;
  const m = await a.from("membership").upsert({
    workspace_id: WS_ID, user_id: OWNER, role: "owner", see_all_accounts: true, display_name: "Owner (real-data test)",
    allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"],
  }, { onConflict: "workspace_id,user_id", ignoreDuplicates: true });
  if (m.error) throw m.error;
  // default "Manual upload" source: created approved by the definer RPC; make sure it is approved (owner = admin)
  const db = await ownerClient();
  const { data: srcId, error } = await db.schema("mudar_app").rpc("imports_default_source", { p_ws: WS_ID });
  if (error) throw error;
  const { data: src } = await db.from("import_source").select("id, name, approved").eq("id", srcId).single();
  if (!src!.approved) {
    const u = await db.from("import_source").update({ approved: true }).eq("id", srcId);
    if (u.error) throw u.error;
  }
  log("workspace ready", WS_ID, "source", src!.name, "approved");
  return db;
}

/* ------------------------------------------------------------------ counts (idempotency proof) */

async function tableCounts(): Promise<Record<string, number>> {
  const pg = new Pg({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    const { rows } = await pg.query(`select table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
      where c.table_schema='mudar' and c.column_name='workspace_id' and t.table_type='BASE TABLE' order by 1`);
    const out: Record<string, number> = {};
    for (const r of rows) {
      const { rows: n } = await pg.query(`select count(*)::int n from mudar."${r.table_name}" where workspace_id=$1`, [WS_ID]);
      if (n[0].n) out[r.table_name] = n[0].n;
    }
    const { rows: so } = await pg.query(`select count(*)::int n from storage.objects where bucket_id='mudar-workspace-files' and name like $1`, [`${WS_ID}/%`]);
    out["storage.objects"] = so[0].n;
    return out;
  } finally {
    await pg.end();
  }
}

function diffCounts(a: Record<string, number>, b: Record<string, number>) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => (a[k] ?? 0) !== (b[k] ?? 0)).map((k) => ({ table: k, before: a[k] ?? 0, after: b[k] ?? 0 }));
}

/* ------------------------------------------------------------------ imports */

const FILES = () => readdirSync(DATA).filter((f) => f.endsWith(".xlsx")).sort();

async function batchReport(db: Db, batchId: string) {
  const { data: b } = await db.from("import_batch").select("id, file_name, status, adapter, counts, sheets, error").eq("workspace_id", WS_ID).eq("id", batchId).single();
  const ex = await all(db, "import_exception", "kind, severity, status, sheet", { batch_id: batchId });
  const byReason: Record<string, number> = {};
  for (const e of ex) byReason[`${e.kind}/${e.severity}/${e.status}`] = (byReason[`${e.kind}/${e.severity}/${e.status}`] ?? 0) + 1;
  const staged = await all(db, "staged_row", "sheet, status, reason, flags", { batch_id: batchId });
  const perSheet: Record<string, Record<string, number>> = {};
  const reasons: Record<string, number> = {};
  const flags: Record<string, number> = {};
  for (const r of staged) {
    perSheet[r.sheet] ??= {};
    perSheet[r.sheet][r.status] = (perSheet[r.sheet][r.status] ?? 0) + 1;
    if (r.reason) reasons[`${r.sheet} | ${r.status} | ${r.reason}`] = (reasons[`${r.sheet} | ${r.status} | ${r.reason}`] ?? 0) + 1;
    for (const f of r.flags ?? []) flags[`${r.sheet} | ${f}`] = (flags[`${r.sheet} | ${f}`] ?? 0) + 1;
  }
  const { count: cands } = await db.from("identity_match_candidate").select("id", { count: "exact", head: true }).eq("workspace_id", WS_ID).eq("batch_id", batchId);
  const { count: conflicts } = await db.from("field_conflict").select("id", { count: "exact", head: true }).eq("workspace_id", WS_ID).eq("batch_id", batchId);
  return {
    file: b!.file_name, status: b!.status, adapter: b!.adapter, error: b!.error,
    sheets: (b!.sheets ?? []).map((s: any) => ({ sheet: s.sheet, status: s.status, adapter: s.adapter, role: s.role, header_row: s.header_row, rows_considered: s.rows_considered, layout_rows: s.layout_rows, mapping_source: s.mapping_source })),
    counts: b!.counts, staged_by_sheet: perSheet, reasons, flags, exceptions_by_reason: byReason,
    identity_candidates: cands ?? 0, field_conflicts_rows: conflicts ?? 0,
  };
}

async function all(db: Db, table: string, cols: string, eq: Record<string, unknown> = {}): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(table).select(cols).eq("workspace_id", WS_ID);
    for (const [k, v] of Object.entries(eq)) q = q.eq(k, v as any);
    const { data, error } = await q.order("id").range(f, f + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function importAll(db: Db) {
  const { registerImport, processBatch, approveMapping } = await import("../src/modules/imports/pipeline");
  const results: any[] = [];
  for (const f of FILES()) {
    const bytes = new Uint8Array(readFileSync(path.join(DATA, f)));
    const t0 = Date.now();
    const reg = await registerImport(db, { workspaceId: WS_ID, userId: OWNER, fileName: f, bytes, options: { as_of: "2026-11-01", classification: "corporate_confidential" } });
    let res: any = { status: "duplicate_noop" };
    if (!reg.duplicate) res = await processBatch(db, { workspaceId: WS_ID, batchId: reg.batchId });
    let positional: any = null;
    // headerless tab: an admin approves the positional suggestion, then the batch is re-processed
    const { data: b } = await db.from("import_batch").select("sheets").eq("id", reg.batchId).single();
    for (const s of (b!.sheets ?? []).filter((x: any) => x.status === "unknown")) {
      const sug = (s.suggestions ?? []).find((x: any) => x.positional) ?? null;
      if (sug && /upcoming/i.test(s.sheet)) {
        await approveMapping(db, WS_ID, OWNER, { batchId: reg.batchId, sheet: s.sheet, adapter: sug.adapter, role: sug.role, columnMap: sug.columnMap, positional: true, headerRow: 0, note: "real-data e2e: approved positional map for headerless Upcoming inventory" });
        const r2 = await processBatch(db, { workspaceId: WS_ID, batchId: reg.batchId, allowFrom: ["completed", "completed_with_exceptions", "needs_mapping", "failed"] });
        positional = { sheet: s.sheet, suggestion: sug, before: res.counts ? { accepted: res.counts.accepted, quarantined: res.counts.quarantined } : null, status_after: r2.status };
        res = r2;
      } else if (s.status === "unknown") {
        positional = { sheet: s.sheet, suggestions: s.suggestions, note: "left unmapped" };
      }
    }
    const rep = await batchReport(db, reg.batchId);
    results.push({ batchId: reg.batchId, duplicate: reg.duplicate, version: reg.version, ms: Date.now() - t0, process_status: res.status, process_error: res.error ?? null, positional, ...rep });
    log("imported", f, res.status, rep.counts ? `considered=${rep.counts.rows_considered} acc=${rep.counts.accepted} q=${rep.counts.quarantined} ex=${rep.counts.excluded} reconciles=${rep.counts.reconciles}` : "");
  }
  return results;
}

async function reimportAll(db: Db) {
  const { registerImport, processBatch } = await import("../src/modules/imports/pipeline");
  const before = await tableCounts();
  const regs: any[] = [];
  for (const f of FILES()) {
    const bytes = new Uint8Array(readFileSync(path.join(DATA, f)));
    const reg = await registerImport(db, { workspaceId: WS_ID, userId: OWNER, fileName: f, bytes, options: { as_of: "2026-11-01" } });
    regs.push({ file: f, duplicate: reg.duplicate, batchId: reg.batchId });
  }
  const afterRegister = await tableCounts();
  // stronger: force a full re-process of every batch (same rows, deterministic ids) — still zero new business rows
  const reproc: any[] = [];
  for (const r of regs) {
    const res = await processBatch(db, { workspaceId: WS_ID, batchId: r.batchId, allowFrom: ["completed", "completed_with_exceptions", "needs_mapping"] });
    reproc.push({ file: r.file, status: res.status, steward: (res.counts as { steward?: unknown } | undefined)?.steward ?? null, masters: res.counts?.masters ?? null, observations: res.counts?.observations ?? null });
  }
  const afterReprocess = await tableCounts();
  return { before, regs, register_diff: diffCounts(before, afterRegister), reproc, reprocess_diff: diffCounts(afterRegister, afterReprocess), afterReprocess };
}

/* ------------------------------------------------------------------ main */

async function main() {
  assertLocal();
  mkdirSync(OUT, { recursive: true });
  if (args.includes("--fresh")) await wipe();
  const db = await setup();
  if (PHASE === "all" || PHASE === "import") {
    const before = await tableCounts();
    const imports = await importAll(db);
    const after = await tableCounts();
    save("imports.json", { before, imports, after });
  }
  if (PHASE === "all" || PHASE === "reimport") save("reimport.json", await reimportAll(db));
  if (PHASE === "all" || PHASE === "workflows") {
    const { runWorkflows } = await import("./real-data-workflows");
    save("workflows.json", await runWorkflows({ db, admin: admin(), ws: WS_ID, owner: OWNER, out: OUT, data: DATA, log }));
  }
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

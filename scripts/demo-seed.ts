/**
 * OPT-IN demo data seeder. Creates/updates ONE separate workspace "Demo — Pune CRE (synthetic)" (slug demo-pune)
 * filled with clearly synthetic data for sales demos and UI testing. It never writes to any other workspace —
 * in particular the real tenant workspace (WS1) stays empty.
 *
 *   npm run demo:seed                       # create / top up (idempotent; existing rows untouched)
 *   npm run demo:seed -- --refresh          # also overwrite existing demo rows (re-anchors relative dates)
 *   npm run demo:seed -- --today=2026-10-31 # pin the anchor date (fully reproducible output)
 *   --allow-remote                          # required when NEXT_PUBLIC_SUPABASE_URL is not localhost
 *
 * See docs/demo-data.md.
 */
import { createClient } from "@supabase/supabase-js";
import {
  buildDemoDataset, DEMO_NAME, DEMO_SLUG, DEMO_WORKSPACE_ID, OWNER_USER_ID, PROTECTED_WORKSPACE_IDS, SEED_VERSION, todayIst,
} from "./demo-data";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (run with --env-file=.env.local)");
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !flag("allow-remote")) {
    throw new Error(`Refusing to seed demo data into non-local Supabase (${host}). Pass --allow-remote if this is intentional.`);
  }
  if (PROTECTED_WORKSPACE_IDS.includes(DEMO_WORKSPACE_ID)) throw new Error("demo workspace id collides with a protected tenant id");

  const today = opt("today") ?? todayIst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`);
  const refresh = flag("refresh");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // ---- preflight
  const { data: owner, error: ownerErr } = await db.auth.admin.getUserById(OWNER_USER_ID);
  if (ownerErr || !owner?.user) throw new Error(`Seeded owner user ${OWNER_USER_ID} not found — apply supabase/seed.sql first`);
  const { data: bySlug, error: slugErr } = await db.from("workspace").select("id").eq("slug", DEMO_SLUG).maybeSingle();
  if (slugErr) throw slugErr;
  if (bySlug && bySlug.id !== DEMO_WORKSPACE_ID) throw new Error(`slug ${DEMO_SLUG} is used by another workspace (${bySlug.id}); aborting`);

  // ---- workspace + membership + marker setting
  const ws = await db.from("workspace").upsert({ id: DEMO_WORKSPACE_ID, name: DEMO_NAME, slug: DEMO_SLUG, timezone: "Asia/Kolkata", currency: "INR", status: "active" }, { onConflict: "id" });
  if (ws.error) throw ws.error;
  const mem = await db.from("membership").upsert(
    {
      id: "de000000-0000-4000-8000-0000000000a1", workspace_id: DEMO_WORKSPACE_ID, user_id: OWNER_USER_ID, role: "owner",
      allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], see_all_accounts: true, display_name: "Owner (demo)",
    },
    { onConflict: "workspace_id,user_id", ignoreDuplicates: !refresh },
  );
  if (mem.error) throw mem.error;
  const setting = await db.from("workspace_setting").upsert(
    { workspace_id: DEMO_WORKSPACE_ID, key: "demo_workspace", value: { synthetic: true, seed_version: SEED_VERSION, anchor_date: today, note: "Synthetic demo data. Never a real tenant." } },
    { onConflict: "workspace_id,key", ignoreDuplicates: !refresh },
  );
  if (setting.error) throw setting.error;

  // ---- business rows
  const batches = buildDemoDataset(today);
  const summary: Array<{ table: string; generated: number; inDb: number }> = [];
  for (const b of batches) {
    for (let i = 0; i < b.rows.length; i += 500) {
      const chunk = b.rows.slice(i, i + 500);
      const { error } = await db.from(b.table).upsert(chunk, { onConflict: "id", ignoreDuplicates: !refresh, defaultToNull: false });
      if (error) throw new Error(`${b.table}: ${error.message} ${error.details ?? ""} ${error.hint ?? ""}`);
    }
    const { count, error } = await db.from(b.table).select("id", { count: "exact", head: true }).eq("workspace_id", DEMO_WORKSPACE_ID);
    if (error) throw error;
    summary.push({ table: b.table, generated: b.rows.length, inDb: count ?? 0 });
  }

  console.log(`Demo workspace ${DEMO_NAME} (${DEMO_WORKSPACE_ID}) — anchor date ${today}${refresh ? " [refresh]" : ""}`);
  console.table(summary);
  const total = summary.reduce((s, r) => s + r.inDb, 0);
  console.log(`Total demo business rows: ${total}. Sign in as owner@cre-os.local and switch to workspace "${DEMO_NAME}".`);
}

main().catch((e) => {
  console.error(`demo-seed failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

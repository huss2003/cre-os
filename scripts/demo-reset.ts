/**
 * Deletes the synthetic demo workspace (slug demo-pune) and EVERYTHING in it. Touches nothing else.
 *
 *   npm run demo:reset -- --yes
 *   --allow-remote   required when DATABASE_URL is not a local database
 *
 * Why a direct Postgres connection (pg) instead of supabase-js: business tables carry an audit trigger that writes
 * audit_event(workspace_id) on every delete, so a plain `delete from workspace` cascade fails (the audit row would
 * reference the workspace being deleted). We therefore delete the workspace's rows table by table inside ONE
 * transaction (retrying FK-ordered tables until empty), then delete the workspace row, which cascades its audit trail.
 * Every statement is filtered by the hard-coded demo workspace id.
 */
import { Client } from "pg";
import { DEMO_SLUG, DEMO_WORKSPACE_ID, PROTECTED_WORKSPACE_IDS } from "./demo-data/core";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);

async function main() {
  if (!flag("yes")) {
    console.error(`This permanently deletes the demo workspace ${DEMO_WORKSPACE_ID} (${DEMO_SLUG}) and all of its rows.\nRe-run with --yes to confirm.`);
    process.exit(2);
  }
  if (PROTECTED_WORKSPACE_IDS.includes(DEMO_WORKSPACE_ID)) throw new Error("demo workspace id collides with a protected tenant id");
  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is required (run with --env-file=.env.local)");
  const host = new URL(conn).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !flag("allow-remote")) {
    throw new Error(`Refusing to touch non-local database (${host}). Pass --allow-remote if this is intentional.`);
  }

  const db = new Client({ connectionString: conn });
  await db.connect();
  try {
    const ws = await db.query<{ id: string; slug: string; name: string }>("select id, slug::text, name from public.workspace where id = $1", [DEMO_WORKSPACE_ID]);
    if (ws.rowCount === 0) {
      console.log("Demo workspace not present — nothing to do.");
      return;
    }
    if (ws.rows[0].slug !== DEMO_SLUG) throw new Error(`workspace ${DEMO_WORKSPACE_ID} has slug ${ws.rows[0].slug}, expected ${DEMO_SLUG}; aborting`);

    const { rows: tables } = await db.query<{ t: string }>(`
      select c.table_name as t
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'workspace_id' and c.table_name not in ('workspace', 'audit_event')
      order by 1`);

    await db.query("begin");
    let pending = tables.map((r) => r.t);
    const deleted: Record<string, number> = {};
    for (let pass = 1; pending.length > 0; pass++) {
      if (pass > 50) throw new Error(`could not delete rows from: ${pending.join(", ")}`);
      const next: string[] = [];
      for (const t of pending) {
        await db.query("savepoint s");
        try {
          const r = await db.query(`delete from public."${t.replace(/"/g, '""')}" where workspace_id = $1`, [DEMO_WORKSPACE_ID]);
          await db.query("release savepoint s");
          if (r.rowCount) deleted[t] = (deleted[t] ?? 0) + r.rowCount;
        } catch (e) {
          await db.query("rollback to savepoint s");
          if ((e as { code?: string }).code !== "23503") throw e; // only FK ordering is retried
          next.push(t);
        }
      }
      if (next.length === pending.length) throw new Error(`no progress deleting: ${next.join(", ")}`);
      pending = next;
    }
    const w = await db.query("delete from public.workspace where id = $1 and slug = $2", [DEMO_WORKSPACE_ID, DEMO_SLUG]);
    await db.query("commit");
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`Deleted demo workspace (${w.rowCount}) and ${total} rows:`, deleted);
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`demo-reset failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

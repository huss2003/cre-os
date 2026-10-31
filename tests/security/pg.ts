/**
 * Security-test helpers that talk to Postgres directly (read-only catalog queries, and
 * "act as an API role" probes that ALWAYS run inside a transaction which is rolled back).
 *
 * `asRole()` reproduces exactly what PostgREST does for a request: `set local role <anon|authenticated>`
 * plus `request.jwt.claims`, so auth.uid() and RLS behave as for a real API call — but nothing persists.
 * This lets us test app.* RPCs regardless of whether the `app` schema is currently exposed by PostgREST.
 */
import { Client } from "pg";
import { USERS } from "../helpers";

export const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export async function catalog<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query("begin read only");
    const r = await c.query(sql, params);
    await c.query("rollback");
    return r.rows as T[];
  } finally {
    await c.end();
  }
}

export interface Q {
  /** Run a statement in a savepoint; returns rows or the error (transaction stays usable). */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; error: (Error & { code?: string }) | null }>;
  /** Switch the acting identity inside the same transaction. */
  become(who: keyof typeof USERS | "anon" | "service_role" | { id: string }): Promise<void>;
}

/** Run `fn` inside a transaction that is always rolled back. Starts as the given identity. */
export async function asRole<T>(who: keyof typeof USERS | "anon" | "service_role" | { id: string }, fn: (db: Q) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  let sp = 0;
  const api: Q = {
    async q(sql, params = []) {
      const name = `sp${++sp}`;
      await c.query(`savepoint ${name}`);
      try {
        const r = await c.query(sql, params as unknown[]);
        await c.query(`release savepoint ${name}`);
        return { rows: r.rows, error: null };
      } catch (e) {
        await c.query(`rollback to savepoint ${name}`);
        return { rows: [], error: e as Error & { code?: string } };
      }
    },
    async become(w) {
      await c.query("reset role");
      if (w === "anon") {
        await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        await c.query("set local role anon");
      } else if (w === "service_role") {
        await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
        await c.query("set local role service_role");
      } else {
        const id = typeof w === "string" ? USERS[w].id : w.id;
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: id, role: "authenticated" })]);
        await c.query("set local role authenticated");
      }
    },
  };
  try {
    await c.query("begin");
    await c.query("set local statement_timeout = '20s'");
    await c.query("set local lock_timeout = '5s'");
    await api.become(who);
    return await fn(api);
  } finally {
    try { await c.query("rollback"); } catch { /* ignore */ }
    await c.end();
  }
}

/** Every public base table that carries a workspace_id column (i.e. tenant data), discovered live. */
export async function workspaceTables(): Promise<{ table: string; business: boolean }[]> {
  const rows = await catalog<{ table_name: string; business: boolean }>(`
    select c.table_name,
           exists (select 1 from information_schema.columns k where k.table_schema='mudar' and k.table_name=c.table_name and k.column_name='classification')
       and exists (select 1 from information_schema.columns k where k.table_schema='mudar' and k.table_name=c.table_name and k.column_name='owner_user_id')
       and exists (select 1 from information_schema.columns k where k.table_schema='mudar' and k.table_name=c.table_name and k.column_name='id') as business
      from information_schema.columns c
      join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
     where c.table_schema='mudar' and c.column_name='workspace_id'
     order by 1`);
  return rows.map((r) => ({ table: r.table_name, business: r.business }));
}

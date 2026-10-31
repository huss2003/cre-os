/**
 * Static (catalog) security checks — read-only queries against pg_catalog.
 * Discovers tables/functions live, so module migrations landing later are covered automatically.
 */
import { describe, it, expect } from "vitest";
import { catalog } from "./pg";

describe("catalog: RLS coverage", () => {
  it("every public table has RLS enabled", async () => {
    const rows = await catalog<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity order by 1`);
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it("every RLS table either has policies or grants nothing to API roles", async () => {
    const rows = await catalog<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relrowsecurity
          and not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
          and (has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'SELECT'))`);
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it("no permissive `true` / null-qual policies and no policies granted to anon/public", async () => {
    const rows = await catalog<{ t: string; p: string; cmd: string; roles: string }>(
      `select tablename as t, policyname as p, cmd, roles::text as roles from pg_policies
        where schemaname in ('public','storage')
          and ( coalesce(qual,'') in ('true','(true)') or coalesce(with_check,'') in ('true','(true)')
                or (qual is null and cmd in ('SELECT','UPDATE','DELETE','ALL'))
                or roles && array['anon','public']::name[] )
          and not (schemaname='storage' and tablename <> 'objects')`);
    expect(rows).toEqual([]);
  });

  it("every workspace-scoped table's policies reference workspace membership", async () => {
    const rows = await catalog<{ t: string; p: string; qual: string }>(
      `select p.tablename as t, p.policyname as p, coalesce(p.qual, p.with_check) as qual
         from pg_policies p
        where p.schemaname='public'
          and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name=p.tablename and k.column_name='workspace_id')
          and coalesce(p.qual,'') !~ '(can_read|can_write|has_role|is_member)\\(workspace_id'
          and coalesce(p.with_check,'') !~ '(can_read|can_write|has_role|is_member)\\(workspace_id'
          and not (p.tablename='outbox' and p.policyname='outbox_own')
          and not (p.tablename='connector_account')
          and not (p.tablename='idempotency_key' and p.policyname='idem_own')`); // user-scoped replay cache, keyed by auth.uid()
    expect(rows).toEqual([]);
  });

  it("anon has no table privileges on public tables (defence in depth; all policies are TO authenticated)", async () => {
    const rows = await catalog<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','v','m','p')
          and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
               or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))
        order by 1`);
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it("audit_event is append-only for app roles (no UPDATE/DELETE/TRUNCATE for anon/authenticated)", async () => {
    const [r] = await catalog<Record<string, boolean>>(
      `select has_table_privilege('authenticated','public.audit_event','UPDATE') as au,
              has_table_privilege('authenticated','public.audit_event','DELETE') as ad,
              has_table_privilege('authenticated','public.audit_event','TRUNCATE') as at,
              has_table_privilege('anon','public.audit_event','UPDATE') as nu,
              has_table_privilege('anon','public.audit_event','DELETE') as nd,
              has_table_privilege('anon','public.audit_event','TRUNCATE') as nt,
              exists (select 1 from pg_policies where schemaname='public' and tablename='audit_event' and cmd in ('INSERT','UPDATE','DELETE','ALL')) as mod_policy`);
    expect(r).toEqual({ au: false, ad: false, at: false, nu: false, nd: false, nt: false, mod_policy: false });
  });

  it("draft_event is append-only for app roles", async () => {
    const [r] = await catalog<Record<string, boolean>>(
      `select has_table_privilege('authenticated','public.draft_event','UPDATE') as u,
              has_table_privilege('authenticated','public.draft_event','DELETE') as d`);
    expect(r).toEqual({ u: false, d: false });
  });
});

describe("catalog: connector secrets", () => {
  it("connector_account.token_ciphertext / oauth_state secrets are not selectable by anon or authenticated", async () => {
    const [r] = await catalog<Record<string, boolean>>(
      `select has_column_privilege('authenticated','public.connector_account','token_ciphertext','SELECT') as auth_tok,
              has_column_privilege('anon','public.connector_account','token_ciphertext','SELECT') as anon_tok,
              has_table_privilege('authenticated','public.oauth_state','SELECT') as auth_state,
              has_table_privilege('anon','public.oauth_state','SELECT') as anon_state,
              has_table_privilege('authenticated','public.connector_account','INSERT') as auth_ins,
              has_table_privilege('authenticated','public.connector_account','UPDATE') as auth_upd`);
    expect(r).toEqual({ auth_tok: false, anon_tok: false, auth_state: false, anon_state: false, auth_ins: false, auth_upd: false });
  });
});

describe("catalog: SECURITY DEFINER functions", () => {
  it("every SECURITY DEFINER function in app/public pins search_path", async () => {
    const rows = await catalog<{ f: string }>(
      `select n.nspname||'.'||p.proname as f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('app','public') and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`);
    expect(rows).toEqual([]);
  });

  it("anon cannot execute any SECURITY DEFINER function except the RLS membership helpers", async () => {
    // These helpers only ever answer questions about auth.uid() (null for anon) and are used inside policies.
    const allowed = ["app.can_read", "app.can_write", "app.has_role", "app.is_member", "app.is_platform_admin", "app.member_role", "app.audit_row"];
    const rows = await catalog<{ f: string }>(
      `select n.nspname||'.'||p.proname as f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('app','public') and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')`);
    expect(rows.map((r) => r.f).filter((f) => !allowed.includes(f))).toEqual([]);
  });

  it("internal/service-only functions are not executable by authenticated", async () => {
    const serviceOnly = [
      "enqueue_job", "claim_jobs", "complete_job", "fail_job", "export_table", "workspace_tables", "user_id_by_email",
      "cx_role_at_least", "cx_can_read", "cx_load_row", "cx_update_fields", "cx_patch_fields", "cx_audit",
    ];
    const rows = await catalog<{ f: string }>(
      `select p.proname as f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='app' and p.proname = any($1) and has_function_privilege('authenticated', p.oid, 'EXECUTE')`, [serviceOnly]);
    expect(rows.map((r) => r.f)).toEqual([]);
  });

  it("DDL helper functions (make_business_table/make_workspace_table) are not executable by API roles", async () => {
    const rows = await catalog<{ f: string; role: string }>(
      `select p.proname as f, r.role from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        cross join (values ('anon'),('authenticated')) r(role)
        where n.nspname='app' and p.proname in ('make_business_table','make_workspace_table')
          and has_function_privilege(r.role, p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
  });
});

describe("catalog: storage", () => {
  it("workspace-files bucket is private and every UPDATE/DELETE policy goes through app.storage_can", async () => {
    const [b] = await catalog<{ public: boolean }>(`select public from storage.buckets where id='workspace-files'`);
    expect(b?.public).toBe(false);
    const rows = await catalog<{ p: string }>(
      `select policyname as p from pg_policies where schemaname='storage' and tablename='objects'
        and cmd in ('UPDATE','DELETE','ALL') and (coalesce(qual,'') like '%workspace-files%' or coalesce(with_check,'') like '%workspace-files%')
        and not (coalesce(qual,'') like '%storage_can%' and (with_check is null or with_check like '%storage_can%'))`);
    expect(rows).toEqual([]);
  });
});

/**
 * Generic tenant-isolation test (spec Part III "Permissions" acceptance test), through the real PostgREST API.
 * For EVERY public table that has a workspace_id column (discovered live, so module tables are covered):
 *   - the 'other' tenant (owner of WS2, not a member of WS1) sees no WS1 rows;
 *   - the 'other' tenant cannot insert a row into WS1;
 *   - anon sees nothing and cannot insert.
 * And for every standard business table: every WS1 row the colleague (editor, no see_all_accounts,
 * no licensed_restricted) can see is owned by them or shared with them and has an allowed classification.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { userClient, adminClient, WS1, USERS } from "../helpers";
import { workspaceTables } from "./pg";

let tables: { table: string; business: boolean }[] = [];
let other: SupabaseClient;
let colleague: SupabaseClient;
let anon: SupabaseClient;
const admin = adminClient();

beforeAll(async () => {
  tables = await workspaceTables();
  other = await userClient("other");
  colleague = await userClient("colleague");
  anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
});

describe("generic tenant isolation (every workspace_id table)", () => {
  it("discovers the module tables", () => {
    expect(tables.length).toBeGreaterThan(60);
  });

  it("'other' tenant cannot SELECT any WS1 row from any table", async () => {
    const leaks: string[] = [];
    const coverage: string[] = [];
    for (const { table } of tables) {
      const { count } = await admin.from(table).select("workspace_id", { count: "exact", head: true }).eq("workspace_id", WS1);
      if ((count ?? 0) > 0) coverage.push(table);
      const { data, error } = await other.from(table).select("workspace_id").eq("workspace_id", WS1).limit(5);
      if (error && error.code !== "42501") leaks.push(`${table}: unexpected error ${error.code} ${error.message}`);
      if ((data ?? []).length > 0) leaks.push(`${table}: ${data!.length} WS1 rows visible`);
    }
    console.info(`[isolation] ${tables.length} tables checked; ${coverage.length} had WS1 data: ${coverage.join(", ")}`);
    expect(leaks).toEqual([]);
  });

  it("'other' tenant cannot INSERT into WS1 in any table (RLS rejects before constraints)", async () => {
    const accepted: string[] = [];
    const notRls: string[] = [];
    for (const { table } of tables) {
      const { data, error } = await other.from(table).insert({ workspace_id: WS1 }).select();
      if (!error) {
        accepted.push(table);
        // never leave a cross-tenant row behind
        for (const r of (data ?? []) as { id?: string }[]) if (r.id) await admin.from(table).delete().eq("id", r.id);
      } else if (error.code !== "42501") {
        notRls.push(`${table}: ${error.code} ${error.message}`);
      }
    }
    expect(accepted).toEqual([]);
    // Anything other than 42501 means a constraint fired first — still rejected, but listed for visibility.
    if (notRls.length) console.info(`[isolation] insert rejected by non-RLS error: ${notRls.join("; ")}`);
  });

  it("anon cannot SELECT or INSERT any workspace table", async () => {
    const problems: string[] = [];
    for (const { table } of tables) {
      const { data } = await anon.from(table).select("workspace_id").limit(1);
      if ((data ?? []).length > 0) problems.push(`${table}: anon read`);
      const { error } = await anon.from(table).insert({ workspace_id: WS1 });
      if (!error) problems.push(`${table}: anon insert accepted`);
    }
    for (const t of ["workspace", "membership", "platform_admin", "my_workspaces", "audit_event"]) {
      const { data } = await anon.from(t).select("*").limit(1);
      if ((data ?? []).length > 0) problems.push(`${t}: anon read`);
    }
    expect(problems).toEqual([]);
  });

  it("'other' cannot read WS1 tenancy rows (workspace, membership, record_share, audit, jobs)", async () => {
    const { data: ws } = await other.from("workspace").select("id").eq("id", WS1);
    expect(ws).toEqual([]);
    const { data: m } = await other.from("membership").select("id").eq("workspace_id", WS1);
    expect(m).toEqual([]);
    const { error: mi } = await other.from("membership").insert({ workspace_id: WS1, user_id: USERS.other.id, role: "owner" });
    expect(mi).not.toBeNull();
    const { error: ri } = await other.from("record_share").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: WS1, user_id: USERS.other.id });
    expect(ri).not.toBeNull();
  });

  it("colleague only sees WS1 business rows they own / that are shared, with allowed classification", async () => {
    const { data: shares } = await admin.from("record_share").select("entity_type, entity_id").eq("user_id", USERS.colleague.id);
    const shared = new Set((shares ?? []).map((s) => `${s.entity_type}:${s.entity_id}`));
    const allowed = new Set(["public", "permitted_personal", "corporate_confidential"]);
    const violations: string[] = [];
    for (const { table, business } of tables) {
      if (!business) continue;
      const { data } = await colleague.from(table).select("id, owner_user_id, classification").eq("workspace_id", WS1).limit(1000);
      for (const r of (data ?? []) as { id: string; owner_user_id: string | null; classification: string }[]) {
        if (!allowed.has(r.classification)) violations.push(`${table}:${r.id} classification ${r.classification}`);
        else if (r.owner_user_id !== USERS.colleague.id && !shared.has(`${table}:${r.id}`)) violations.push(`${table}:${r.id} not owned/shared`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("'other' cannot UPDATE or DELETE a WS1 row it learns the id of", async () => {
    const owner = await userClient("owner");
    const { data: org } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: `sec-upd-${Date.now()}` }).select().single();
    const { data: upd } = await other.from("organisation").update({ sector: "pwned" }).eq("id", org.id).select();
    expect(upd).toEqual([]);
    const { data: del } = await other.from("organisation").delete().eq("id", org.id).select();
    expect(del).toEqual([]);
    const { data: still } = await admin.from("organisation").select("sector").eq("id", org.id).single();
    expect(still?.sector).toBeNull();
    await admin.from("organisation").delete().eq("id", org.id);
  });
});

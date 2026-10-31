/**
 * RPC / SECURITY DEFINER function access. Executed at the DB level exactly as PostgREST would
 * (set role + request.jwt.claims) inside rolled-back transactions, so it does not depend on which schemas
 * the running PostgREST exposes and leaves no data behind.
 */
import { describe, it, expect } from "vitest";
import { asRole } from "./pg";
import { USERS, WS1, WS2 } from "../helpers";

const RANDOM = "00000000-0000-4000-8000-00000000dead";

describe("service-only RPCs are not callable by API roles", () => {
  const calls: [string, string, unknown[]][] = [
    ["claim_jobs", "select * from app.claim_jobs('attacker', 5, 300, null)", []],
    ["enqueue_job", "select app.enqueue_job($1, 'imports.process', '{}'::jsonb)", [WS1]],
    ["complete_job", "select app.complete_job($1, null)", [RANDOM]],
    ["fail_job", "select app.fail_job($1, 'x')", [RANDOM]],
    ["export_table", "select app.export_table($1, 'organisation')", [WS1]],
    ["workspace_tables", "select * from app.workspace_tables()", []],
    ["user_id_by_email", "select app.user_id_by_email('owner@cre-os.local')", []],
    ["cx_load_row", "select app.cx_load_row('membership', $1, $2, false)", [RANDOM, WS1]],
    ["cx_update_fields", "select app.cx_update_fields('membership', $1, $2, '{\"role\":\"owner\"}'::jsonb)", [RANDOM, WS1]],
    ["cx_audit", "select app.cx_audit($1, null, 'x', null, null, null)", [WS1]],
    ["cx_role_at_least", "select app.cx_role_at_least($1, $2, 'owner')", [WS1, USERS.owner.id]],
  ];
  for (const who of ["anon", "other", "owner"] as const) {
    it(`${who}: every service-only function is denied (42501)`, async () => {
      const allowed = await asRole(who, async (db) => {
        const out: string[] = [];
        for (const [name, sql, params] of calls) {
          const r = await db.q(sql, params);
          if (!r.error || r.error.code !== "42501") out.push(`${name}: ${r.error ? r.error.code + " " + r.error.message : "EXECUTED"}`);
        }
        return out;
      });
      expect(allowed).toEqual([]);
    });
  }

  it("anon cannot call any authenticated app RPC", async () => {
    const calls2 = [
      `select app.apply_change($1, null)`, `select app.approve_change($1)`, `select app.reverse_change($1)`, `select app.preview_reverse($1)`,
      `select * from app.search_entity_candidates('${WS1}', 'organisation', 'ac')`, `select * from app.search_entities('${WS1}', 'a')`,
      `select * from app.alias_matches('${WS1}', 'a')`, `select * from app.member_directory('${WS1}')`,
      `select app.set_ai_paused('${WS1}', true)`, `select app.retry_job($1)`,
      `select * from public.integrations_touch_collisions('${WS1}', $1, null, now() - interval '1 year')`,
    ];
    const executed = await asRole("anon", async (db) => {
      const out: string[] = [];
      for (const sql of calls2) {
        const r = await db.q(sql, sql.includes("$1") ? [RANDOM] : []);
        if (!r.error || r.error.code !== "42501") out.push(`${sql}: ${r.error?.code ?? "EXECUTED"}`);
      }
      return out;
    });
    expect(executed).toEqual([]);
  });
});

describe("authenticated RPCs never act on another workspace", () => {
  it("other tenant gets nothing / is refused for WS1 via every member RPC", async () => {
    const res = await asRole("service_role", async (db) => {
      // seed (as table owner, rolled back): a WS1 org + alias + proposal + account touch + failed job
      await db.q("reset role");
      const org = (await db.q<{ id: string }>(`insert into public.organisation(workspace_id, display_name, owner_user_id) values ($1, 'SecRpcCo', $2) returning id`, [WS1, USERS.owner.id])).rows[0].id;
      await db.q(`insert into public.entity_alias(workspace_id, entity_type, entity_id, raw_alias, canonical_alias) values ($1,'organisation',$2,'SecRpcCo Alias','secrpcco alias')`, [WS1, org]);
      const cp = (await db.q<{ id: string }>(`insert into public.change_proposal(workspace_id, target_type, target_id, operation, patch, risk, approval_required, owner_user_id)
             values ($1,'organisation',$2,'update','[{"op":"replace","path":"/sector","value":"IT"}]','routine_internal',false,$3) returning id`, [WS1, org, USERS.owner.id])).rows[0].id;
      await db.q(`insert into public.account_touch(workspace_id, org_id, user_id, channel, touch_kind, at) values ($1,$2,$3,'email','sent',now())`, [WS1, org, USERS.owner.id]);
      const job = (await db.q<{ id: string }>(`insert into public.job(workspace_id, job_type, state) values ($1,'security.test','failed') returning id`, [WS1])).rows[0].id;

      await db.become("other");
      const out: Record<string, unknown> = {};
      out.search_entities = (await db.q(`select * from app.search_entities($1, 'SecRpcCo')`, [WS1])).rows.length;
      out.alias_matches = (await db.q(`select * from app.alias_matches($1, 'SecRpcCo')`, [WS1])).rows.length;
      out.member_directory = (await db.q(`select * from app.member_directory($1)`, [WS1])).rows.length;
      out.touch_collisions = (await db.q(`select * from public.integrations_touch_collisions($1, $2, null, now() - interval '1 day')`, [WS1, org])).rows.length;
      out.candidates = (await db.q(`select * from app.search_entity_candidates($1, 'organisation', 'SecRpcCo')`, [WS1])).error?.code ?? "EXECUTED";
      out.approve = (await db.q(`select app.approve_change($1)`, [cp])).error?.code ?? "EXECUTED";
      out.apply = (await db.q(`select app.apply_change($1)`, [cp])).error?.code ?? "EXECUTED";
      out.preview = (await db.q(`select app.preview_reverse($1)`, [cp])).error?.code ?? "EXECUTED";
      out.reverse = (await db.q(`select app.reverse_change($1)`, [cp])).error?.code ?? "EXECUTED";
      out.actor_spoof = (await db.q(`select app.apply_change($1, $2)`, [cp, USERS.owner.id])).error?.code ?? "EXECUTED";
      out.ai_pause = (await db.q(`select app.set_ai_paused($1, true)`, [WS1])).error?.code ?? "EXECUTED";
      out.retry_job = (await db.q(`select app.retry_job($1)`, [job])).error?.code ?? "EXECUTED";
      // own-workspace control: other is owner of WS2 and may pause its own workspace
      out.own_ai_pause = (await db.q(`select app.set_ai_paused($1, true)`, [WS2])).error?.code ?? "EXECUTED";
      return out;
    });
    expect(res).toEqual({
      search_entities: 0, alias_matches: 0, member_directory: 0, touch_collisions: 0,
      candidates: "42501", approve: "P0002", apply: "P0002", preview: "P0002", reverse: "P0002", actor_spoof: "42501",
      ai_pause: "42501", retry_job: "42501", own_ai_pause: "EXECUTED",
    });
  });

  it("colleague cannot discover restricted accounts through alias_matches (full-text index leak)", async () => {
    const res = await asRole("service_role", async (db) => {
      await db.q("reset role");
      // org owned by the owner, not shared with colleague, classification the colleague IS allowed
      const org = (await db.q<{ id: string }>(`insert into public.organisation(workspace_id, display_name, owner_user_id, classification)
              values ($1, 'HiddenAcctCo', $2, 'corporate_confidential') returning id`, [WS1, USERS.owner.id])).rows[0].id;
      await db.q(`insert into public.entity_alias(workspace_id, entity_type, entity_id, raw_alias, canonical_alias, owner_user_id, classification)
              values ($1,'organisation',$2,'HiddenAcctCo Pune Pvt Ltd','hiddenacctco pune pvt ltd',$3,'corporate_confidential')`, [WS1, org, USERS.owner.id]);
      await db.become("colleague");
      const direct = (await db.q(`select id from public.organisation where id = $1`, [org])).rows.length;
      const aliasRows = (await db.q(`select id from public.entity_alias where entity_id = $1`, [org])).rows.length;
      const search = (await db.q(`select * from app.search_entities($1, 'HiddenAcctCo')`, [WS1])).rows.length;
      const viaRpc = (await db.q(`select * from app.alias_matches($1, 'HiddenAcctCo')`, [WS1])).rows.length;
      return { direct, aliasRows, search, viaRpc };
    });
    expect(res).toEqual({ direct: 0, aliasRows: 0, search: 0, viaRpc: 0 });
  });
});

describe("tenancy columns / sharing integrity", () => {
  it("record_share created in another workspace cannot unlock a WS1 record (cross-workspace share)", async () => {
    const out = await asRole("service_role", async (db) => {
      await db.q("reset role");
      const org = (await db.q<{ id: string }>(`insert into public.organisation(workspace_id, display_name, owner_user_id) values ($1,'SecShareCo',$2) returning id`, [WS1, USERS.owner.id])).rows[0].id;
      // colleague is a restricted editor in WS1 but (realistically, e.g. agency staff) an admin in a second workspace
      await db.q(`insert into public.membership(workspace_id, user_id, role, see_all_accounts) values ($1,$2,'admin',true)`, [WS2, USERS.colleague.id]);
      await db.become("colleague");
      const before = (await db.q(`select id from public.organisation where id=$1`, [org])).rows.length;
      const share = await db.q(`insert into public.record_share(workspace_id, entity_type, entity_id, user_id) values ($1,'organisation',$2,$3) returning id`, [WS2, org, USERS.colleague.id]);
      const after = (await db.q(`select id from public.organisation where id=$1`, [org])).rows.length;
      return { before, shareInserted: !share.error, after };
    });
    expect(out.before).toBe(0);
    expect(out.after).toBe(0);
  });

  it("a tenant owner cannot lift a platform suspension or raise the AI budget directly", async () => {
    const out = await asRole("service_role", async (db) => {
      await db.q("reset role");
      // "other" owns WS2 and is NOT a platform admin (the seeded owner of WS1 is also the agency platform admin).
      await db.q(`update public.workspace set status='suspended' where id=$1`, [WS2]);
      await db.become("other");
      const unsuspend = await db.q<{ status: string }>(`update public.workspace set status='active' where id=$1 returning status`, [WS2]);
      const budget = await db.q(`update public.workspace set monthly_ai_budget_inr = 99999999 where id=$1 returning 1`, [WS2]);
      return { unsuspend: unsuspend.rows[0]?.status ?? unsuspend.error?.code ?? "noop", budget: budget.rows.length ? "changed" : budget.error?.code ?? "noop" };
    });
    expect(out.unsuspend).not.toBe("active");
    expect(out.budget).not.toBe("changed");
  });
});

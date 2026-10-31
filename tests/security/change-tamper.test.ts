/**
 * Approval binding + change_proposal tampering (spec "Approval invalidation", "Prompt injection: cannot change roles").
 * All scenarios run inside rolled-back transactions acting as the real API roles, so exploits leave no trace.
 *
 * change_proposal is an ordinary business table: an editor can INSERT/UPDATE rows directly through PostgREST.
 * Every SECURITY DEFINER function that trusts a column of change_proposal must therefore re-validate it.
 */
import { describe, it, expect } from "vitest";
import { asRole, type Q } from "./pg";
import { USERS, WS1 } from "../helpers";

async function seedOrg(db: Q, name: string) {
  await db.q("reset role");
  return (await db.q<{ id: string; row_version: number }>(
    `insert into mudar.organisation(workspace_id, display_name, owner_user_id, classification) values ($1,$2,$3,'corporate_confidential') returning id, row_version`,
    [WS1, name, USERS.colleague.id])).rows[0];
}

/** Insert a change_proposal as the CURRENT role (i.e. directly through the API, as an editor could). */
async function insertProposal(db: Q, p: Record<string, unknown>) {
  const cols = Object.keys(p);
  const r = await db.q<{ id: string }>(
    `insert into mudar.change_proposal (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    cols.map((c) => (typeof p[c] === "object" && p[c] !== null && !Array.isArray(p[c]) ? JSON.stringify(p[c]) : Array.isArray(p[c]) && c === "patch" ? JSON.stringify(p[c]) : p[c])));
  if (r.error) throw r.error;
  return r.rows[0].id;
}

describe("approval binding (apply_change)", () => {
  it("approved proposal applies; editing the patch after approval invalidates it; stale row_version is rejected", async () => {
    const out = await asRole("owner", async (db) => {
      const org = await seedOrg(db, "SecBindCo");
      await db.become("colleague");
      const mk = () => insertProposal(db, {
        workspace_id: WS1, target_type: "organisation", target_id: org.id, operation: "update", expected_version: org.row_version,
        patch: [{ op: "replace", path: "/legal_name", value: "SecBind Pvt Ltd" }], risk: "material_fact", approval_required: true,
        owner_user_id: USERS.colleague.id, classification: "corporate_confidential",
      });
      const a = await mk();
      const b = await mk().catch(() => null);
      await db.become("owner");
      const appr = await db.q(`select mudar_app.approve_change($1)`, [a]);
      // colleague (editor) tampers with the approved patch through the API
      await db.become("colleague");
      const tamper = await db.q(`update mudar.change_proposal set patch = '[{"op":"replace","path":"/legal_name","value":"Evil Ltd"}]' where id=$1 returning id`, [a]);
      await db.become("owner");
      const applyTampered = await db.q(`select mudar_app.apply_change($1)`, [a]);
      // untampered second proposal: approve + apply works (positive control) ...
      const b2 = b ?? null;
      let applyOk: string | null = null, staleCode: string | null = null;
      if (b2) {
        await db.q(`select mudar_app.approve_change($1)`, [b2]);
        const ok = await db.q(`select mudar_app.apply_change($1)`, [b2]);
        applyOk = ok.error ? ok.error.message : "applied";
      }
      // ... and a third proposal with the now-stale expected_version is rejected
      await db.become("colleague");
      const c = await mk();
      await db.become("owner");
      await db.q(`select mudar_app.approve_change($1)`, [c]);
      const stale = await db.q(`select mudar_app.apply_change($1)`, [c]);
      staleCode = stale.error?.message.split(":")[0] ?? "applied";
      return { approved: !appr.error, tamperAccepted: tamper.rows.length === 1, applyTampered: applyTampered.error?.message.split(":")[0] ?? "applied", applyOk, staleCode };
    });
    expect(out.approved).toBe(true);
    expect(out.applyTampered).toBe("approval_invalid");
    expect(out.applyOk).toBe("applied");
    expect(out.staleCode).toBe("stale_version");
  });

  it("an editor cannot forge an approval row on behalf of an admin, nor downgrade risk to skip approval", async () => {
    const out = await asRole("owner", async (db) => {
      const org = await seedOrg(db, "SecForgeCo");
      await db.become("colleague");
      const id = await insertProposal(db, {
        workspace_id: WS1, target_type: "organisation", target_id: org.id, operation: "update",
        patch: [{ op: "replace", path: "/cin", value: "U00000MH2026PTC000001" }], risk: "routine_internal", approval_required: false,
        owner_user_id: USERS.colleague.id, classification: "corporate_confidential",
      });
      // risk downgrade: colleague applies its own 'routine' proposal that touches a material field
      const selfApply = await db.q(`select mudar_app.apply_change($1)`, [id]);
      // forged approval, claiming the owner approved, with the correct hash
      const h = (await db.q<{ h: string }>(`select mudar_app.change_hash(cp) as h from mudar.change_proposal cp where id=$1`, [id])).rows[0]?.h;
      const forged = await db.q(`insert into mudar.approval(workspace_id, subject_type, subject_id, approver_user_id, approved_hash, decision, owner_user_id, classification)
                                 values ($1,'change_proposal',$2,$3,$4,'approved',$5,'corporate_confidential') returning id`, [WS1, id, USERS.owner.id, h, USERS.colleague.id]);
      await db.q(`update mudar.change_proposal set state='approved' where id=$1`, [id]);
      await db.become("owner");
      const ownerApply = await db.q(`select mudar_app.apply_change($1)`, [id]);
      return { selfApply: selfApply.error?.message.split(":")[0] ?? "applied", forgedInserted: !forged.error, ownerApply: ownerApply.error?.message.split(":")[0] ?? "applied" };
    });
    expect(out.selfApply).toBe("forbidden");
    expect(out.ownerApply).toBe("approval_invalid");
  });

  it("proposals can never target permission/system tables via apply_change", async () => {
    const out = await asRole("owner", async (db) => {
      const mid = (await db.q<{ id: string }>(`select id from mudar.membership where workspace_id=$1 and user_id=$2`, [WS1, USERS.colleague.id])).rows[0].id;
      const id = await insertProposal(db, {
        workspace_id: WS1, target_type: "membership", target_id: mid, operation: "update",
        patch: [{ op: "replace", path: "/role", value: "owner" }], risk: "routine_internal", approval_required: false,
        owner_user_id: USERS.owner.id, classification: "corporate_confidential",
      });
      const r = await db.q(`select mudar_app.apply_change($1)`, [id]);
      return r.error?.message.split(":")[0] ?? "applied";
    });
    expect(out).toBe("forbidden");
  });
});

describe("change_proposal tampering via reversal functions", () => {
  it("CRITICAL: editor cannot escalate own membership to owner through reverse_change on a forged proposal", async () => {
    const out = await asRole("colleague", async (db) => {
      const mem = (await db.q<{ id: string; role: string }>(`select id, role from mudar.membership where workspace_id=$1 and user_id=$2`, [WS1, USERS.colleague.id])).rows[0];
      // forged "already applied" proposal pointing at the membership table, inserted directly through the API
      const id = await insertProposal(db, {
        workspace_id: WS1, target_type: "membership", target_id: mem.id, operation: "update",
        patch: [{ op: "replace", path: "/role", value: "editor" }], risk: "routine_internal", approval_required: false,
        state: "applied", applied_audit_id: 1, owner_user_id: USERS.colleague.id, classification: "corporate_confidential",
        before: { kind: "update", fields: { role: "owner", see_all_accounts: true }, after: { role: mem.role, see_all_accounts: false }, reversed: [] },
      });
      const rev = await db.q(`select mudar_app.reverse_change($1)`, [id]);
      const after = (await db.q<{ role: string; see_all_accounts: boolean }>(`select role, see_all_accounts from mudar.membership where id=$1`, [mem.id])).rows[0];
      return { before: mem.role, reverse: rev.error?.message ?? "executed", after };
    });
    expect(out.before).toBe("editor");
    expect(out.after).toEqual({ role: "editor", see_all_accounts: false });
  });

  it("CRITICAL: editor cannot read secrets/rows of arbitrary tables through preview_reverse on a forged proposal", async () => {
    const out = await asRole("owner", async (db) => {
      await db.q("reset role");
      await db.q(`insert into mudar.connector_account(workspace_id, user_id, provider, status, token_ciphertext)
                  values ($1,$2,'google','mock','SEC-TOKEN-CIPHERTEXT') on conflict (workspace_id, user_id, provider) do update set token_ciphertext='SEC-TOKEN-CIPHERTEXT'`, [WS1, USERS.owner.id]);
      const ca = (await db.q<{ id: string }>(`select id from mudar.connector_account where workspace_id=$1 and user_id=$2 and provider='google'`, [WS1, USERS.owner.id])).rows[0].id;
      await db.become("colleague");
      const direct = await db.q(`select token_ciphertext from mudar.connector_account where id=$1`, [ca]);
      const id = await insertProposal(db, {
        workspace_id: WS1, target_type: "connector_account", target_id: ca, operation: "update",
        patch: [{ op: "replace", path: "/status", value: "mock" }], risk: "routine_internal", approval_required: false,
        state: "applied", applied_audit_id: 1, owner_user_id: USERS.colleague.id, classification: "corporate_confidential",
        before: { kind: "update", fields: { token_ciphertext: null }, after: { token_ciphertext: null }, reversed: [] },
      });
      const prev = await db.q<{ j: unknown }>(`select mudar_app.preview_reverse($1) as j`, [id]);
      return { directDenied: direct.error?.code ?? "allowed", preview: JSON.stringify(prev.rows[0]?.j ?? prev.error?.message ?? null) };
    });
    expect(out.directDenied).toBe("42501");
    expect(out.preview).not.toContain("SEC-TOKEN-CIPHERTEXT");
  });

  it("editor cannot reverse a high-value change by first downgrading the stored risk", async () => {
    const out = await asRole("owner", async (db) => {
      await db.q("reset role");
      const org = (await db.q<{ id: string }>(`insert into mudar.organisation(workspace_id, display_name, owner_user_id) values ($1,'SecHvCo',$2) returning id`, [WS1, USERS.colleague.id])).rows[0].id;
      const opp = (await db.q<{ id: string }>(`insert into mudar.opportunity(workspace_id, org_id, name, expected_fee, owner_user_id, classification)
                     values ($1,$2,'SecHvOpp',5000000,$3,'corporate_confidential') returning id`, [WS1, org, USERS.colleague.id])).rows[0].id;
      await db.become("colleague");
      const id = await insertProposal(db, {
        workspace_id: WS1, target_type: "opportunity", target_id: opp, operation: "update",
        patch: [{ op: "replace", path: "/expected_fee", value: 6000000 }], risk: "high_value", approval_required: true,
        owner_user_id: USERS.colleague.id, classification: "corporate_confidential",
      });
      await db.become("owner");
      await db.q(`select mudar_app.approve_change($1)`, [id]);
      const applied = await db.q(`select mudar_app.apply_change($1)`, [id]);
      await db.become("colleague");
      const direct = await db.q(`select mudar_app.reverse_change($1)`, [id]);
      await db.q(`update mudar.change_proposal set risk='routine_internal' where id=$1`, [id]);
      const downgraded = await db.q(`select mudar_app.reverse_change($1)`, [id]);
      const fee = (await db.q<{ expected_fee: string }>(`select expected_fee from mudar.opportunity where id=$1`, [opp])).rows[0]?.expected_fee;
      return { applied: applied.error?.message ?? "ok", direct: direct.error?.message.split(":")[0] ?? "reversed", downgraded: downgraded.error?.message.split(":")[0] ?? "reversed", fee };
    });
    expect(out.applied).toBe("ok");
    expect(out.direct).toBe("forbidden");
    expect(out.downgraded).toBe("forbidden");
  });
});

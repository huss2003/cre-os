/**
 * Acceptance tests (spec Part III): Approval invalidation, Reversal (single + batch, later independent edits kept,
 * conflicts surfaced), identity merge + reversal, Person move, material-field guard (M3).
 * Real local Supabase, real RLS: owner = owner/admin approver, colleague = editor.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, tag, USERS, WS1 } from "../../../tests/helpers";
import { proposeChange, ChangeError } from "@/lib/services/changes";
import {
  approveChange, applyChange, approveAndApply, editChange, rejectChange, reverseChange, previewReverse,
  batchReverse, previewBatchReverse, proposeMerge, proposePersonMove, commitRoutine, listQueue, getProposal,
} from "./service";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;

type Db = Awaited<ReturnType<typeof userClient>>;
let owner: Db, colleague: Db, admin: Db;

beforeAll(async () => {
  owner = await userClient("owner");
  colleague = await userClient("colleague");
  admin = adminClient();
});

async function org(name: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin.from("organisation").insert({ workspace_id: WS1, display_name: name, owner_user_id: USERS.colleague.id, ...extra }).select().single();
  if (error) throw error;
  return data as AnyRow;
}
async function row(table: string, id: string) {
  const { data } = await admin.from(table).select("*").eq("workspace_id", WS1).eq("id", id).single();
  return data as AnyRow;
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof ChangeError ? e.code : String(e); } };

describe("approval binding and invalidation", () => {
  it("editor proposes, admin approves; editing after approval or a newer row version rejects the old approval", async () => {
    const o = await org(tag("ApprCo"));
    const p = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: o.id, patch: [{ op: "replace", path: "/legal_name", value: "Appr Pvt Ltd" }], reason: "test" });
    expect(p.risk).toBe("material_fact");
    expect(p.approval_required).toBe(true);
    expect(p.expected_version).toBe(o.row_version);            // bound to the version the proposer saw
    expect(p.before).toMatchObject({ kind: "proposal_snapshot", fields: { legal_name: null } });
    expect(await code(approveChange(colleague, p.id))).toBe("forbidden");   // editors cannot approve material changes
    await approveChange(owner, p.id);
    await editChange(colleague, p.id, [{ op: "replace", path: "/legal_name", value: "Other Pvt Ltd" }]);
    expect(await code(applyChange(owner, p.id))).toBe("approval_invalid");
    const { data: after } = await owner.from("change_proposal").select("state").eq("id", p.id).single();
    expect(after!.state).toBe("proposed");

    // re-approve; then an unrelated direct edit moves the row version -> stale
    await approveChange(owner, p.id);
    await owner.from("organisation").update({ sector: "IT" }).eq("id", o.id);
    expect(await code(applyChange(owner, p.id))).toBe("stale_version");
  });

  it("routine changes commit immediately with undo; material ones wait", async () => {
    const o = await org(tag("RoutCo"));
    const r = await commitRoutine(colleague, WS1, { targetType: "organisation", targetId: o.id, patch: [{ op: "replace", path: "/sector", value: "Pharma" }], reason: "routine" });
    expect(r.applied).toBe(true);
    expect((await row("organisation", o.id)).sector).toBe("Pharma");
    const undo = await reverseChange(colleague, r.undoProposalId!);
    expect(undo.status).toBe("reversed");
    expect((await row("organisation", o.id)).sector).toBeNull();
    const m = await commitRoutine(colleague, WS1, { targetType: "organisation", targetId: o.id, patch: [{ op: "replace", path: "/cin", value: "U1" }], reason: "material" });
    expect(m.applied).toBe(false);
    const q = await listQueue(owner, WS1, "records");
    expect(q.proposals!.some((x) => x.id === m.proposal.id)).toBe(true);
    await rejectChange(owner, m.proposal.id, { note: "no" });
    expect((await getProposal(owner, WS1, m.proposal.id)).proposal.state).toBe("rejected");
  });

  it("direct API writes to material fields are refused (M3) while normal fields still work", async () => {
    const o = await org(tag("GuardCo"));
    const bad = await colleague.from("organisation").update({ legal_name: "Sneaky Ltd" }).eq("id", o.id).select();
    expect(bad.error?.message).toMatch(/approval_required/);
    const ok = await colleague.from("organisation").update({ sector: "Retail" }).eq("id", o.id).select();
    expect(ok.error).toBeNull();
  });
});

describe("reversal", () => {
  it("single undo restores intended fields, keeps a later independent edit and surfaces the conflict", async () => {
    const o = await org(tag("RevCo"), { legal_name: "Rev Old Ltd", sector: "Old" });
    const p = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: o.id, reason: "rev",
      patch: [{ op: "replace", path: "/legal_name", value: "Rev New Ltd" }, { op: "replace", path: "/sector", value: "New" }] });
    await approveAndApply(owner, p.id);
    // later independent edits: sector changed again, hq_country set
    await owner.from("organisation").update({ sector: "Newer", hq_country: "IN" }).eq("id", o.id);
    const prev = await previewReverse(owner, p.id);
    expect(prev.reversible).toBe(true);
    expect(prev.fields!.find((f) => f.path === "/sector")!.restorable).toBe(false);
    expect(prev.later_changes!.length).toBeGreaterThan(0);
    const res = await reverseChange(owner, p.id);
    expect(res.status).toBe("partial");
    expect(res.restored).toEqual(["/legal_name"]);
    expect(res.conflicts[0]).toMatchObject({ kind: "field", path: "/sector", current: "Newer" });
    const now = await row("organisation", o.id);
    expect(now).toMatchObject({ legal_name: "Rev Old Ltd", sector: "Newer", hq_country: "IN" });
    const { conflicts } = await getProposal(owner, WS1, p.id);
    expect(conflicts.length).toBe(1);
  });

  it("batch undo previews dependencies, reverses newest first and preserves later independent edits", async () => {
    const o = await org(tag("BatchCo"));
    const a = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: o.id, reason: "a", patch: [{ op: "replace", path: "/legal_name", value: "Batch A Ltd" }] });
    await approveAndApply(owner, a.id);
    const b = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: o.id, reason: "b", patch: [{ op: "replace", path: "/cin", value: "U2" }] });
    await approveAndApply(owner, b.id);
    await owner.from("organisation").update({ sector: "Kept" }).eq("id", o.id);
    const prev = await previewBatchReverse(owner, WS1, [a.id, b.id]);
    expect(prev.order).toEqual([b.id, a.id]);
    expect(prev.sharedRecords[0].proposals).toEqual([b.id, a.id]);
    const r = await batchReverse(owner, WS1, [a.id, b.id]);
    expect(r).toMatchObject({ reversed: 2, failed: 0 });
    expect(await row("organisation", o.id)).toMatchObject({ legal_name: null, cin: null, sector: "Kept" });
  });

  it("an editor cannot undo a material change (needs the approver role)", async () => {
    const o = await org(tag("RevRoleCo"));
    const p = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: o.id, reason: "x", patch: [{ op: "replace", path: "/gstin", value: "27AAAAA0000A1Z5" }] });
    await approveAndApply(owner, p.id);
    expect(await code(reverseChange(colleague, p.id))).toBe("forbidden");
  });
});

describe("identity merge", () => {
  it("merge re-points references, archives the duplicate and keeps an alias; reversal restores both", async () => {
    const win = await org(tag("MergeWin"));
    const lose = await org(tag("MergeLose"));
    const { data: person } = await admin.from("person").insert({ workspace_id: WS1, full_name: tag("Merge Person"), owner_user_id: USERS.colleague.id }).select().single();
    const { data: emp } = await admin.from("employment").insert({ workspace_id: WS1, person_id: person!.id, org_id: lose.id, owner_user_id: USERS.colleague.id }).select().single();
    const p = await proposeMerge(colleague, WS1, { entityType: "organisation", winnerId: win.id, loserId: lose.id, reason: "duplicate" });
    expect(p.risk).toBe("identity_merge");
    expect(await code(applyChange(colleague, p.id))).toBe("forbidden");
    await approveAndApply(owner, p.id);
    expect((await row("employment", emp!.id)).org_id).toBe(win.id);
    expect((await row("organisation", lose.id)).archived_at).not.toBeNull();
    const { data: alias } = await admin.from("entity_alias").select("id, archived_at").eq("workspace_id", WS1).eq("entity_id", win.id).eq("raw_alias", lose.display_name);
    expect(alias!.length).toBe(1);
    const res = await reverseChange(owner, p.id);
    expect(res.status).toBe("reversed");
    expect((await row("employment", emp!.id)).org_id).toBe(lose.id);
    expect((await row("organisation", lose.id)).archived_at).toBeNull();
    expect((await row("entity_alias", alias![0].id)).archived_at).not.toBeNull();
  });
});

describe("person move", () => {
  it("retains prior employment, links the new employer, copies nothing from the old company", async () => {
    const oldOrg = await org(tag("MoveOld"));
    const newOrg = await org(tag("MoveNew"));
    const { data: person } = await admin.from("person").insert({ workspace_id: WS1, full_name: tag("Mover"), owner_user_id: USERS.colleague.id }).select().single();
    const { data: emp } = await admin.from("employment").insert({ workspace_id: WS1, person_id: person!.id, org_id: oldOrg.id, title: "Head Admin", owner_user_id: USERS.colleague.id }).select().single();
    const { data: ix } = await admin.from("interaction").insert({ workspace_id: WS1, occurred_at: new Date().toISOString(), channel: "note",
      summary: "CONFIDENTIAL old-company lease strategy", owner_user_id: USERS.colleague.id }).select().single();
    await admin.from("interaction_link").insert([{ workspace_id: WS1, interaction_id: ix!.id, entity_type: "organisation", entity_id: oldOrg.id, owner_user_id: USERS.colleague.id },
      { workspace_id: WS1, interaction_id: ix!.id, entity_type: "person", entity_id: person!.id, owner_user_id: USERS.colleague.id }]);
    const props = await proposePersonMove(colleague, WS1, { personId: person!.id, newOrgId: newOrg.id, title: "VP Real Estate", startDate: "2026-10-01", endDate: "2026-09-30", reason: "LinkedIn update" });
    expect(props).toHaveLength(2);
    for (const p of props) await approveAndApply(owner, p.id);
    const oldEmp = await row("employment", emp!.id);
    expect(oldEmp).toMatchObject({ is_current: false, end_date: "2026-09-30", org_id: oldOrg.id, title: "Head Admin" });
    const { data: emps } = await admin.from("employment").select("*").eq("workspace_id", WS1).eq("person_id", person!.id).is("archived_at", null);
    expect(emps!.length).toBe(2);
    expect(emps!.find((e) => e.org_id === newOrg.id)).toMatchObject({ is_current: true, title: "VP Real Estate" });
    const { data: links } = await admin.from("interaction_link").select("id").eq("workspace_id", WS1).eq("entity_type", "organisation").eq("entity_id", newOrg.id);
    expect(links).toEqual([]);            // old-company notes never attach to the new company
  });
});

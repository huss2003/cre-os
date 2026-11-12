import { describe, it, expect, beforeAll } from "vitest";
import { adminClient, userClient, WS1, USERS, tag } from "../../../../tests/helpers";
import { getPersonContext } from "./entity/person";
import { getCompanyContext } from "./entity/company";
import { getPropertyContext } from "./entity/property";
import { getRequirementContext } from "./requirement/service";
import { getMeetingContext } from "./context/meeting";
import { getTimeline } from "./context/timeline";
import { summariseContext } from "./context/summary";
import type { MemCtx } from "./types";

/** Spec §17 scenarios 1–6, 14–15, 17, 20–22 (WS1, own fixtures, mock AI). */
describe("intelligence memory (§17)", () => {
  const t = tag("im");
  let ctx: MemCtx; let other: MemCtx;
  let orgA: string, orgB: string, pid: string, empA: string, reqId: string, oppId: string, assetId: string, spaceId: string, meetingId: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const db = await userClient("owner");
    ctx = { db, workspaceId: WS1, userId: USERS.owner.id };
    other = { db: await userClient("other"), workspaceId: WS1, userId: USERS.other.id };
    const ins = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data!.id as string;
    };
    orgA = await ins("organisation", { display_name: `Alpha ${t}` });
    orgB = await ins("organisation", { display_name: `Beta ${t}` });
    pid = await ins("person", { full_name: `Priya ${t}` });
    // Scenario 1: new contact with current employment
    empA = await ins("employment", { person_id: pid, org_id: orgA, title: "Facilities Manager", seniority: "manager", is_current: true, start_date: "2023-01-01", fact_status: "currently_confirmed" });
    reqId = await ins("requirement", { org_id: orgA, title: `Pune office ${t}`, status: "estimated", area_target_sf: 10000, occupation_date: "2026-12-31", constraints: { field_status: { area: "client_confirmed", occupation_date: "estimated" } } });
    await ins("requirement_version", { requirement_id: reqId, version: 1, snapshot: { title: `Pune office ${t}`, area_min_sf: null, area_target_sf: 10000, area_max_sf: null, occupation_date: "2026-12-31" }, field_status: {}, owner_user_id: USERS.owner.id });
    await ins("stakeholder", { requirement_id: reqId, person_id: pid, role: "approver" });
    oppId = await ins("opportunity", { org_id: orgA, requirement_id: reqId, name: `Alpha deal ${t}`, stage: "qualified_discussion" });
    // Scenario 2: multiple interactions
    for (const [i, d] of [["2026-09-01", "outbound"], ["2026-10-01", "inbound"], ["2026-11-01", "inbound"]].entries()) {
      const iid = await ins("interaction", { occurred_at: `${d[0]}T10:00:00Z`, channel: i === 1 ? "meeting" : "email", direction: d[1], subject: `Talk ${i} ${t}`, summary: `Discussed Pune options ${i}`, is_meaningful: true,
        promises: i === 2 ? [{ what: `Send shortlist ${t}`, due: "2026-11-05", status: "open", who: "self" }] : [], objections: i === 1 ? [`Parking too limited ${t}`] : [] });
      ids.push(iid);
      await ins("interaction_link", { interaction_id: iid, entity_type: "person", entity_id: pid });
    }
    // Property with an old quote and an explicit rejection
    assetId = await ins("asset", { name: `Tower ${t}`, asset_kind: "building" });
    spaceId = await ins("space", { asset_id: assetId, floor_text: "5" });
    await ins("quote", { space_id: spaceId, requirement_id: reqId, version: 1, terms_json: { rent: 80, rent_basis: "chargeable", cam_per_sf: 12 } });
    await ins("shortlist_option", { requirement_id: reqId, asset_id: assetId, space_id: spaceId, option_status: "rejected", disqualifiers: ["parking"], eligible: false, version: 1, rubric_version: "test" });
    meetingId = await ins("meeting_visit", { title: `Review ${t}`, start_at: "2026-12-01T05:00:00Z", end_at: "2026-12-01T06:00:00Z", status: "confirmed", kind: "meeting", linked_entity_type: "person", linked_entity_id: pid, opportunity_id: oppId });
  });

  it("1. new contact has contextual memory with verified current employment and explicit unknowns", async () => {
    const c = (await getPersonContext(ctx, pid))!;
    expect(c.currentEmployment).toHaveLength(1);
    expect(c.currentEmployment[0].verification).toBe("verified");
    expect(c.currentEmployment[0].status).toBe("current");
    expect(c.unknowns).toContain("Preferred way to communicate");
    expect(c.decisionRoles.some((d) => d.value === "approver" && d.status === "current")).toBe(true);
  });

  it("2–3. multiple interactions → complete history, oldest first-contact, relationship evidence explained", async () => {
    const c = (await getPersonContext(ctx, pid))!;
    expect(c.interactions.map((i) => i.id).sort()).toEqual([...ids].sort());
    expect(c.lastInteractionAt?.slice(0, 10)).toBe("2026-11-01");
    expect(c.relationship.factors.length).toBeGreaterThan(0);
    expect(c.relationship.explanation[0]).toMatch(/recorded evidence/);
    const tl = await getTimeline(ctx, { personId: pid, types: ["interaction"] });
    expect(tl.map((e) => e.id)).toEqual(ids.slice().reverse().map((i) => `i:${i}`));
  });

  it("4–6. employer change keeps old employment as history; opportunity stays with original company", async () => {
    // The move is a material change (S4: approval-gated); simulate the approved, applied change.
    const up = await adminClient().from("employment").update({ is_current: false, end_date: "2026-10-31" }).eq("workspace_id", WS1).eq("id", empA).select("id");
    expect(up.error?.message ?? null).toBeNull(); expect(up.data).toHaveLength(1);
    const { error } = await ctx.db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: orgB, title: "Corporate Real Estate Director", is_current: true, start_date: "2026-11-01", fact_status: "reported" });
    expect(error).toBeNull();
    const c = (await getPersonContext(ctx, pid))!;
    expect(c.currentEmployment.map((e) => e.related[0].id)).toEqual([orgB]);
    expect(c.currentEmployment[0].verification).toBe("reported");
    expect(c.previousEmployment.map((e) => e.related[0].id)).toEqual([orgA]);
    expect(c.previousEmployment[0].status).toBe("historical");
    expect(c.opportunities.map((o) => o.id)).not.toContain(oppId);
    expect(c.formerEmployerOpportunities.map((o) => o.id)).toContain(oppId);
    expect(c.decisionRoles.find((d) => d.value === "approver")!.status).toBe("historical");
    const a = (await getCompanyContext(ctx, orgA))!;
    expect(a.activeOpportunities.map((o) => o.id)).toContain(oppId);
    expect(a.people.find((p) => p.personId === pid)!.current).toBe(false);
    const b = (await getCompanyContext(ctx, orgB))!;
    expect(b.activeOpportunities).toHaveLength(0);
    expect(b.currentRequirements).toHaveLength(0);
  });

  it("14–15. meeting context: attendees, last discussion, outstanding (overdue) commitments, suggested points", async () => {
    const m = (await getMeetingContext(ctx, meetingId))!;
    expect(m.attendees.map((a) => a.personId)).toEqual([pid]);
    expect(m.attendees[0].designation).toBe("Corporate Real Estate Director");
    expect(m.lastDiscussion?.subject).toBe(`Talk 2 ${t}`);
    expect(m.pendingCommitments.map((c) => c.text)).toContain(`Send shortlist ${t}`);
    expect(m.pendingCommitments.find((c) => c.text === `Send shortlist ${t}`)!.overdue).toBe(true);
    expect(m.requirements.map((r) => r.id)).toContain(reqId);
    expect(m.suggestedPoints.join(" ")).toMatch(/Send shortlist/);
    expect(m.objections.map((o) => o.text)).toContain(`Parking too limited ${t}`);
  });

  it("17. previous property rejection reasons are retrievable from requirement and property", async () => {
    const r = (await getRequirementContext(ctx, reqId))!;
    expect(r.rejections[0].reason).toMatch(/parking/);
    const p = (await getPropertyContext(ctx, assetId))!;
    expect(p.rejections.map((x) => x.reason).join()).toMatch(/parking/);
    expect(p.quotations[0].status).toBe("historical");
    expect(p.quotations[0].display).toMatch(/not current pricing/);
  });

  it("20. every memory item / timeline event carries a source reference", async () => {
    const c = (await getPersonContext(ctx, pid))!;
    for (const i of [...c.currentEmployment, ...c.previousEmployment, ...c.decisionRoles]) expect(i.sourceRef).not.toBeNull();
    for (const x of c.commitments) expect(x.source.id).toBeTruthy();
    const tl = await getTimeline(ctx, { orgId: orgA });
    expect(tl.length).toBeGreaterThan(0);
    for (const e of tl) expect(e.sourceRef?.id).toBeTruthy();
    const r = (await getRequirementContext(ctx, reqId))!;
    expect(r.current.every((f) => f.sourceRef)).toBe(true);
  });

  it("21. permissions: a user outside the workspace sees nothing", async () => {
    expect(await getPersonContext(other, pid)).toBeNull();
    expect(await getCompanyContext(other, orgA)).toBeNull();
    expect(await getRequirementContext(other, reqId)).toBeNull();
    expect(await getTimeline(other, { personId: pid })).toEqual([]);
  });

  it("22. historical memory preserved: requirement versions kept, previous value marked obsolete, confidence classes honest", async () => {
    await ctx.db.from("requirement").update({ area_target_sf: 15000 }).eq("id", reqId);
    const { error } = await ctx.db.from("requirement_version").insert({ workspace_id: WS1, requirement_id: reqId, version: 2, change_reason: "client call", owner_user_id: USERS.owner.id,
      snapshot: { title: `Pune office ${t}`, area_min_sf: null, area_target_sf: 15000, area_max_sf: null, occupation_date: "2026-12-31" }, field_status: {} });
    expect(error).toBeNull();
    const r = (await getRequirementContext(ctx, reqId))!;
    expect(r.history.map((v) => v.version)).toEqual([2, 1]);
    const ch = r.changes.find((c) => c.field === "area")!;
    expect(ch.from).toEqual([null, 10000, null]); expect(ch.to).toEqual([null, 15000, null]); expect(ch.previousObsolete).toBe(true);
    expect(r.current.find((f) => f.category === "requirement.area")!.confidenceClass).toBe("confirmed");
    expect(r.current.find((f) => f.category === "requirement.occupation_date")!.confidenceClass).toBe("estimated");
    expect(r.current.find((f) => f.category === "requirement.budget")!.confidenceClass).toBe("unknown");
    const s = await summariseContext(ctx, "requirement", ["Area 15000 SF (confirmed)."], ["Budget"]);
    expect(s.aiGenerated).toBe(false); expect(s.source).toBe("code"); expect(s.text).toContain("15000"); expect(s.text).toMatch(/Still unknown: Budget/);
  });
});

// Spec §23: meeting + Head of Administration + opportunity → M1/M2/M3/M4/M5 context → overview, attendees, purpose,
// 5 essential questions, talking points, objections, missing info, readiness → brief → edit/review → notes →
// proposed requirement + commitments → approval → tasks + interaction. Plus first meeting, multiple / unresolved
// attendees, missing company info, unverified signals, cancel, reschedule, .ics import (incl. duplicate), isolation.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import * as S from "./service";
import { parseIcs, pickQuestions, readiness, READINESS } from "./rules";

const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;

describe("rules", () => {
  it("flags questions already answered by records and keeps 5 essential", () => {
    const q = pickQuestions("requirement", { req: { seats_target: 200, budget_max: 90 }, stakeholders: 0, leases: 0, offices: 0 });
    expect(q.essential).toHaveLength(5);
    expect(q.essential.some((x) => x.key === "seats")).toBe(false);
    expect([...q.additional].some((x) => x.key === "seats" && x.answered)).toBe(true);
  });
  it("readiness explains gaps", () => {
    const r = readiness(Object.fromEntries(READINESS.map((f) => [f.key, 1])) as never, {});
    expect(r.score).toBe(100);
    const r2 = readiness({ ...(Object.fromEntries(READINESS.map((f) => [f.key, 1])) as Record<string, number>), requirement: 0 } as never, { requirement: "Budget not confirmed" });
    expect(r2.score).toBe(85); expect(r2.critical).toContain("Budget not confirmed");
  });
  it("parses .ics events", () => {
    const ev = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc-1\r\nSUMMARY:Site visit Kharadi\r\nDTSTART:20991201T103000\r\nDTEND:20991201T113000\r\nATTENDEE;CN=Rahul:mailto:rahul@x.example\r\nEND:VEVENT\r\nEND:VCALENDAR");
    expect(ev[0]).toMatchObject({ uid: "abc-1", title: "Site visit Kharadi" });
    expect(ev[0].attendees[0].email).toBe("rahul@x.example");
  });
});

describe("Module 7 — meeting preparation end to end", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("mp");
  let org: string; let pid: string; let opp: string; let req: string;
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `VertexNova ${t}`, sector: "IT services", domain: `vn-${t}.example` }).select("id").single()).data!.id;
    pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Rahul Mehta ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: org, title: "Head of Administration", is_current: true });
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "email", value: `rahul@vn-${t}.example`, verify_status: "likely_valid" });
    await db.from("contact_role_assessment").insert({ workspace_id: WS1, person_id: pid, org_id: org, role_class: "technical_evaluator", cre_relevance: "high", active: true, source: "test" });
    await db.from("signal").insert({ workspace_id: WS1, category: "expansion", kind: "pune_expansion", title: `VertexNova ${t} plans Pune expansion`, org_id: org, verification: "inference", confidence: "medium", dedupe_key: `m:${t}` });
    req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: org, title: `VN Pune office ${t}`, objective: "expansion", status: "draft" }).select("id").single()).data!.id;
    opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: org, requirement_id: req, name: `VN Pune ${t}`, stage: "engaged" }).select("id").single()).data!.id;
    const i = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: "2026-08-01T10:00:00Z", channel: "call", direction: "outbound", summary: "Discussed hiring plans", promises: [{ who: "us", what: "Send Kharadi market note" }], owner_user_id: owner }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: pid, role: "to" });
  });

  it("creates, matches attendees, builds an evidence-tagged brief, scores readiness, and turns notes into proposals", async () => {
    const start = new Date(Date.now() + 3 * 864e5).toISOString();
    const m = await S.createMeeting(db, WS1, owner, { title: "VertexNova requirement discussion", start, type: "requirement", orgId: org, opportunityId: opp, requirementId: req, personIds: [pid], external: [{ name: "Unknown Guest", email: `guest@vn-${t}.example` }, { email: `rahul@vn-${t}.example` }] });
    const { data: att } = await db.from("meeting_prep_attendee").select("person_id, match_status").eq("prep_id", m.id);
    expect(att).toHaveLength(2);                                                         // email match de-duplicated with the chosen person
    expect(att!.find((a) => !a.person_id)!.match_status).toBe("unresolved");
    const g = await S.generateBrief(db, WS1, owner, m.id, noAi);
    expect(g.version).toBe(1);
    const { data: p } = await db.from("meeting_prep").select("*").eq("id", m.id).single();
    const b = p!.brief;
    expect(p!.status).toBe("brief_ready");
    expect(b.history.first).toBe(false);
    expect(b.history.commitments[0].text).toMatch(/Kharadi market note/);
    expect(b.company.items.find((x: { source: { type: string } }) => x.source?.type === "signal").kind).toBe("inference");     // unverified signal labelled
    expect(b.questions.essential).toHaveLength(5);
    expect(b.strategy.map((s: { stage: string }) => s.stage)).toEqual(["opening", "discovery", "value", "discussion", "closing"]);
    expect(b.objections.length).toBeGreaterThan(0);
    expect(p!.readiness).toBeLessThan(100);
    expect([...p!.readiness_detail.critical, ...p!.readiness_detail.missing].join(" ")).toMatch(/Budget not confirmed|Decision-maker/);
    const md = S.briefMarkdown(b); expect(md).toMatch(/## Questions/);

    await S.editBrief(db, WS1, owner, m.id, { ideal: "Confirmed requirement brief by Friday" });
    await S.markReviewed(db, WS1, owner, m.id);
    expect((await db.from("meeting_brief_version").select("version").eq("prep_id", m.id)).data!.length).toBe(2);

    await S.addNote(db, WS1, owner, m.id, "note", "They need about 250 seats, move in 2027-06-01.");
    await S.addNote(db, WS1, owner, m.id, "commitment", "We will send three options in Kharadi");
    const o = await S.structureOutcome(db, WS1, owner, m.id, "Good meeting.", noAi);
    expect(o.requirement_updates.find((u) => u.field === "seats_target")!.value).toBe("250");
    const r = await S.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: false });
    expect(r.proposals).toBe(1); expect(r.tasks).toBe(1); expect(r.interaction).toBeTruthy();
    expect((await db.from("requirement").select("seats_target").eq("id", req).single()).data!.seats_target).toBeNull();   // proposal, not overwrite
    await expect(S.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: false })).rejects.toThrow(/Already/);
    expect((await db.from("meeting_prep").select("status").eq("id", m.id).single()).data!.status).toBe("completed");
  });

  it("first meeting with no company and no history; reschedule and cancel; .ics import with duplicate", async () => {
    const m = await S.createMeeting(db, WS1, owner, { title: "Intro coffee", start: new Date(Date.now() + 864e5).toISOString(), external: [{ name: "Someone" }] });
    await S.generateBrief(db, WS1, owner, m.id, noAi);
    const { data: p } = await db.from("meeting_prep").select("brief, readiness").eq("id", m.id).single();
    expect(p!.brief.history.first).toBe(true);
    expect(p!.brief.company.unknowns).toContain("Company not linked");
    await S.reschedule(db, WS1, m.id, new Date(Date.now() + 5 * 864e5).toISOString());
    expect((await db.from("meeting_prep").select("status").eq("id", m.id).single()).data!.status).toBe("rescheduled");
    await S.cancelMeeting(db, WS1, m.id);
    expect((await db.from("meeting_prep").select("status, meeting:meeting_visit_id(status)").eq("id", m.id).single()).data).toMatchObject({ status: "cancelled", meeting: { status: "cancelled" } });
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${t}-1\nSUMMARY:Site visit Kharadi ${t}\nDTSTART:20991201T103000\nATTENDEE;CN=Rahul:mailto:rahul@vn-${t}.example\nEND:VEVENT\nEND:VCALENDAR`;
    const a = await S.importIcs(db, WS1, owner, ics); const b = await S.importIcs(db, WS1, owner, ics);
    expect(a.created).toBe(1); expect(b.skipped).toBe(1);
    const { data: imp } = await db.from("meeting_prep").select("meeting_type, org_id, source").eq("id", a.ids[0]).single();
    expect(imp).toMatchObject({ meeting_type: "site_visit", org_id: org, source: "ics_import" });
    const sync = await S.syncFromCalendar(db, WS1, owner);
    expect(sync.error).toBeNull();
  });

  it("isolation", async () => {
    const o = await userClient("other");
    expect((await o.from("meeting_prep").select("id").eq("org_id", org)).data ?? []).toHaveLength(0);
  });
});

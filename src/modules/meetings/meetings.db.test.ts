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

describe("Module 7 — gaps: auto-brief, today, feedback, uploads, deeper analysis, wider proposals, follow-up pack, reports", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("mq");
  let org: string; let pid: string; let req: string; let opp: string; let kharadi: string; let baner: string;
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Zentrix ${t}`, sector: "SaaS" }).select("id").single()).data!.id;
    pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Priya Shah ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: org, title: "Admin Manager", is_current: true });
    req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: org, title: `Zentrix Pune ${t}`, objective: "expansion", status: "draft" }).select("id").single()).data!.id;
    opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: org, requirement_id: req, name: `Zentrix opp ${t}`, stage: "engaged" }).select("id").single()).data!.id;
    kharadi = (await db.from("asset").insert({ workspace_id: WS1, name: `Kharadi Tower ${t}`, owner_user_id: owner }).select("id").single()).data!.id;
    baner = (await db.from("asset").insert({ workspace_id: WS1, name: `Baner Square ${t}`, owner_user_id: owner }).select("id").single()).data!.id;
  });

  it("auto-generates the brief ~1h before, once per start, again after a reschedule", async () => {
    const { autoBriefs } = await import("./more");
    const m = await S.createMeeting(db, WS1, owner, { title: `Auto ${t}`, start: new Date(Date.now() + 65 * 6e4).toISOString(), orgId: org });
    const far = await S.createMeeting(db, WS1, owner, { title: `Far ${t}`, start: new Date(Date.now() + 5 * 3600e3).toISOString(), orgId: org });
    const a = await autoBriefs(db, WS1, new Date(), noAi);
    expect(a.generated).toBeGreaterThanOrEqual(1);
    expect((await db.from("meeting_prep").select("brief_version").eq("id", m.id).single()).data!.brief_version).toBe(1);
    expect((await db.from("meeting_prep").select("brief_version").eq("id", far.id).single()).data!.brief_version).toBe(0);
    await autoBriefs(db, WS1, new Date(), noAi);
    expect((await db.from("meeting_prep").select("brief_version").eq("id", m.id).single()).data!.brief_version).toBe(1);   // idempotent
    await S.reschedule(db, WS1, m.id, new Date(Date.now() + 70 * 6e4).toISOString());
    await autoBriefs(db, WS1, new Date(), noAi);
    expect((await db.from("meeting_prep").select("brief_version, status").eq("id", m.id).single()).data).toMatchObject({ brief_version: 2, status: "brief_ready" });
    const { todayView } = await import("./more");
    const v = await todayView(db, WS1);
    const sorted = v.meetings.map((x) => x.start); expect(sorted).toEqual([...sorted].sort());
    await S.cancelMeeting(db, WS1, m.id); await S.cancelMeeting(db, WS1, far.id);
  });

  it("site-visit feedback per property; rejection must be explicit; uploads validated", async () => {
    const M = await import("./more");
    const m = await S.createMeeting(db, WS1, owner, { title: `Visit ${t}`, start: new Date(Date.now() - 3600e3).toISOString(), type: "site_visit", orgId: org, assetIds: [kharadi, baner], personIds: [pid] });
    await expect(M.saveFeedback(db, WS1, owner, m.id, baner, { interest: "rejected" })).rejects.toThrow(/clearly rejected/);
    await M.saveFeedback(db, WS1, owner, m.id, baner, { overall: 2, interest: "rejected", explicit_rejection: true, parking: "Only 40 car parks" });
    await M.saveFeedback(db, WS1, owner, m.id, kharadi, { overall: 4, interest: "interested", location: "Close to metro" });
    await M.saveFeedback(db, WS1, owner, m.id, kharadi, { overall: 5, interest: "interested" });                     // upsert, no duplicate
    expect((await db.from("meeting_property_feedback").select("id").eq("prep_id", m.id)).data).toHaveLength(2);
    const x = await S.gather(db, WS1, m.id);
    expect(x.properties.find((p) => p.id === kharadi)!.feedback).toMatchObject({ overall: 5 });
    await expect(M.addUploadedMaterial(db, WS1, owner, m.id, { title: "x", path: `${WS1}/other/x.pdf`, mime: "application/pdf" })).rejects.toThrow(/belong/);
    await expect(M.addUploadedMaterial(db, WS1, owner, m.id, { title: "x", path: `${WS1}/meetings/${m.id}/a.exe`, mime: "application/x-msdownload" })).rejects.toThrow(/photos/);
    const mid = await M.addUploadedMaterial(db, WS1, owner, m.id, { title: "", path: `${WS1}/meetings/${m.id}/11111111-1111-1111-1111-111111111111-plan.pdf`, mime: "application/pdf" });
    const { data: mat } = await db.from("meeting_material").select("title, internal_only, storage_object, mime").eq("id", mid).single();
    expect(mat).toMatchObject({ title: "plan.pdf", internal_only: true, storage_object: true, mime: "application/pdf" });
  });

  it("Hinglish notes → deeper analysis, clarifications before apply, wider proposals, follow-up pack, reports", async () => {
    const M = await import("./more");
    const m = await S.createMeeting(db, WS1, owner, { title: `Hinglish visit ${t}`, start: new Date(Date.now() - 2 * 3600e3).toISOString(), type: "site_visit", orgId: org, opportunityId: opp, requirementId: req, assetIds: [kharadi, baner], personIds: [pid] });
    await M.saveFeedback(db, WS1, owner, m.id, baner, { overall: 2, interest: "maybe", pricing: "Thoda mehenga" });
    const note = [
      "Unko 300 seats chahiye, agle hafte final karenge.",
      "Kharadi wala building bahut pasand aaya, shortlist mein daalo.",
      "Budget ke baare mein abhi pata nahi.",
      `Priya ka naya number 9876543210 hai.`,
      "Rakesh Kumar from finance bhi decision mein hoga.",
      "We will send the Kharadi floor plans by Friday.",
    ].join("\n");
    const o = await S.structureOutcome(db, WS1, owner, m.id, note, noAi);
    expect(o.requirement_updates.find((u) => u.field === "seats_target")!.value).toBe("300");
    expect(o.per_property_interest.find((p) => p.property.startsWith("Kharadi"))!.interest).toBe("interested");
    expect(o.per_property_interest.find((p) => p.property.startsWith("Baner"))).toMatchObject({ interest: "maybe", basis: "statement" });   // general feedback, not a rejection
    expect(o.buying_signals.some((b) => b.basis === "statement" && /shortlist/.test(b.quote ?? ""))).toBe(true);
    expect(o.unresolved_questions.length).toBeGreaterThan(0);
    expect(o.clarifications_needed.map((c) => c.about).sort()).toEqual(["amount", "date"]);
    expect(o.contact_updates).toEqual([expect.objectContaining({ field: "phone", value: "9876543210" })]);
    expect(o.new_stakeholders).toEqual([expect.objectContaining({ name: "Rakesh Kumar", role: "finance" })]);

    await expect(S.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: false })).rejects.toThrow(/clarification/);
    await S.answerClarifications(db, WS1, m.id, { "0": "2026-11-20", "1": "₹85/sf" });
    const r = await S.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: false, contacts: true, stakeholders: true, nextActionDate: "2026-11-20", assigneeUserId: owner });
    expect(r.proposals).toBe(4);           // requirement + opportunity next action + phone + new stakeholder person
    expect(r.tasks).toBe(1);
    expect((await db.from("contact_method").select("id").eq("person_id", pid).eq("value", "9876543210")).data).toHaveLength(0);   // proposal only
    const { data: cps } = await db.from("change_proposal").select("target_type").like("idempotency_key", `meeting:${m.id}:%`);
    expect(cps!.map((c) => c.target_type).sort()).toEqual(["contact_method", "opportunity", "person", "requirement"]);

    const agenda = await M.nextAgenda(db, WS1, owner, m.id); await M.nextAgenda(db, WS1, owner, m.id);
    expect(agenda).toMatch(/^Agenda/);
    expect((await db.from("meeting_note").select("id").eq("prep_id", m.id).like("text", "Agenda%")).data).toHaveLength(1);
    const md = await M.meetingReportMarkdown(db, WS1, m.id);
    expect(md).toMatch(/## Buying signals/); expect(md).toMatch(/Baner Square .*negative|maybe/);

    const fu = await M.pendingFollowups(db, WS1);
    expect(fu.find((f) => f.id === m.id)!.tasks).toHaveLength(2);       // our commitment + "add stakeholder after approval"
    const rep = await M.meetingReports(db, WS1);
    expect(rep.byCompany.find((c) => c.key === org)!.count).toBeGreaterThanOrEqual(2);
    expect(rep.rates.every((x) => / of \d+/.test(x.value))).toBe(true);
    expect(rep.byProperty.some((p) => p.key === kharadi)).toBe(true);
  });
});

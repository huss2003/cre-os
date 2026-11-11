// Journey STAGE 6 — Module 7 Meeting Intelligence (TEST_PLAN 7.1–7.9). Service level, WS1 as owner, mock AI only.
// Verifies brief completeness, discovery questions, notes → structured outcome (facts vs interpretation, commitments),
// approval-gated requirement updates, follow-up draft via Module 5 (no send), and site-visit feedback.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { userClient, WS1, tag } from "../helpers";
import * as S from "@/modules/meetings/service";
import * as M from "@/modules/meetings/more";
import { approveAndApply } from "@/modules/changes/service";

type Row = Record<string, any>;
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const NOTES = "Client expects approximately 25,000 SF in Kharadi. They are targeting occupancy within nine months. Their preferred lease tenure is five years. Budget is not yet confirmed. Finance approval is required. They are also evaluating whether to renew their existing office.";

describe("STAGE 6 — Meeting Intelligence (ABC Technologies)", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("j7");
  let abc: string; let rahul: string; let priya: string; let opp: string; let req: string; let propA: string; let propB: string;
  let prep: string; let start: string;

  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    abc = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `ABC Technologies Pvt. Ltd. ${t}`, sector: "Information Technology", domain: `abc-${t}.example` }).select("id").single()).data!.id;
    const mk = async (name: string, title: string) => {
      const id = (await db.from("person").insert({ workspace_id: WS1, full_name: `${name} ${t}` }).select("id").single()).data!.id;
      await db.from("employment").insert({ workspace_id: WS1, person_id: id, org_id: abc, title, is_current: true });
      return id;
    };
    rahul = await mk("Rahul Sharma", "Head of Administration"); priya = await mk("Priya Mehta", "Head of Finance"); await mk("Amit Verma", "Head of HR");
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: rahul, method_type: "email", value: `rahul@abc-${t}.example`, verify_status: "likely_valid" });
    await db.from("contact_role_assessment").insert({ workspace_id: WS1, person_id: rahul, org_id: abc, role_class: "technical_evaluator", cre_relevance: "high", active: true, source: "test" });
    await db.from("signal").insert({ workspace_id: WS1, category: "expansion", kind: "pune_expansion", title: `ABC Technologies ${t} plans Pune expansion`, org_id: abc, verification: "inference", confidence: "medium", dedupe_key: `j7:${t}` });
    req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: abc, title: `ABC Pune office ${t}`, objective: "expansion", status: "draft" }).select("id").single()).data!.id;
    opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: abc, requirement_id: req, name: `ABC Pune ${t}`, stage: "engaged" }).select("id").single()).data!.id;
    const i = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: "2026-11-05T10:00:00Z", channel: "email", direction: "inbound", summary: "Please share some available office options in Kharadi.", promises: [{ who: "us", what: "Send Kharadi options" }], is_meaningful: true, owner_user_id: owner }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: rahul, role: "from" });
    propA = (await db.from("asset").insert({ workspace_id: WS1, name: `Property A ${t}`, address: "Kharadi, Pune" }).select("id").single()).data!.id;
    propB = (await db.from("asset").insert({ workspace_id: WS1, name: `Property B ${t}`, address: "Kharadi, Pune" }).select("id").single()).data!.id;
  });

  it("7.1 creates a meeting with Rahul linked to company and opportunity; shows on the dashboard", async () => {
    start = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) + "T05:30:00.000Z";   // 11:00 IST
    const m = await S.createMeeting(db, WS1, owner, { title: `ABC requirement discussion ${t}`, start, location: "ABC office, Kharadi", type: "requirement", orgId: abc, opportunityId: opp, requirementId: req, personIds: [rahul], assetIds: [propA] });
    prep = m.id;
    const { data: p } = await db.from("meeting_prep").select("org_id, opportunity_id, meeting:meeting_visit_id(start_at, location, opportunity_id, linked_entity_id), meeting_prep_attendee(person_id)").eq("id", prep).single();
    expect.soft(p!.org_id).toBe(abc);
    expect.soft(p!.opportunity_id).toBe(opp);
    expect.soft((p!.meeting as Row).location).toBe("ABC office, Kharadi");
    expect.soft((p!.meeting as Row).opportunity_id).toBe(opp);
    expect.soft((p!.meeting_prep_attendee as Row[]).map((a) => a.person_id)).toEqual([rahul]);
    const tv = await M.todayView(db, WS1, new Date(start));
    expect(tv.meetings.map((x) => x.id)).toContain(prep);
  });

  it("7.2 meeting brief covers background, attendees, history, requirement, signals, commitments, objective, questions, objections, decisions", async () => {
    await S.generateBrief(db, WS1, owner, prep, noAi);
    const b = (await db.from("meeting_prep").select("brief").eq("id", prep).single()).data!.brief;
    expect.soft(b.company.items.length).toBeGreaterThan(0);                                   // company background
    expect.soft(b.attendees[0].name).toMatch(/Rahul Sharma/);                                  // attendee details
    expect.soft(b.history.first).toBe(false);                                                  // previous interactions
    expect.soft(b.opportunity.requirement.title).toMatch(/ABC Pune office/);                   // existing requirement
    expect.soft(b.company.items.some((x: Row) => x.source?.type === "signal" && x.kind === "inference")).toBe(true);   // research signals, labelled
    expect.soft(b.history.commitments.map((c: Row) => c.text).join(" ")).toMatch(/Kharadi options/);                // previous commitments
    expect.soft(b.purpose.we_want).toBeTruthy();                                               // suggested objective
    expect.soft(b.questions.essential.length).toBe(5);                                         // discovery questions
    expect.soft(b.objections.length).toBeGreaterThan(0);                                       // potential objections
    expect(b.strategy.find((s: Row) => s.stage === "closing")?.obtain ?? b.outcome?.ideal, "decisions to obtain").toBeTruthy();
  });

  it("7.3 discovery questions cover area, capacity, location, budget, timeline, tenure, existing lease, decision-makers, approval, technical, operational", async () => {
    const b = (await db.from("meeting_prep").select("brief").eq("id", prep).single()).data!.brief;
    const qs = [...b.questions.essential, ...b.questions.additional, ...b.questions.strategic].map((q: Row) => q.text).join(" | ");
    const topics: [string, RegExp][] = [["area", /area/i], ["capacity", /seat|capacity|headcount/i], ["location", /micro-market|location/i], ["budget", /rental range|budget/i], ["timeline", /move-in|occupancy/i],
      ["tenure", /lease length|tenure|lock-in/i], ["existing lease", /current lease|leases expire/i], ["decision-makers", /who else|involved/i], ["approval", /approval/i], ["technical", /technical|power|IT|server|infrastructure/], ["operational", /operational|parking|operations/i]];
    const missing = topics.filter(([, re]) => !re.test(qs)).map(([k]) => k);
    expect(missing, `topics missing from the brief's questions: ${qs}`).toEqual([]);
  });

  it("7.4 notes → summary, extracted requirement, budget missing, finance approval, renew-vs-relocate decision; originals kept", async () => {
    await S.addNote(db, WS1, owner, prep, "note", NOTES);
    const o = await S.structureOutcome(db, WS1, owner, prep, "", noAi);
    expect.soft(o.summary).toBeTruthy();
    expect.soft(o.requirement_updates.find((u) => u.field === "area_target_sf")?.value).toBe("25000");
    expect.soft(o.clarifications_needed.some((c) => c.about === "amount" && /budget/i.test(c.question))).toBe(true);          // budget missing
    const notesKept = (await db.from("meeting_note").select("text").eq("prep_id", prep)).data!.map((n) => n.text);
    expect.soft(notesKept).toContain(NOTES);                                                                                  // original notes available
    expect.soft(o.decision_process ?? o.new_stakeholders.map((s) => s.role).join() ?? "", "finance approval as stakeholder requirement").toMatch(/finance/i);
    expect.soft([...o.unresolved_questions, ...o.risks].map((x) => x.text).join(" "), "renewal vs relocation decision").toMatch(/renew/i);
    expect.soft(o.requirement_updates.map((u) => u.field), "timeline (nine months) extracted").toContain("occupation_date");
    expect(JSON.stringify({ r: o.requirement_updates, t: o.topics, u: o.unresolved_questions }), "tenure five years captured as structured data").toMatch(/five years|5 years|60 months|tenure/i);
  });

  it("7.5 'Property A is expensive' is recorded as an objection, not a rejection; asks to clarify commercial range", async () => {
    await S.addNote(db, WS1, owner, prep, "feedback", `Rahul said Property A ${t} is expensive.`);
    const o = await S.structureOutcome(db, WS1, owner, prep, "", noAi);
    const a = o.per_property_interest.find((p) => p.property === `Property A ${t}`);
    expect.soft(a?.interest).not.toBe("rejected");
    expect.soft([...o.risks.map((r) => r.text), ...o.objections].join(" ")).toMatch(/expensive/i);
    expect.soft(o.risks.find((r) => /expensive/.test(r.text))?.basis).toBe("statement");                   // what Rahul said = fact
    expect(o.clarifications_needed.map((c) => c.question).join(" ") + o.unresolved_questions.map((u) => u.text).join(" "), "need to clarify acceptable commercial range").toMatch(/range|budget|rent|commercial/i);
  });

  it("7.6 extracts two commitments with owners and deadlines; proposes tasks", async () => {
    await S.addNote(db, WS1, owner, prep, "commitment", "Rahul will share the approved budget by Friday. We will share three suitable properties by Wednesday.");
    const o = await S.structureOutcome(db, WS1, owner, prep, "", noAi);
    const c = o.commitments.filter((x) => /budget by Friday|three suitable properties/i.test(x.what));
    expect.soft(c).toHaveLength(2);
    expect.soft(c.find((x) => /budget/.test(x.what))?.who, "Rahul's commitment owned by them").toBe("them");
    expect.soft(c.find((x) => /three suitable/.test(x.what))?.who).toBe("us");
    expect(c.map((x) => x.due), "deadlines captured").not.toContain(null);
  });

  it("7.7 approving extracted updates updates the requirement, keeps history, links meeting, missing stays missing", async () => {
    const p = (await db.from("meeting_prep").select("outcome").eq("id", prep).single()).data!;
    const open = S.openClarifications(p.outcome);
    await S.answerClarifications(db, WS1, prep, Object.fromEntries(open.map((q) => [String(q.i), "Not confirmed yet"])));
    const r = await S.applyOutcome(db, WS1, owner, prep, { requirement: true, tasks: true, interaction: true, followupDraft: true });
    expect.soft(r.tasks).toBeGreaterThan(0);
    expect.soft(r.interaction).toBeTruthy();
    const { data: prop } = await db.from("change_proposal").select("id, state, reason").eq("workspace_id", WS1).eq("target_id", req).eq("idempotency_key", `meeting:${prep}:req`).single();
    expect.soft(prop!.state).toBe("proposed");                                                          // nothing overwritten before approval
    expect.soft(prop!.reason).toMatch(/ABC requirement discussion/);                                      // linked to meeting
    await approveAndApply(db, prop!.id, { actorUserId: owner, note: "journey 7.7" });
    const rq = (await db.from("requirement").select("area_target_sf, budget_max, row_version").eq("id", req).single()).data!;
    expect.soft(Number(rq.area_target_sf)).toBe(25000);
    expect.soft(rq.budget_max).toBeNull();                                                               // missing stays missing
    const { data: aud } = await db.from("audit_event").select("before, after").eq("workspace_id", WS1).eq("entity_id", req).order("id", { ascending: false }).limit(5);
    expect((aud ?? []).some((a: Row) => a.before && "area_target_sf" in a.before), "historical value preserved in audit").toBe(true);
  });

  it("7.8 follow-up email uses the meeting summary and commitments; is a Module 5 draft, not sent", async () => {
    const p = (await db.from("meeting_prep").select("outcome").eq("id", prep).single()).data!;
    const draftItem = p.outcome.applied.draft;
    expect(draftItem, "follow-up draft created in Outreach").toBeTruthy();
    const it = (await db.from("outreach_item").select("*, draft:draft_id(*)").eq("id", draftItem).single()).data!;
    expect.soft(it.channel).toBe("meeting_followup");
    expect.soft(it.status).toBe("draft");
    expect.soft(it.sent_at).toBeNull();
    expect.soft(it.draft.state).toBe("drafted");
    expect.soft(it.draft.body, "next steps included").toMatch(/next step/i);
    expect(it.draft.body, "meeting summary + commitments used (not placeholders)").toMatch(/25,?000|three suitable properties|budget by Friday/i);
  });

  it("7.9 site-visit feedback linked to property; location +, parking and rent concerns; not rejected; usable by Module 8", async () => {
    const v = await S.createMeeting(db, WS1, owner, { title: `Site visit Property A ${t}`, start: new Date(Date.now() + 4 * 864e5).toISOString(), type: "site_visit", orgId: abc, opportunityId: opp, requirementId: req, personIds: [rahul], assetIds: [propA, propB] });
    const f = await M.saveFeedback(db, WS1, owner, v.id, propA, { overall: 3, interest: "maybe", location: "Client liked the location", parking: "Parking provision was insufficient", pricing: "Rent is above the preferred range" });
    expect.soft(f.interest).not.toBe("rejected");
    await expect(M.saveFeedback(db, WS1, owner, v.id, propA, { interest: "rejected" })).rejects.toThrow(/clearly rejected/);
    const { data: row } = await db.from("meeting_property_feedback").select("asset_id, fields").eq("prep_id", v.id).single();
    expect.soft(row!.asset_id).toBe(propA);
    expect.soft(row!.fields).toMatchObject({ location: expect.stringMatching(/liked/), parking: expect.stringMatching(/insufficient/), pricing: expect.stringMatching(/above/) });
    // Free-text entry as in the plan: the mock must not reject and should flag the concerns.
    await S.addNote(db, WS1, owner, v.id, "feedback", `Property A ${t}: Client liked the location but felt the parking provision was insufficient. Rent is also above the preferred range.`);
    const o = await S.structureOutcome(db, WS1, owner, v.id, "", noAi);
    expect.soft(o.per_property_interest.find((p) => p.property === `Property A ${t}`)?.interest).not.toBe("rejected");
    // Module 8 (toolkit comparison) must be able to read this feedback.
    const toolkit = fs.readdirSync(path.resolve("src/modules/toolkit"), { recursive: true }).filter((x) => String(x).endsWith(".ts")).map((x) => fs.readFileSync(path.resolve("src/modules/toolkit", String(x)), "utf8")).join("\n");
    expect(/meeting_property_feedback/.test(toolkit), "Module 8 (src/modules/toolkit) reads meeting_property_feedback").toBe(true);
  });
});

// Workflows round 2: reply → meeting, job change → re-engagement, visit feedback → comparison, meeting completed.
// Runs against the local stack as the seeded owner (RLS enforced). Fixtures are tagged; nothing is deleted.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, USERS, tag } from "../../../tests/helpers";
import { runReplyChain, runEmployerChain, runFeedbackChain, runMeetingChain } from "./events";
import { parseSettings, optionStatusFromFeedback, feedbackScore, priorRelationship, replyWantsMeeting } from "./rules";
import { createOutreach, recordResponse } from "@/modules/outreach/service";
import { createMeeting, addNote, structureOutcome, applyOutcome } from "@/modules/meetings/service";
import { saveFeedback } from "@/modules/meetings/more";
import { runComparison } from "@/modules/toolkit/comparison";
import { proposePersonMove, approveAndApply } from "@/modules/changes/service";

const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
type Db = Awaited<ReturnType<typeof userClient>>;
type Row = Record<string, any>;
const ME = USERS.owner.id;
const future = (days: number) => new Date(Date.now() + days * 864e5).toISOString();
const steps = async (db: Db, runId: string) => Object.fromEntries(((await db.from("workflow_step").select("step_key, status, reason, output_refs").eq("run_id", runId)).data ?? []).map((s: Row) => [s.step_key, s]));
async function nothingSent(db: Db, personId: string) {
  const items = (await db.from("outreach_item").select("sent_at").eq("workspace_id", WS1).eq("person_id", personId)).data ?? [];
  expect(items.every((i: Row) => i.sent_at === null)).toBe(true);
  const drafts = (await db.from("draft").select("state, marked_sent_at, approved_at").eq("workspace_id", WS1).eq("recipient_person_id", personId)).data ?? [];
  for (const d of drafts) { expect(d.marked_sent_at).toBeNull(); expect(d.approved_at).toBeNull(); expect(d.state).not.toMatch(/sent/); }
}
async function org(db: Db, name: string) {
  return (await db.from("organisation").insert({ workspace_id: WS1, display_name: name, sector: "Technology" }).select("id").single()).data!.id as string;
}
async function person(db: Db, name: string, orgId: string, o: { dnc?: boolean; met?: boolean } = {}) {
  const pid = (await db.from("person").insert({ workspace_id: WS1, full_name: name, do_not_contact: !!o.dnc }).select("id").single()).data!.id as string;
  await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: orgId, title: "Head of Admin", is_current: true });
  await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "email", value: `${name.replace(/\W/g, "").toLowerCase()}@example.com`, verify_status: "verified" });
  if (o.met) {
    const i = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: future(-90), channel: "meeting", direction: "internal", subject: "Old-employer lease review CONFIDENTIAL", summary: "Discussed confidential rent of 123/sf", is_meaningful: true }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: pid, role: "participant" });
  }
  return pid;
}

describe("round 2 rules", () => {
  it("toggles default on; feedback and relationship rules", () => {
    const s = parseSettings(null);
    for (const k of ["reply_chain", "employer_chain", "feedback_chain", "meeting_chain", "signal_chain", "lease_chain"]) expect((s as Row)[k]).toBe(true);
    expect(parseSettings({ feedback_chain: false }).feedback_chain).toBe(false);
    expect(optionStatusFromFeedback({ interest: "maybe" }, "shortlisted")).toEqual({ status: "visited", rejected: false });
    expect(optionStatusFromFeedback({ interest: "rejected", explicit_rejection: false }, "shortlisted").rejected).toBe(false);
    expect(optionStatusFromFeedback({ interest: "rejected", explicit_rejection: true }, "visited")).toEqual({ status: "rejected", rejected: true });
    expect(optionStatusFromFeedback({ interest: "interested" }, "selected").status).toBeNull();
    expect(feedbackScore(null)).toBeUndefined(); expect(feedbackScore(3)).toBe(0.5); expect(feedbackScore(1)).toBe(0);
    expect(priorRelationship("not_interacted", 0).prior).toBe(false);
    expect(priorRelationship("not_interacted", 1).prior).toBe(true);
    expect(priorRelationship("met_once", 0).prior).toBe(true);
    expect(replyWantsMeeting({ status: "replied", response: { outcome: "info_requested" } })).toBe(false);
    expect(replyWantsMeeting({ status: "meeting" })).toBe(true);
  });
});

describe("reply → meeting", () => {
  let db: Db; const t = tag("wfr");
  beforeAll(async () => { db = await userClient("owner"); });

  it("no time known: 'to schedule' task, follow-up paused, next action proposed, prep skipped; idempotent; nothing sent", async () => {
    const o = await org(db, `Replyco ${t}`);
    const p = await person(db, `Ravi Shah ${t}`, o);
    const opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: o, name: `Opp ${t}` }).select("id").single()).data!.id;
    const first = await createOutreach(db, WS1, ME, { personId: p, channels: ["email"], scenario: "reconnect", opportunityId: opp, ai: noAi });
    await recordResponse(db, WS1, ME, first.ids[0], "Sure, happy to meet and discuss.", noAi);
    const later = await createOutreach(db, WS1, ME, { personId: p, channels: ["linkedin"], scenario: "reconnect", ai: noAi }); // a stray follow-up
    const r = await runReplyChain(db, WS1, first.ids[0]);
    expect(r?.status).toBe("done");
    const s = await steps(db, r!.runId);
    expect(s.meeting.status).toBe("done"); expect(s.meeting.reason).toMatch(/to schedule/); expect(s.meeting.output_refs[0].type).toBe("task");
    expect(s.followups.status).toBe("done");
    expect((await db.from("outreach_item").select("status").eq("id", later.ids[0]).single()).data!.status).toBe("paused");
    expect(s.opportunity.status).toBe("done");
    const cp = s.opportunity.output_refs.find((x: Row) => x.type === "change_proposal");
    expect((await db.from("change_proposal").select("patch").eq("id", cp.id).single()).data!.patch[0].value).toMatch(/Schedule meeting/);
    expect(s.prep.status).toBe("skipped");
    expect((await db.from("meeting_visit").select("id").eq("workspace_id", WS1).eq("linked_entity_id", o)).data).toHaveLength(0); // no invented time
    expect(await runReplyChain(db, WS1, first.ids[0])).toBeNull();
    expect((await db.from("task").select("id").eq("workspace_id", WS1).eq("idempotency_key", `workflows:reply:${first.ids[0]}:schedule`)).data).toHaveLength(1);
    await nothingSent(db, p);
  }, 60_000);

  it("existing meeting: linked, prep queued; no opportunity → skipped with reason", async () => {
    const o = await org(db, `Meetco ${t}`);
    const p = await person(db, `Meera Iyer ${t}`, o);
    const m = await createMeeting(db, WS1, ME, { title: `Intro ${t}`, start: future(3), orgId: o, personIds: [p] });
    const it = await createOutreach(db, WS1, ME, { personId: p, channels: ["email"], scenario: "reconnect", ai: noAi });
    await recordResponse(db, WS1, ME, it.ids[0], "Yes let's meet on Tuesday.", noAi);
    const r = await runReplyChain(db, WS1, it.ids[0]);
    const s = await steps(db, r!.runId);
    expect(s.meeting.output_refs[0]).toMatchObject({ type: "meeting_prep", id: m.id });
    expect(s.prep.status).toBe("done");
    expect(s.opportunity.status).toBe("skipped"); expect(s.opportunity.reason).toMatch(/No opportunity/);
    await nothingSent(db, p);
  }, 60_000);

  it("a reply that doesn't ask for a meeting starts no run", async () => {
    const o = await org(db, `Infoco ${t}`);
    const p = await person(db, `Ira Das ${t}`, o);
    const it = await createOutreach(db, WS1, ME, { personId: p, channels: ["email"], scenario: "reconnect", ai: noAi });
    await recordResponse(db, WS1, ME, it.ids[0], "Please send the brochure details.", noAi);
    expect(await runReplyChain(db, WS1, it.ids[0])).toBeNull();
  }, 60_000);
});

describe("job change → re-engagement", () => {
  let db: Db; const t = tag("wfg");
  beforeAll(async () => { db = await userClient("owner"); });
  async function move(name: string, o: { dnc?: boolean; met?: boolean }) {
    const oldOrg = await org(db, `OldCo ${name} ${t}`); const newOrg = await org(db, `NewCo ${name} ${t}`);
    const p = await person(db, `${name} ${t}`, oldOrg, o);
    for (const pr of await proposePersonMove(db, WS1, { personId: p, newOrgId: newOrg, title: "VP Workplace", reason: "test move", actorUserId: ME } as never)) await approveAndApply(db, pr.id);
    const emp = (await db.from("employment").select("id").eq("person_id", p).eq("org_id", newOrg).eq("is_current", true).single()).data!.id as string;
    return { p, oldOrg, newOrg, emp };
  }

  it("prior relationship: history kept, signals + scores, ONE draft without old-employer content; idempotent; nothing sent", async () => {
    const { p, emp, oldOrg } = await move("Kabir", { met: true });
    const r = await runEmployerChain(db, WS1, emp, { ai: noAi });
    const s = await steps(db, r!.runId);
    expect(s.history.status).toBe("done"); expect(s.history.reason).toMatch(/OldCo/);
    expect((await db.from("employment").select("is_current").eq("person_id", p).eq("org_id", oldOrg).single()).data!.is_current).toBe(false);
    expect(s.company.status).toBe("done"); expect(s.signals.status).toBe("done"); expect(s.scores.status).toBe("done");
    expect(s.draft.status, s.draft.reason).toBe("done");
    const drafts = (await db.from("draft").select("id, body, subject, purpose").eq("recipient_person_id", p)).data!;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].purpose).toBe("job_move_reconnect");
    expect(`${drafts[0].subject} ${drafts[0].body}`).not.toMatch(/OldCo|CONFIDENTIAL|123/);
    expect(await runEmployerChain(db, WS1, emp, { ai: noAi })).toBeNull();
    expect((await db.from("draft").select("id").eq("recipient_person_id", p)).data).toHaveLength(1);
    await nothingSent(db, p);
  }, 60_000);

  it("no prior relationship / do-not-contact: draft skipped with reasons", async () => {
    const cold = await move("Nina", {});
    const s1 = await steps(db, (await runEmployerChain(db, WS1, cold.emp, { ai: noAi }))!.runId);
    expect(s1.draft.status).toBe("skipped"); expect(s1.draft.reason).toMatch(/No prior relationship/);
    const dnc = await move("Omar", { met: true, dnc: true });
    const s2 = await steps(db, (await runEmployerChain(db, WS1, dnc.emp, { ai: noAi }))!.runId);
    expect(s2.draft.status).toBe("skipped"); expect(s2.draft.reason).toMatch(/do-not-contact/);
    expect((await db.from("draft").select("id").in("recipient_person_id", [cold.p, dnc.p])).data).toHaveLength(0);
  }, 60_000);

  it("first employment is not a move: no run", async () => {
    const o = await org(db, `Solo ${t}`);
    const p = await person(db, `Solo ${t}`, o);
    const emp = (await db.from("employment").select("id").eq("person_id", p).single()).data!.id;
    expect(await runEmployerChain(db, WS1, emp)).toBeNull();
  });
});

describe("visit feedback → comparison", () => {
  let db: Db; const t = tag("wfe");
  let o: string; let req: string; let a1: string; let a2: string; let a3: string; let prep: string; let analysis: string; const opts: Record<string, string> = {};
  beforeAll(async () => {
    db = await userClient("owner");
    o = await org(db, `Visitco ${t}`);
    req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: o, title: `Req ${t}`, area_target_sf: 10000, area_basis: "chargeable" }).select("id").single()).data!.id;
    const mk = async (n: string, rent: number) => {
      const a = (await db.from("asset").insert({ workspace_id: WS1, name: `${n} ${t}`, grade: "A", specs: {} }).select("id").single()).data!.id as string;
      const sp = (await db.from("space").insert({ workspace_id: WS1, asset_id: a, chargeable_sf: 10000 }).select("id").single()).data!.id;
      await db.from("availability").insert({ workspace_id: WS1, space_id: sp, as_of: new Date().toISOString().slice(0, 10), status: "available", asking_rent_min: rent, rent_basis: "chargeable", fact_status: "currently_confirmed" });
      return a;
    };
    a1 = await mk("Alpha", 90); a2 = await mk("Beta", 80); a3 = await mk("Gamma", 85);
    for (const a of [a1, a2]) opts[a] = (await db.from("shortlist_option").insert({ workspace_id: WS1, requirement_id: req, asset_id: a, version: 1, eligible: true, rubric_version: "match-v1", option_status: "shortlisted" }).select("id").single()).data!.id;
    analysis = (await runComparison(db, WS1, ME, { title: `Cmp ${t}`, requirementId: req, assetIds: [a1, a2], manual: [] })).id;
    prep = (await createMeeting(db, WS1, ME, { title: `Site visit ${t}`, start: future(-1), type: "site_visit", orgId: o, requirementId: req, assetIds: [a1, a2, a3] })).id;
  }, 60_000);

  it("'rent is high' → visited (not rejected); comparison re-run as new version; one review task; idempotent", async () => {
    await saveFeedback(db, WS1, ME, prep, a1, { overall: 2, interest: "maybe", pricing: "Rent is high" });
    const fb = (await db.from("meeting_property_feedback").select("id").eq("prep_id", prep).eq("asset_id", a1).single()).data!.id;
    const r = await runFeedbackChain(db, WS1, fb);
    const s = await steps(db, r!.runId);
    expect(s.option.status).toBe("done"); expect(s.option.reason).toMatch(/not a rejection/);
    expect((await db.from("shortlist_option").select("option_status").eq("id", opts[a1]).single()).data!.option_status).toBe("visited");
    expect(s.comparison.status, s.comparison.reason).toBe("done");
    const an = (await db.from("deal_analysis").select("current_version, inputs").eq("id", analysis).single()).data!;
    expect(an.current_version).toBe(2);
    expect(an.inputs.visit_feedback[a1].pricing).toBe("Rent is high");
    expect(an.inputs.properties.find((x: Row) => x.key === a1).customScores.client_feedback).toBe(0.25);
    expect(s.task.status).toBe("done");
    expect(await runFeedbackChain(db, WS1, fb)).toBeNull();
    const tasks = (await db.from("task").select("title").eq("linked_entity_id", req).eq("source", "workflow")).data!;
    expect(tasks).toHaveLength(1); expect(tasks[0].title).toBe("Review updated comparison");
  }, 60_000);

  it("explicit rejection → rejected with reason, building removed from the new version; off-shortlist building skipped", async () => {
    await saveFeedback(db, WS1, ME, prep, a2, { interest: "rejected", explicit_rejection: true, location: "Too far from metro" });
    const fb = (await db.from("meeting_property_feedback").select("id").eq("prep_id", prep).eq("asset_id", a2).single()).data!.id;
    const s = await steps(db, (await runFeedbackChain(db, WS1, fb))!.runId);
    expect(s.option.reason).toMatch(/explicitly rejected.*Too far from metro/);
    expect((await db.from("shortlist_option").select("option_status").eq("id", opts[a2]).single()).data!.option_status).toBe("rejected");
    const an = (await db.from("deal_analysis").select("current_version, asset_ids, inputs").eq("id", analysis).single()).data!;
    expect(an.current_version).toBe(3); expect(an.asset_ids).not.toContain(a2); expect(an.inputs.removed_rejected).toContain(a2);

    await saveFeedback(db, WS1, ME, prep, a3, { overall: 4, interest: "interested" });
    const fb3 = (await db.from("meeting_property_feedback").select("id").eq("prep_id", prep).eq("asset_id", a3).single()).data!.id;
    const s3 = await steps(db, (await runFeedbackChain(db, WS1, fb3))!.runId);
    expect(s3.option.status).toBe("skipped"); expect(s3.option.reason).toMatch(/not on this requirement's shortlist/);
  }, 60_000);
});

describe("meeting completed → rescore + follow-ups", () => {
  it("rescored company and reported applyOutcome's tasks/draft; idempotent; nothing sent", async () => {
    const db = await userClient("owner"); const t = tag("wfm");
    const o = await org(db, `Doneco ${t}`);
    const p = await person(db, `Dev Rao ${t}`, o);
    const m = await createMeeting(db, WS1, ME, { title: `Discovery ${t}`, start: future(-1), orgId: o, personIds: [p] });
    await addNote(db, WS1, ME, m.id, "commitment", "We will send three options by Friday.");
    await structureOutcome(db, WS1, ME, m.id, "Discussed needs. We will send three options by Friday.", noAi);
    await applyOutcome(db, WS1, ME, m.id, { requirement: false, tasks: true, interaction: true, followupDraft: true });
    const r = await runMeetingChain(db, WS1, m.id);
    const s = await steps(db, r!.runId);
    expect(s.scores.status).toBe("done");
    expect(s.followups.status).toBe("done"); expect(s.followups.reason).toMatch(/Nothing was sent/);
    expect(await runMeetingChain(db, WS1, m.id)).toBeNull();
    await nothingSent(db, p);
  }, 60_000);
});

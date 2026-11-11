// Journey test plan STAGE 8 — Module 12 assistant, cases 12.1–12.15 (docs/journey/TEST_PLAN.txt).
// Mock-AI mode (no ANTHROPIC_API_KEY): the planner is deterministic (engine/mock.ts). For every case we assert the
// hard guarantees (right entities, no invention, calculators for money, approvals, no send, RLS) and record which tools
// the mock planner picked vs. which tools the real-model path would be offered (selectTools). Where the mock cannot
// route, the expected tool is executed directly through executeTool (same validation/permission/approval path) so the
// capability itself is still verified. Findings are written to /tmp/m12-results.json for the results report.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../helpers";
import type { AppContext } from "@/lib/auth/context";
import type { Block, EntityRef } from "@/modules/assistant/types";
import { runAssistant } from "@/modules/assistant/engine/run";
import { routeRequest } from "@/modules/assistant/engine/router";
import { executeTool } from "@/modules/assistant/engine/execute";
import { decideApproval } from "@/modules/assistant/engine/approvals";
import { getTool, TOOLS } from "@/modules/assistant/tools";
import { selectTools } from "@/modules/assistant/tools/select";
import * as Meet from "@/modules/meetings/service";
import { createOutreach } from "@/modules/outreach/service";
import { scoreEntity } from "@/modules/scoring/service";
import { createQuote } from "@/modules/deals/quotes/service";

type Row = Record<string, any>;
delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "1000";

const T = tag("abc");
const admin = adminClient();
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
let db: any, ctx: AppContext;
const F: Record<string, Row> = {};
const props: Row[] = [];
const results: Record<string, Row> = {};

const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};

async function ask(request: string, extra: Partial<Parameters<typeof runAssistant>[0]> = {}, c: AppContext = ctx) {
  const r = await runAssistant({ ctx: c, request, ...extra });
  const cdb = c.db;
  const { data: msg } = await cdb.from("assistant_message").select("*").eq("id", r.messageId).maybeSingle();
  const { data: steps } = await cdb.from("assistant_tool_execution").select("*").eq("run_id", r.runId).order("step");
  const blocks = (msg?.blocks ?? []) as Block[];
  const route = routeRequest(request);
  const sel = selectTools({ intent: route.intent, request, focusType: extra.focus?.type ?? null, available: TOOLS.map((t) => t.id) });
  return { ...r, msg: msg as Row, steps: (steps ?? []) as Row[], blocks, all: JSON.stringify(blocks), intent: route.intent, offered: sel.all ? ["*all*"] : sel.ids };
}
const stepOf = (r: { steps: Row[] }, id: string) => r.steps.find((s) => s.tool_id === id);
const offered = (r: { offered: string[] }, id: string) => r.offered.includes("*all*") || r.offered.includes(id);
function record(id: string, r: Awaited<ReturnType<typeof ask>> | null, expected: string[], extra: Row = {}) {
  const picked = r ? r.steps.map((s) => `${s.tool_id}:${s.status}`) : [];
  results[id] = {
    intent: r?.intent, status: r?.status, picked, expected,
    mockPickedAll: expected.every((e) => r?.steps.some((s) => s.tool_id === e)),
    realPathOffered: r ? expected.filter((e) => offered(r, e)) : [], realPathMissing: r ? expected.filter((e) => !offered(r, e)) : [],
    text: r?.msg?.content?.slice(0, 600), ...extra,
  };
}
async function direct(id: string, input: unknown, runId: string, conversationId: string | null = null, c: AppContext = ctx) {
  const tool = getTool(id)!;
  return executeTool(tool, input, { ctx: c, runId, conversationId, focus: null }, 9);
}

beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };

  // ---- company + occupancy (Kharadi 15,000 SF estimate) -----------------------------------------------------
  F.org = await ins("organisation", { display_name: `ABC Technologies ${T}`, sector: "IT services", domain: `abc-${T}.example` });
  F.current = await ins("asset", { name: `ABC current campus ${T}`, asset_kind: "building", address: "Kharadi, Pune", lat: 18.551, lon: 73.944 });
  F.lease = await ins("lease", { tenant_org_id: F.org.id, asset_id: F.current.id, area_sf: 15000, area_basis: "chargeable", contractual_expiry: day(240).slice(0, 10), fact_status: "ai_inference" });

  // ---- 3 contacts with roles ----------------------------------------------------------------------------------
  const people: [string, string, string, string | null][] = [
    ["Rahul", "Head of Administration", "decision_maker", "verified"],
    ["Priya", "Chief Financial Officer", "economic_buyer", null],
    ["Amit", "Head of IT Infrastructure", "technical_evaluator", "unverified"],
  ];
  for (const [first, title, role, verify] of people) {
    const p = await ins("person", { full_name: `${first} ${T}` });
    await ins("employment", { person_id: p.id, org_id: F.org.id, title, is_current: true });
    await ins("contact_role_assessment", { person_id: p.id, org_id: F.org.id, role_class: role, cre_relevance: "high", reason: `Fixture: ${title}`, source: "user", active: true });
    if (verify) await ins("contact_method", { person_id: p.id, method_type: "email", value: `${first.toLowerCase()}@abc-${T}.example`, verify_status: verify }).catch(async () =>
      ins("contact_method", { person_id: p.id, method_type: "email", value: `${first.toLowerCase()}@abc-${T}.example` }));
    F[first] = p;
  }

  // ---- properties A/B/C with commercials ------------------------------------------------------------------------
  for (const [i, n] of ["A", "B", "C"].entries()) {
    const a = await ins("asset", { name: `Property ${n} ${T}`, asset_kind: "building", address: "Kharadi, Pune", lat: 18.55 + i * 0.004, lon: 73.94 + i * 0.004, grade: "A" });
    const s = await ins("space", { asset_id: a.id, floor_text: String(4 + i), chargeable_sf: 25000 + i * 2000 });
    await ins("availability", { space_id: s.id, as_of: day(-5).slice(0, 10), status: "available", asking_rent_min: [95, 82, 78][i], asking_rent_max: [95, 82, 78][i], rent_basis: "chargeable", fact_status: "reported" });
    props.push({ ...a, space: s });
  }

  // ---- requirement 25,000 SF, opportunity, stakeholders, shortlist ---------------------------------------------
  F.req = await ins("requirement", { org_id: F.org.id, title: `ABC ${T} Pune expansion`, area_min_sf: 22000, area_target_sf: 25000, area_max_sf: 28000, area_basis: "chargeable", status: "estimated" });
  F.opp = await ins("opportunity", { org_id: F.org.id, requirement_id: F.req.id, name: `ABC ${T} Pune expansion deal`, stage: "options_visits" });
  for (const [p, role] of [["Rahul", "sponsor"], ["Priya", "finance"]] as const)
    await ins("stakeholder", { requirement_id: F.req.id, person_id: F[p].id, role }).catch((e) => console.log("stakeholder", e.message));
  for (const [i, a] of props.entries())
    await ins("shortlist_option", { requirement_id: F.req.id, asset_id: a.id, option_status: "shortlisted", eligible: true, rubric_version: "test", version: 1, fit_score: 80 - i * 5 });

  // landlord quotes (commercials) for A/B/C — Deals quote service (immutable versions)
  const dctx = { db, workspaceId: WS1, userId: USERS.owner.id, role: "owner" as const };
  for (const [i, p] of props.entries()) await createQuote(dctx, { requirementId: F.req.id, spaceId: p.space.id, validUntil: "2099-12-31", evidence: `landlord email ${T}`,
    terms: { rent: [95, 82, 78][i], rent_basis: "chargeable", cam_per_sf: [10, 14, 16][i], escalation_pct: 15, escalation_every_months: 36, rent_free_months: [4, 3, 2][i], deposit_months: 6, tenure_months: 60, gst: "excluded" } } as never);

  // ---- signals incl. counter-evidence --------------------------------------------------------------------------
  F.sig = await ins("signal", { category: "expansion", kind: "pune_expansion", title: `ABC Technologies ${T} hiring 400 engineers in Pune`, org_id: F.org.id, verification: "inference", confidence: "medium", priority_band: "high", priority: 80, event_date: day(-20).slice(0, 10), latest_evidence_on: day(-12).slice(0, 10), recommended_action: "Call Rahul about Kharadi capacity", dedupe_key: `j:${T}` });
  await ins("signal_evidence", { signal_id: F.sig.id, role: "support", source_name: "Economic Times", source_url: `https://example.com/et-${T}`, excerpt: "ABC plans to add 400 engineers in Pune by 2027", published_on: day(-12).slice(0, 10), dedupe_key: `se1:${T}` });
  await ins("signal_evidence", { signal_id: F.sig.id, role: "counter", source_name: "Company filing", excerpt: "Hiring freeze announced for Q1 in Bengaluru", published_on: day(-8).slice(0, 10), dedupe_key: `se2:${T}` });

  // ---- lead score (real scoring service) -----------------------------------------------------------------------
  F.score = await scoreEntity(db, WS1, "lead", F.org.id, "journey").catch((e) => ({ error: String(e) }));

  // ---- outreach draft + interaction ----------------------------------------------------------------------------
  F.outreach = await createOutreach(db, WS1, USERS.owner.id, { personId: F.Rahul.id, channels: ["email"], scenario: "expansion", signalId: F.sig.id, ai: noAi }).catch((e) => ({ error: String(e) }));
  F.inter = await ins("interaction", { occurred_at: day(-10), channel: "email", direction: "outbound", subject: `Intro ${T}`, summary: "Sent Kharadi market note to Rahul", promises: [{ who: "us", what: "Share three options in Kharadi" }] });
  await ins("interaction_link", { interaction_id: F.inter.id, entity_type: "organisation", entity_id: F.org.id, role: "about" });
  await ins("interaction_link", { interaction_id: F.inter.id, entity_type: "person", entity_id: F.Rahul.id, role: "to" });

  // ---- meetings: past one with notes + commitment, next one upcoming --------------------------------------------
  F.pastMeeting = await Meet.createMeeting(db, WS1, USERS.owner.id, { title: `ABC ${T} options discussion`, start: day(-3), type: "requirement", orgId: F.org.id, opportunityId: F.opp.id, requirementId: F.req.id, personIds: [F.Rahul.id], assetIds: props.map((p) => p.id) });
  await Meet.addNote(db, WS1, USERS.owner.id, F.pastMeeting.id, "note", "Rahul said Property A is expensive");
  await Meet.addNote(db, WS1, USERS.owner.id, F.pastMeeting.id, "commitment", "We will send revised commercials for Property B and Property C by Friday");
  F.nextMeeting = await Meet.createMeeting(db, WS1, USERS.owner.id, { title: `ABC ${T} site visit follow-up`, start: day(2), type: "requirement", orgId: F.org.id, opportunityId: F.opp.id, requirementId: F.req.id, personIds: [F.Rahul.id, F.Priya.id] });

  // ---- 12.15 data: another Pune company whose lease record is incomplete (no expiry) -----------------------------
  F.org2 = await ins("organisation", { display_name: `Pune Widgets ${T}`, sector: "Manufacturing" });
  await ins("lease", { tenant_org_id: F.org2.id, asset_id: props[1].id, area_sf: 8000, contractual_expiry: null, fact_status: "unknown" });
}, 120_000);

afterAll(() => { fs.writeFileSync("/tmp/m12-results.json", JSON.stringify({ T, fixture: { org: F.org?.id, req: F.req?.id, opp: F.opp?.id, score: F.score?.score ?? F.score }, results }, null, 2)); });

describe("STAGE 8 — Module 12 assistant (mock-AI mode)", () => {
  it("12.1 company intelligence: real records only, missing surfaced", async () => {
    const r = await ask(`Give me everything important about ABC Technologies ${T}.`);
    const p = stepOf(r, "get_company_profile");
    expect(p?.status).toBe("ok");
    expect(p!.input.companyId).toBe(F.org.id);
    expect(r.all).not.toMatch(/Rahul .*@(?!abc-)/); // no invented contacts/addresses
    record("12.1", r, ["get_company_profile", "get_research_signals", "get_scores", "find_decision_makers", "get_outreach_history", "get_meeting_history", "get_commitments", "get_requirement_details"],
      { profileOutputKeys: Object.keys(p!.output?.data ?? p!.output ?? {}), profileSummary: p!.output?.summary ?? null, missingBlock: r.blocks.find((b) => b.kind === "missing") });
  });

  it("12.2 research signals: evidence, dates, counter-evidence", async () => {
    const r = await ask(`Why did we identify ABC Technologies ${T} as an opportunity?`);
    const d = stepOf(r, "get_research_signals") ? null : await direct("get_research_signals", { companyId: F.org.id }, r.runId, r.conversationId);
    const out = stepOf(r, "get_research_signals")?.output ?? d?.result;
    const js = JSON.stringify(out);
    expect(js).toContain(F.sig.id);
    expect(js).toContain(day(-12).slice(0, 10)); // evidence date visible
    const counterShown = /Hiring freeze|counter/i.test(js);
    record("12.2", r, ["get_research_signals"], { directStatus: d?.status, counterEvidenceSurfaced: counterShown });
  });

  it("12.3 prioritisation: lead score + factors + missing", async () => {
    const r = await ask(`Why is ABC Technologies ${T} a high-priority account?`);
    const d = stepOf(r, "get_scores") ? null : await direct("get_scores", { entityType: "company", entityId: F.org.id }, r.runId, r.conversationId);
    const js = JSON.stringify(stepOf(r, "get_scores")?.output ?? d?.result);
    const hasLead = /"lead"|lead/i.test(js);
    expect(d ? d.status : "ok").toBe("ok");
    record("12.3", r, ["get_scores"], { directStatus: d?.status, leadScoreFound: hasLead, fixtureScore: F.score?.score ?? F.score, hasMissing: /missing/i.test(js), hasFactors: /strength|factor/i.test(js) });
  });

  it("12.4 decision-makers: roles, verified vs unverified contact info", async () => {
    const r = await ask(`Who are the important people we need to speak to at ABC Technologies ${T}?`);
    const d = stepOf(r, "find_decision_makers") ? null : await direct("find_decision_makers", { companyId: F.org.id }, r.runId, r.conversationId);
    const js = JSON.stringify(stepOf(r, "find_decision_makers")?.output ?? d?.result);
    for (const p of ["Rahul", "Priya", "Amit"]) expect(js).toContain(`${p} ${T}`);
    expect(js).toMatch(/decision_maker/);
    expect(js).not.toMatch(/@gmail|\+91/); // nothing invented
    record("12.4", r, ["find_decision_makers"], { directStatus: d?.status, verifyDistinction: /verif/i.test(js), missingCategories: /missing|no .*(procurement|finance)/i.test(js) });
  });

  it("12.5 outreach follow-up to Rahul: draft only, approval controls active", async () => {
    const r = await ask(`Draft a short follow-up to Rahul ${T} based on our last meeting.`);
    const d = stepOf(r, "generate_outreach_draft") ? null : await direct("generate_outreach_draft", { personId: F.Rahul.id, channels: ["email"], scenario: "meeting_followup", opportunityId: F.opp.id }, r.runId, r.conversationId);
    const status = stepOf(r, "generate_outreach_draft")?.status ?? d?.status;
    const js = JSON.stringify(stepOf(r, "generate_outreach_draft")?.output ?? d?.result);
    // never sent: every draft for Rahul is still un-sent
    const { data: drafts } = await db.from("draft").select("state").eq("recipient_person_id", F.Rahul.id);
    expect((drafts ?? []).every((x: Row) => !["sent"].includes(x.state))).toBe(true);
    record("12.5", r, ["get_meeting_history", "generate_outreach_draft"], { directStatus: status, draftResult: js.slice(0, 400), draftStates: (drafts ?? []).map((x: Row) => x.state) });
  });

  it("12.6 meeting preparation: correct next meeting + brief", async () => {
    const r = await ask(`Prepare me for my next meeting with ABC Technologies ${T}.`);
    const b = stepOf(r, "generate_meeting_brief");
    expect(b?.status).toBe("ok");
    const { data: vis } = await db.from("meeting_prep").select("id, meeting_visit_id, org_id").in("id", [F.nextMeeting.id, F.pastMeeting.id]);
    const next = vis.find((v: Row) => v.id === F.nextMeeting.id), past = vis.find((v: Row) => v.id === F.pastMeeting.id);
    results["12.6pre"] = { input: b!.input, next, past };
    expect(JSON.stringify(b!.input)).not.toContain(past.meeting_visit_id); // must not brief the PAST meeting
    expect(JSON.stringify(b!.input)).toMatch(new RegExp(`${F.nextMeeting.id}|${next.meeting_visit_id}`));
    expect(stepOf(r, "get_company_profile")?.status).toBe("ok");
    expect(stepOf(r, "get_commitments")?.status).toBe("ok");
    record("12.6", r, ["generate_meeting_brief", "get_company_profile", "get_commitments"], { commitmentsHasFriday: /by Friday/.test(JSON.stringify(stepOf(r, "get_commitments")?.output)) });
  });

  it("12.7 commercial analysis: Module 8 calculator, not LLM arithmetic", async () => {
    const r = await ask(`Compare ${props.map((p) => p.name).join(", ")} — which is financially better?`);
    // capability check with the correct ids (what a correct planner would call)
    const dc = await direct("compare_properties", { requirementId: F.req.id, assetIds: props.map((p) => p.id), termMonths: 60 }, r.runId, r.conversationId);
    const dc2 = await direct("compare_properties", { requirementId: F.req.id, assetIds: props.map((p) => p.id), termMonths: 60 }, r.runId, r.conversationId);
    const strip = (o: any) => JSON.stringify((o.result.data.properties as Row[]).map((p) => [p.name, p.rank, p.score, p.occupancyCost]));
    results["12.7direct"] = { status: dc.status, props: (dc.result.data as Row).properties.map((p: Row) => [p.name, p.rank, p.score, p.occupancyCost, p.missing]), recommendation: (dc.result.data as Row).recommendation, formula: (dc.result.data as Row).formula, reproducible: strip(dc) === strip(dc2) };
    expect(strip(dc)).toBe(strip(dc2));
    const s = stepOf(r, "compare_properties");
    results["12.7pre"] = { picked: r.steps.map((x) => [x.tool_id, x.status, x.input]), props: props.map((p) => [p.id, p.name]) };
    expect(s?.status).toBe("ok");
    expect(new Set(s!.input.assetIds)).toEqual(new Set(props.map((p) => p.id)));
    const { data: an } = await db.from("deal_analysis").select("id, formula_version, kind").eq("id", s!.output.data.analysisId).maybeSingle();
    expect(an?.formula_version).toBeTruthy(); // persisted, versioned deterministic calculation
    const r2 = await ask("Which of the three properties is financially better?", { conversationId: r.conversationId });
    record("12.7", r, ["compare_properties"], { props: s!.output.data.properties.map((p: Row) => [p.name, p.rank, p.score, p.occupancyCost, p.missing]), recommendation: s!.output.data.recommendation, formula: an?.formula_version, requirementPassed: !!s!.input.requirementId, literalPhrasing: { intent: r2.intent, picked: r2.steps.map((x) => `${x.tool_id}:${x.status}`) } });
  });

  it("12.8 multi-module deal review", async () => {
    const r = await ask(`Prepare ABC Technologies ${T} for a complete deal review.`);
    const g = stepOf(r, "generate_deal_review");
    expect(g?.status).toBe("ok");
    expect(JSON.stringify(g!.input)).toContain(F.opp.id);
    record("12.8", r, ["generate_deal_review"], { reviewKeys: Object.keys(g!.output?.data ?? {}), reviewText: JSON.stringify(g!.output).slice(0, 800) });
  });

  it("12.9 historical: exact note retrieved, no invented quotation", async () => {
    const r = await ask(`What did Rahul ${T} say about Property A ${T} during our last meeting?`);
    const d = stepOf(r, "get_meeting_history") ? null : await direct("get_meeting_history", { personId: F.Rahul.id }, r.runId, r.conversationId);
    const js = JSON.stringify(stepOf(r, "get_meeting_history")?.output ?? d?.result);
    expect(js).toContain("Rahul said Property A is expensive");
    record("12.9", r, ["get_meeting_history"], { directStatus: d?.status, inventedQuote: /"[^"]*expensive[^"]*"/.test(r.msg.content ?? "") && !(r.msg.content ?? "").includes("Rahul said Property A is expensive") });
  });

  it("12.10 continuity: same requirement, two new properties", async () => {
    const first = await ask(`Show the requirement ABC ${T} Pune expansion`);
    const r = await ask("Use the same requirement and compare two new properties.", { conversationId: first.conversationId });
    const { data: conv } = await db.from("assistant_conversation").select("entity_refs").eq("id", r.conversationId).single();
    const kept = (conv.entity_refs as EntityRef[]).some((e) => e.id === F.req.id);
    const { count } = await db.from("requirement").select("id", { count: "exact", head: true }).eq("org_id", F.org.id);
    expect(count).toBe(1); // existing requirement retained, no duplicate
    record("12.10", r, ["get_requirement_details", "compare_properties"], { firstPicked: first.steps.map((s) => s.tool_id), requirementInConversation: kept, asksQuestion: /^Question:/i.test(r.msg.content ?? "") });
  });

  it("12.11 contextual assistant: page focus for company/contact/property/requirement/opportunity", async () => {
    const pages: [EntityRef["type"], string, string][] = [["company", F.org.id, "Summarise this company."], ["person", F.Rahul.id, "Summarise this contact."], ["asset", props[0].id, "Summarise this property."], ["requirement", F.req.id, "Summarise this requirement."], ["opportunity", F.opp.id, "Summarise this opportunity."]];
    const out: Row = {};
    for (const [type, id, q] of pages) {
      const r = await ask(q, { focus: { type, id, label: "page" } });
      const inputs = JSON.stringify(r.steps.map((s) => s.input));
      const ok = r.steps.length > 0 && inputs.includes(id) && r.steps.every((s) => s.status === "ok");
      const wrong = [F.org.id, F.Rahul.id, props[0].id, F.req.id, F.opp.id].filter((x) => x !== id && inputs.includes(x) && !(type !== "company" && x === F.org.id));
      out[type] = { picked: r.steps.map((s) => `${s.tool_id}:${s.status}`), usedFocusId: inputs.includes(id), ok, confusedWith: wrong };
    }
    expect(out.company.usedFocusId).toBe(true);
    for (const v of Object.values(out)) expect((v as Row).confusedWith).toEqual([]);
    results["12.11"] = { pages: out };
  });

  it("12.12 multi-step: follow-up draft + Friday reminder + deal review; nothing sent", async () => {
    const q = `Prepare a follow-up for Rahul ${T}, create an internal reminder for Friday and update the deal review.`;
    const r = await ask(q, { focus: { type: "opportunity", id: F.opp.id, label: "deal" } });
    const done: Row = {};
    for (const [id, input] of [
      ["generate_outreach_draft", { personId: F.Rahul.id, channels: ["email"], scenario: "meeting_followup", opportunityId: F.opp.id }],
      ["create_internal_task", { title: `Follow up Rahul ${T}`, due: (() => { const d = new Date(); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return d.toISOString().slice(0, 10); })(), entityType: "opportunity", entityId: F.opp.id }],
    ] as const) {
      if (stepOf(r, id)) { done[id] = stepOf(r, id)!.status; continue; }
      const o = await direct(id, input, r.runId, r.conversationId);
      done[id] = `direct:${o.status}`;
      expect(o.status).toBe("ok");
    }
    expect(stepOf(r, "generate_deal_review")?.status).toBe("ok");
    const { data: drafts } = await db.from("draft").select("state").eq("recipient_person_id", F.Rahul.id);
    expect((drafts ?? []).some((x: Row) => x.state === "sent")).toBe(false);
    const st = r.blocks.at(-1) as Extract<Block, { kind: "status" }>;
    record("12.12", r, ["generate_outreach_draft", "create_internal_task", "generate_deal_review"], { done, statusBlock: st });
  });

  it("12.13 permission: other workspace user cannot see ABC lease; denial logged", async () => {
    const odb = await userClient("other");
    const octx: AppContext = { db: odb, userId: USERS.other.id, email: USERS.other.email, workspaceId: WS2, workspaceName: "WS2", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };
    const r = await ask("Show me that company's lease information.", { focus: { type: "company", id: F.org.id, label: "ABC" } }, octx);
    expect(r.status).toBe("partial");
    const { data: msgs } = await odb.from("assistant_message").select("content, blocks").eq("conversation_id", r.conversationId);
    const dump = JSON.stringify(msgs);
    expect(dump).not.toContain(`ABC Technologies ${T}`);
    expect(dump).not.toContain("15000");
    const direct1 = await odb.from("lease").select("id").eq("id", F.lease.id);
    expect(direct1.data ?? []).toHaveLength(0);
    const { data: ev } = await admin.from("assistant_security_event").select("kind").eq("workspace_id", WS2).contains("detail", { id: F.org.id });
    expect((ev ?? []).length).toBeGreaterThan(0);
    // spoofing WS1 with the other user's session must fail too (membership check / RLS)
    const spoof = await odb.from("organisation").select("id").eq("id", F.org.id);
    expect(spoof.data ?? []).toHaveLength(0);
    record("12.13", r, [], { securityEvents: (ev ?? []).map((e: Row) => e.kind), leaked: false });
  });

  it("12.14 correction 25,000 → 30,000 SF: approval, old value kept", async () => {
    const r = await ask("The client's requirement is now 30,000 SF, not 25,000 SF.", { focus: { type: "requirement", id: F.req.id, label: "req" } });
    let o = stepOf(r, "update_requirement_record");
    let approvalId: string | undefined;
    if (!o) {
      const x = await direct("update_requirement_record", { requirementId: F.req.id, changes: [{ key: "area_target_sf", value: 30000, status: "client_confirmed" }], reason: "Client said requirement is now 30,000 SF (assistant chat)" }, r.runId, r.conversationId);
      expect(x.status).toBe("needs_approval");
      approvalId = x.approvalId;
    } else { approvalId = r.blocks.find((b) => b.kind === "approval") && (r.blocks.find((b) => b.kind === "approval") as any).approvalId; }
    let { data: req } = await db.from("requirement").select("area_target_sf").eq("id", F.req.id).single();
    expect(Number(req.area_target_sf)).toBe(25000); // unchanged until approved
    const res0 = await decideApproval(ctx, approvalId!, "approve");
    results["12.14pre"] = { firstAttempt: res0.status, note: "key area_target_sf (advertised in the tool description) rejected at execution" };
    // retry with the key the Deals contract actually accepts ("area" = [min, target, max])
    const y = await direct("update_requirement_record", { requirementId: F.req.id, changes: [{ key: "area", value: [22000, 30000, 33000], status: "client_confirmed" }], reason: "Client said requirement is now 30,000 SF (assistant chat)" }, r.runId, r.conversationId);
    expect(y.status).toBe("needs_approval");
    const res = await decideApproval(ctx, y.approvalId!, "approve");
    ({ data: req } = await db.from("requirement").select("area_target_sf").eq("id", F.req.id).single());
    const { data: cps } = await db.from("change_proposal").select("id, state, patch, before, reason").eq("target_id", F.req.id);
    const { data: au } = await admin.from("audit_event").select("action, before, after").eq("workspace_id", WS1).eq("entity_id", F.req.id);
    const oldKept = Number(req.area_target_sf) === 25000 || JSON.stringify(cps).includes("25000") || JSON.stringify(au).includes("25000");
    expect(oldKept).toBe(true);
    record("12.14", r, ["update_requirement_record"], { approval: res.status, areaAfterApproval: req.area_target_sf, proposals: cps, auditActions: (au ?? []).map((a: Row) => a.action) });
  });

  it("12.15 failed task: lease expiries with coverage limitation", async () => {
    const r = await ask("Show me all Pune companies with lease expiries in the next 12 months.");
    const s = stepOf(r, "find_leases_expiring");
    expect(s?.status).toBe("ok");
    expect(s!.input.windowMonths).toBe(12);
    expect(s!.output.data.total).toBeGreaterThan(0);
    expect(JSON.stringify(s!.output.data.coverage)).toMatch(/without an expiry date/); // incomplete lease (Pune Widgets) counted as a gap
    expect(r.msg.content).toMatch(/Coverage: checked \d+/);
    expect(r.msg.content).toMatch(/not a complete/);
    record("12.15", r, ["find_leases_expiring"], { coverage: s!.output?.coverage });
  });
});

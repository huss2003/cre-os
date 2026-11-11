// Journey test plan §14 — final cross-module integration tests 1–5, chaining the REAL module services (mock AI).
// Results are written to /tmp/integration-results.json for docs/journey/results-m12-integration.md.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { userClient, WS1, USERS, tag } from "../helpers";
import type { AppContext } from "@/lib/auth/context";
import type { DealsCtx } from "@/modules/deals/ctx";
import { ingestText, signalDetail } from "@/modules/signals/service";
import { scoreEntity } from "@/modules/scoring/service";
import { setRole } from "@/modules/contacts/service";
import * as Out from "@/modules/outreach/service";
import * as Meet from "@/modules/meetings/service";
import { approveAndApply } from "@/modules/changes/service";
import { getRequirementDetail } from "@/modules/deals/requirements/service";
import { runShortlist } from "@/modules/deals/matching/service";
import { createQuote } from "@/modules/deals/quotes/service";
import { runAssistant } from "@/modules/assistant/engine/run";
import { executeTool } from "@/modules/assistant/engine/execute";
import { getTool } from "@/modules/assistant/tools";

type Row = Record<string, any>;
delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "1000";
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const T = tag("int");
const owner = USERS.owner.id;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
let db: any, ctx: AppContext, dctx: DealsCtx;
const F: Record<string, any> = {};
const R: Record<string, Row> = {};

const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: owner, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};
const tool = (id: string, input: unknown, runId = crypto.randomUUID()) => executeTool(getTool(id)!, input, { ctx, runId, conversationId: null, focus: null }, 1);

beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, userId: owner, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };
  dctx = { db, workspaceId: WS1, userId: owner, role: "owner" };
  F.org = await ins("organisation", { display_name: `ABC Technologies ${T}`, sector: "IT services", domain: `abc-${T}.example` });
  F.rahul = await ins("person", { full_name: `Rahul ${T}` });
  await ins("employment", { person_id: F.rahul.id, org_id: F.org.id, title: "Head of Administration", is_current: true });
  await ins("contact_method", { person_id: F.rahul.id, method_type: "email", value: `rahul@abc-${T}.example`, verify_status: "verified" });
  F.req = await ins("requirement", { org_id: F.org.id, title: `ABC ${T} Pune office`, area_min_sf: 22000, area_target_sf: 25000, area_max_sf: 28000, area_basis: "chargeable", status: "estimated" });
  F.opp = await ins("opportunity", { org_id: F.org.id, requirement_id: F.req.id, name: `ABC ${T} deal`, stage: "engaged" });
  F.props = [];
  for (const [i, n] of ["A", "B", "C"].entries()) {
    const a = await ins("asset", { name: `Tower ${n} ${T}`, asset_kind: "building", address: "Kharadi, Pune", lat: 18.55 + i * 0.003, lon: 73.94, grade: "A" });
    const s = await ins("space", { asset_id: a.id, floor_text: "5", chargeable_sf: 24000 + i * 1500, carpet_sf: 17000 + i * 1000 });
    await ins("availability", { space_id: s.id, as_of: day(-3).slice(0, 10), status: "available", available_from: "2027-03-01", asking_rent_min: [95, 82, 78][i], asking_rent_max: [95, 82, 78][i], rent_basis: "chargeable", valid_until: "2099-12-31", fact_status: "currently_confirmed" });
    F.props.push({ ...a, space: s, rent: [95, 82, 78][i] });
  }
}, 120_000);

afterAll(() => fs.writeFileSync("/tmp/integration-results.json", JSON.stringify({ T, R }, null, 2)));

describe("§14 cross-module integration (mock AI)", () => {
  it("IT1 signal → company → score → decision-maker → outreach draft", async () => {
    const text = `ABC Technologies ${T} announced it is expanding its Pune operations and will open a new office in Kharadi next year, hiring 400 engineers.`;
    const ing = await ingestText(db, WS1, { text, companyName: `ABC Technologies ${T}`, sourceName: "Press release", sourceUrl: `https://example.com/${T}`, publishedOn: day(-1).slice(0, 10) });
    expect(ing.signals.length).toBeGreaterThan(0);
    const sig = (await signalDetail(db, WS1, ing.signals[0].id))!;
    expect(sig.signal.org_id).toBe(F.org.id); // matched to the existing company, no duplicate org
    const { count: orgs } = await db.from("organisation").select("id", { count: "exact", head: true }).ilike("display_name", `%${T}%`);
    expect(orgs).toBe(1);
    const score = await scoreEntity(db, WS1, "lead", F.org.id, "journey");
    expect(score.entity_id).toBe(F.org.id);
    await setRole(db, WS1, owner, F.rahul.id, "decision_maker", "high", "Signs off office leases");
    const dm = await tool("find_decision_makers", { companyId: F.org.id });
    expect(JSON.stringify(dm.result)).toContain(`Rahul ${T}`);
    const out = await Out.createOutreach(db, WS1, owner, { personId: F.rahul.id, channels: ["email"], signalId: sig.signal.id, ai: noAi });
    const { data: item } = await db.from("outreach_item").select("id, org_id, person_id, signal_id, draft_id, status, reason").eq("id", out.ids[0]).single();
    expect(item.person_id).toBe(F.rahul.id);
    expect(item.org_id).toBe(F.org.id);
    const { data: draft } = await db.from("draft").select("state, recipient_address").eq("id", item.draft_id).single();
    expect(draft.state).not.toBe("sent");
    F.item = item; F.sig = sig.signal;
    R.IT1 = { signal: { id: sig.signal.id, org: sig.signal.org_id, verification: sig.signal.verification, evidence: sig.evidence.length }, score: { score: score.score, band: score.band, factors: (score.factors ?? []).length }, decisionMakers: dm.result.summary, outreach: { reason: item.reason, signalLinked: item.signal_id === sig.signal.id, draftState: draft.state, to: draft.recipient_address } };
  });

  it("IT2 outreach draft → approve → synthetic reply → meeting → brief, all linked", async () => {
    const it = F.item ?? (await db.from("outreach_item").select("*").eq("person_id", F.rahul.id).limit(1).single()).data;
    await Out.requestApproval(db, WS1, owner, it.id);
    const { data: d } = await db.from("draft").select("content_hash").eq("id", it.draft_id).single();
    await Out.approve(db, WS1, owner, it.id, d.content_hash);
    const open = await Out.openForSend(db, WS1, owner, it.id, d.content_hash); // returns mailto link only — CRE OS never sends
    expect(open.href).toMatch(/^mailto:/);
    await Out.markSent(db, WS1, owner, it.id);
    const resp = await Out.recordResponse(db, WS1, owner, it.id, `Thanks — Rahul here. Please send options in Kharadi. Let's meet Tuesday.`, noAi);
    const m = await Meet.createMeeting(db, WS1, owner, { title: `ABC ${T} requirement meeting`, start: day(4), type: "requirement", orgId: F.org.id, opportunityId: F.opp.id, requirementId: F.req.id, personIds: [F.rahul.id] });
    const brief = await Meet.generateBrief(db, WS1, owner, m.id, noAi);
    const { data: prep } = await db.from("meeting_prep").select("org_id, opportunity_id, requirement_id, brief, status").eq("id", m.id).single();
    expect(prep.org_id).toBe(F.org.id);
    expect(prep.opportunity_id).toBe(F.opp.id);
    const bj = JSON.stringify(prep.brief);
    const { data: att } = await db.from("meeting_prep_attendee").select("person_id").eq("prep_id", m.id);
    expect(att.map((a: Row) => a.person_id)).toContain(F.rahul.id);
    F.meeting = m;
    R.IT2 = { replyStatus: resp.status, replyTasks: resp.tasks?.length, replyProposals: resp.proposals?.length, briefVersion: brief.version, briefMentionsOutreach: /outreach|email|reply|Kharadi/i.test(bj), prepStatus: prep.status };
  });

  it("IT3 meeting notes → requirement proposals → approve → readiness → brief, no duplicate requirement", async () => {
    const m = await Meet.createMeeting(db, WS1, owner, { title: `ABC ${T} discovery`, start: day(-1), type: "requirement", orgId: F.org.id, opportunityId: F.opp.id, requirementId: F.req.id, personIds: [F.rahul.id] });
    await Meet.addNote(db, WS1, owner, m.id, "note", "They need about 280 seats, move in 2027-06-01.");
    await Meet.addNote(db, WS1, owner, m.id, "commitment", "We will send three options in Kharadi by Friday");
    const o = await Meet.structureOutcome(db, WS1, owner, m.id, "Good meeting.", noAi);
    const applied = await Meet.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: false });
    const before = (await db.from("requirement").select("seats_target, row_version").eq("id", F.req.id).single()).data;
    expect(before.seats_target).toBeNull(); // proposal, not silent overwrite
    const { data: cps } = await db.from("change_proposal").select("id, state").eq("target_id", F.req.id).in("state", ["proposed", "pending"]);
    for (const cp of cps ?? []) await approveAndApply(db, cp.id, { actorUserId: owner, note: "journey IT3" });
    const after = (await db.from("requirement").select("seats_target, occupation_date").eq("id", F.req.id).single()).data;
    const readiness = await scoreEntity(db, WS1, "requirement", F.req.id, "journey");
    const detail = await getRequirementDetail(dctx, F.req.id);
    const { count } = await db.from("requirement").select("id", { count: "exact", head: true }).eq("org_id", F.org.id);
    expect(count).toBe(1);
    expect(Number(after.seats_target)).toBe(280);
    R.IT3 = { extracted: o.requirement_updates, applied, proposalsApproved: (cps ?? []).length, after, readiness: { score: readiness.score, band: readiness.band, missing: readiness.missing }, briefKeys: Object.keys(detail ?? {}), requirementCount: count };
  });

  it("IT4 requirement → shortlist → lease economics → compare → proposal; reproducible", async () => {
    for (const p of F.props) await createQuote(dctx, { requirementId: F.req.id, spaceId: p.space.id, validUntil: "2099-12-31", evidence: `landlord email ${T}`,
      terms: { rent: p.rent, rent_basis: "chargeable", cam_per_sf: 12, escalation_pct: 15, escalation_every_months: 36, rent_free_months: 3, deposit_months: 6, tenure_months: 60, gst: "excluded" } } as never);
    const run = await runShortlist(dctx, F.req.id);
    const mine = run.results.filter((x: Row) => F.props.some((p: Row) => p.space.id === x.spaceId));
    expect(mine.length).toBe(3);
    const c1 = await tool("compare_properties", { requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60 });
    const c2 = await tool("compare_properties", { requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60 });
    R.IT4pre = { c1: c1.status, err: c1.result };
    expect(c1.status).toBe("ok");
    const strip = (r: any) => JSON.stringify((r.result.data.properties as Row[]).map((p) => [p.name, p.rank, p.score, p.occupancyCost]));
    expect(strip(c1)).toBe(strip(c2)); // deterministic, reproducible
    const offers = F.props.map((p: Row) => ({ name: p.name, label: "quoted", areaSf: p.space.chargeable_sf, areaBasis: "chargeable", rentPerSf: p.rent, leaseCommencement: "2027-03-01", tenureMonths: 60, rentFreeMonths: 3, escalationPct: 15, escalationEveryMonths: 36, camPerSf: 12, depositMonths: 6, discountRatePct: 12 }));
    const le = await tool("calculate_lease_economics", { requirementId: F.req.id, offers });
    R.IT4le = { status: le.status, result: le.result };
    expect(le.status).toBe("ok");
    const o0 = (le.result.data as Row).offers[0];
    // independent check of month-1 rent = area × rent (deterministic service, not LLM)
    expect(Number(o0.monthlyRent)).toBe(F.props[0].space.chargeable_sf * 95);
    const deck = await tool("generate_deck", { analysisId: (le.result.data as Row).analysisId });
    R.IT4 = { shortlistVersion: run.version, shortlist: mine.map((x: Row) => [x.spaceId, x.eligibility]), comparison: JSON.parse(strip(c1)), leaseOffers: (le.result.data as Row).offers.map((x: Row) => [x.name, x.monthlyRent, x.complete, x.gaps]), deck: { status: deck.status, summary: deck.result.summary } };
    expect(deck.status).toBe("ok");
  });

  it("IT5 single assistant instruction across modules 1,2,3,4,5,7,8", async () => {
    const q = `Review ABC Technologies ${T}, identify why it is a relevant opportunity, show me the important decision-makers, summarise our last interaction, compare the three properties against its requirement and prepare the next actions.`;
    const r = await runAssistant({ ctx, request: q });
    const { data: steps } = await db.from("assistant_tool_execution").select("tool_id, status, input").eq("run_id", r.runId).order("step");
    const { data: msg } = await db.from("assistant_message").select("content, blocks").eq("id", r.messageId).single();
    const picked = (steps ?? []).map((s: Row) => `${s.tool_id}:${s.status}`);
    expect(JSON.stringify(steps)).toContain(F.org.id.slice(0, 0) || F.opp.id); // the correct ABC deal was used
    const modules: Record<string, string[]> = { M1: ["get_company_profile", "generate_deal_review"], M2: ["get_research_signals"], M3: ["get_scores"], M4: ["find_decision_makers"], M5: ["get_outreach_history"], M7: ["get_meeting_history", "get_commitments"], M8: ["compare_properties"] };
    const viaTool = Object.fromEntries(Object.entries(modules).map(([k, ids]) => [k, ids.some((id) => picked.some((p: string) => p.startsWith(id)))]));
    R.IT5 = { status: r.status, picked, viaTool, text: msg.content, blocks: JSON.stringify(msg.blocks).slice(0, 3000) };
    // same instruction from the company page (focus) — isolates routing coverage from name resolution
    const r2 = await runAssistant({ ctx, request: q, focus: { type: "company", id: F.org.id, label: "page" } });
    const { data: s2 } = await db.from("assistant_tool_execution").select("tool_id, status, input").eq("run_id", r2.runId).order("step");
    const p2 = (s2 ?? []).map((s: Row) => `${s.tool_id}:${s.status}`);
    R.IT5focus = { status: r2.status, picked: p2, usedRightDeal: JSON.stringify(s2).includes(F.opp.id), viaTool: Object.fromEntries(Object.entries(modules).map(([k, ids]) => [k, ids.some((id) => p2.some((p: string) => p.startsWith(id)))])) };
  });
});

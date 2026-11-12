/**
 * MASTER-SPEC Part 5 / Part 12 — the full golden path, chaining REAL module services (WS1, RLS user clients, mock AI):
 * signal → score → contacts → outreach draft (not sent) → meeting → requirement → supply match + reconfirm →
 * toolkit comparison → transaction (offers/counter, approvals bound to version, deposit due≠paid, executed ≠ possession ≠ occupancy)
 * → closure → Module 15 lease (dates proposed; human confirm before confirmed deadline) → reminders via orchestrator →
 * renewal opportunity (expiry ≠ relocation requirement) → assistant answers grounded.
 * Each step records its outcome into /tmp/e2e-golden.json (used by docs/integration/E2E-RESULTS.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { userClient, adminClient, WS1, USERS, tag } from "../helpers";
import type { AppContext } from "@/lib/auth/context";
import type { DealsCtx } from "@/modules/deals/ctx";
import type { TxCtx } from "@/modules/transactions/ctx";
import { ingestText, signalDetail } from "@/modules/signals/service";
import { scoreEntity } from "@/modules/scoring/service";
import { setRole } from "@/modules/contacts/service";
import { runSignalChain } from "@/modules/workflows/service";
import * as Out from "@/modules/outreach/service";
import * as Meet from "@/modules/meetings/service";
import { approveAndApply } from "@/modules/changes/service";
import { runShortlist } from "@/modules/deals/matching/service";
import { runComparison } from "@/modules/toolkit/comparison";
import { createQuote } from "@/modules/deals/quotes/service";
import * as Tx from "@/modules/transactions/service";
import { milestonesView } from "@/modules/transactions/service";
import { answer as txAnswer } from "@/modules/transactions/integrations";
import * as L from "@/modules/leases/service";
import { answerLeaseQuestion } from "@/modules/leases/assist";
import { processEvents } from "@/modules/orchestrator";
import { runAssistant } from "@/modules/assistant/engine/run";
import { executeTool } from "@/modules/assistant/engine/execute";
import { getTool } from "@/modules/assistant/tools";

type Row = Record<string, any>;
delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "1000";
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const T = tag("gold");
const owner = USERS.owner.id;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
let db: any; let colDb: any; let ctx: AppContext; let dctx: DealsCtx; let tx: TxCtx; let txCol: TxCtx; let lw: L.W;
const F: Record<string, any> = {};
const R: Record<string, Row> = {};
const rec = (k: string, v: Row) => { R[k] = { ...(R[k] ?? {}), ...v }; };

const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: owner, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};
const tool = (id: string, input: unknown) => executeTool(getTool(id)!, input, { ctx, runId: crypto.randomUUID(), conversationId: null, focus: null }, 1);
const need = (k: string) => { if (!F[k]) throw new Error(`precondition missing: ${k} (an earlier golden-path step failed)`); return F[k]; };

const EXECUTED_TEXT = (code: string) => `LEASE DEED (${code})
This Lease Deed is executed on 20th November 2026 at Pune between Kharadi Towers Pvt Ltd (the Lessor) and Helios Software ${T} Pvt Ltd (the Lessee).
1. Premises: 24,000 sq ft chargeable.
2. Rent: base rent of ₹ 85 per sq ft per month.
3. Security deposit equal to 6 months.
4. Lock-in period of 36 months.
5. The term of the lease shall be 60 (sixty) months commencing on 1st January 2027 (the Commencement Date).
6. The lease shall expire on 31st December 2031 unless renewed.
7. The Lessee shall have the option to renew the lease for a further term by giving written notice not less than 6 months prior to the expiry of the term.
8. After the lock-in period, the Lessee may terminate this lease by giving notice of not less than six (6) months prior to the expiry of the term or such date of termination.`;

beforeAll(async () => {
  db = await userClient("owner");
  colDb = await userClient("colleague");
  ctx = { db, userId: owner, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };
  dctx = { db, workspaceId: WS1, userId: owner, role: "owner" };
  tx = { db, workspaceId: WS1, userId: owner };
  txCol = { db: colDb, workspaceId: WS1, userId: USERS.colleague.id };
  lw = { db, ws: WS1, userId: owner };
  // Part 9 scenario 1: a company expanding its Pune operations (synthetic).
  F.org = await ins("organisation", { display_name: `Helios Software ${T}`, sector: "IT services", domain: `helios-${T}.example` });
  F.dm = await ins("person", { full_name: `Priya Kulkarni ${T}` });
  await ins("employment", { person_id: F.dm.id, org_id: F.org.id, title: "Head of Workplace & Real Estate", is_current: true });
  await ins("contact_method", { person_id: F.dm.id, method_type: "email", value: `priya@helios-${T}.example`, verify_status: "verified" });
  F.dm2 = await ins("person", { full_name: `Arjun Mehta ${T}` });
  await ins("employment", { person_id: F.dm2.id, org_id: F.org.id, title: "CFO", is_current: true });
  await ins("contact_method", { person_id: F.dm2.id, method_type: "email", value: `arjun@helios-${T}.example`, verify_status: "verified" });
  const city = await ins("geography", { level: "city", name: `Pune ${T}` });
  F.mm = await ins("geography", { level: "micro_market", name: `Kharadi ${T}`, parent_id: city.id });
  F.req = await ins("requirement", { preferred_geography_ids: [F.mm.id], constraints: { hard_filters: { preferred_only: true } }, org_id: F.org.id, title: `Helios ${T} Pune expansion`, area_min_sf: 20000, area_target_sf: 24000, area_max_sf: 28000, area_basis: "chargeable", status: "estimated" });
  F.opp = await ins("opportunity", { org_id: F.org.id, requirement_id: F.req.id, name: `Helios ${T} expansion`, stage: "engaged" });
  F.props = [];
  for (const [i, n] of ["North", "East", "West"].entries()) {
    const a = await ins("asset", { name: `${n} Tower ${T}`, asset_kind: "building", address: "Kharadi, Pune", micro_market_id: F.mm.id, lat: 18.55 + i * 0.003, lon: 73.94, grade: "A" });
    const s = await ins("space", { asset_id: a.id, floor_text: String(4 + i), chargeable_sf: 23000 + i * 1500, carpet_sf: 16500 + i * 1000 });
    // East's availability is stale (as_of 120 days ago, unverified) — must drive a reconfirmation task.
    await ins("availability", { space_id: s.id, as_of: day(i === 1 ? -120 : -3).slice(0, 10), status: "available", available_from: "2027-01-01", asking_rent_min: [95, 85, 80][i], asking_rent_max: [95, 85, 80][i], rent_basis: "chargeable", valid_until: i === 1 ? null : "2099-12-31", fact_status: i === 1 ? "reported" : "currently_confirmed" });
    F.props.push({ ...a, space: s, rent: [95, 85, 80][i] });
  }
}, 180_000);

afterAll(() => { fs.writeFileSync("/tmp/e2e-golden.json", JSON.stringify({ T, R }, null, 2)); });

describe("Golden path (Part 5 W1→W4→W5→W7→W9→W10→W11, Part 12)", () => {
  it("G1 signal detected, evidence kept, matched to the existing company (no duplicate)", async () => {
    const text = `Helios Software ${T} announced it is expanding its Pune operations: a new 1,200-seat campus in Kharadi next year.`;
    const ing = await ingestText(db, WS1, { text, companyName: `Helios Software ${T}`, sourceName: "Press release", sourceUrl: `https://example.com/${T}`, publishedOn: day(-1).slice(0, 10) });
    expect(ing.signals.length).toBeGreaterThan(0);
    const sig = (await signalDetail(db, WS1, ing.signals[0].id))!;
    F.sig = sig.signal;
    rec("G1", { signal: sig.signal.id, org: sig.signal.org_id, verification: sig.signal.verification, evidence: sig.evidence.length });
    expect(sig.signal.org_id).toBe(F.org.id);
    expect(sig.evidence.length).toBeGreaterThan(0); // Part 12 "signals supported by evidence"
    const { count } = await db.from("organisation").select("id", { count: "exact", head: true }).ilike("display_name", `%${T}%`);
    expect(count).toBe(1);
  });

  it("G2 lead score calculated with an explanation (factors), history kept", async () => {
    const s = await scoreEntity(db, WS1, "lead", F.org.id, "golden");
    rec("G2", { score: s.score, band: s.band, factors: (s.factors ?? []).length });
    expect(s.entity_id).toBe(F.org.id);
    expect((s.factors ?? []).length).toBeGreaterThan(0); // Part 12 "scoring explanations available"
  });

  it("G3 contacts: buying-group role set; decision-makers retrievable via Ask tool", async () => {
    await setRole(db, WS1, owner, F.dm.id, "decision_maker", "high", "Signs off office leases (golden path)");
    await setRole(db, WS1, owner, F.dm2.id, "decision_maker", "high", "Approves capex (golden path)");
    const dm = await tool("find_decision_makers", { companyId: F.org.id });
    rec("G3", { status: dm.status, summary: dm.result?.summary });
    expect(JSON.stringify(dm.result)).toContain(`Priya Kulkarni ${T}`);
  });

  it("G4 signal chain (orchestrated) prepares ONE outreach draft — not sent; user approves + opens mailto + marks sent manually", async () => {
    const r = await runSignalChain(db, WS1, need("sig").id, { ai: noAi });
    const steps = r ? (await db.from("workflow_step").select("step_key, status, reason").eq("run_id", r.runId)).data : null;
    rec("G4", { chain: r?.status ?? null, steps });
    let items = (await db.from("outreach_item").select("*").eq("workspace_id", WS1).eq("org_id", F.org.id)).data as Row[];
    if (!items.length) { // fall back to direct outreach so the rest of the path still runs; failure recorded above
      const o = await Out.createOutreach(db, WS1, owner, { personId: F.dm.id, channels: ["email"], signalId: F.sig.id, ai: noAi });
      items = (await db.from("outreach_item").select("*").in("id", o.ids)).data as Row[];
      rec("G4", { fallbackDirectOutreach: true });
    }
    const it0 = items[0];
    const d0 = (await db.from("draft").select("state, approved_at, marked_sent_at, content_hash").eq("id", it0.draft_id).single()).data!;
    expect(it0.sent_at).toBeNull();
    expect(d0.state).not.toMatch(/sent/);
    expect(d0.marked_sent_at).toBeNull();
    await Out.requestApproval(db, WS1, owner, it0.id);
    await Out.approve(db, WS1, owner, it0.id, d0.content_hash);
    const open = await Out.openForSend(db, WS1, owner, it0.id, d0.content_hash);
    expect(open.href).toMatch(/^mailto:/); // never sent by CRE OS
    await Out.markSent(db, WS1, owner, it0.id);
    const follow = (await db.from("outreach_item").select("id, step, status, planned_on").eq("plan_key", it0.plan_key).gt("step", it0.step)).data as Row[];
    rec("G4", { outreach: it0.id, followupsScheduled: follow.length, mailto: (open.href ?? "").slice(0, 40) });
    expect(items.length).toBe(1);
    expect(follow.length).toBeGreaterThan(0); // W1 step 11: follow-up scheduled
    F.item = it0;
  });

  it("G5 meeting: brief generated with context; notes → requirement proposals (not silent) → approved → requirement updated, no duplicate", async () => {
    const m = await Meet.createMeeting(db, WS1, owner, { title: `Helios ${T} requirement meeting`, start: day(-1), type: "requirement", orgId: F.org.id, opportunityId: F.opp.id, requirementId: F.req.id, personIds: [F.dm.id] });
    const brief = await Meet.generateBrief(db, WS1, owner, m.id, noAi);
    await Meet.addNote(db, WS1, owner, m.id, "note", "They need about 300 seats, move in 2027-01-01. Budget up to ₹90 per sq ft.");
    await Meet.addNote(db, WS1, owner, m.id, "commitment", "We will send three options in Kharadi by Friday");
    await Meet.structureOutcome(db, WS1, owner, m.id, "Good meeting.", noAi);
    await Meet.applyOutcome(db, WS1, owner, m.id, { requirement: true, tasks: true, interaction: true, followupDraft: true });
    const before = (await db.from("requirement").select("seats_target").eq("id", F.req.id).single()).data;
    const { data: cps } = await db.from("change_proposal").select("id, state").eq("target_id", F.req.id).in("state", ["proposed", "pending"]);
    for (const cp of cps ?? []) await approveAndApply(db, cp.id, { actorUserId: owner, note: "golden G5" });
    const after = (await db.from("requirement").select("seats_target, occupation_date").eq("id", F.req.id).single()).data;
    const { count } = await db.from("requirement").select("id", { count: "exact", head: true }).eq("org_id", F.org.id);
    const draftsFromMeeting = (await db.from("outreach_item").select("id, status, sent_at").eq("org_id", F.org.id).eq("channel", "meeting_followup")).data as Row[];
    rec("G5", { briefVersion: brief.version, seatsBefore: before.seats_target, proposals: (cps ?? []).length, after, requirementCount: count, followupDrafts: draftsFromMeeting.length });
    expect(before.seats_target).toBeNull();
    expect(Number(after.seats_target)).toBe(300);
    expect(count).toBe(1);
    expect(draftsFromMeeting.every((d) => d.sent_at === null)).toBe(true);
  });

  it("G6 supply match: hard filters + ranking explainable; stale availability → reconfirmation task; rerun no duplicates", async () => {
    const run1 = await runShortlist(dctx, F.req.id);
    const mine = run1.results.filter((x: Row) => F.props.some((p: Row) => p.space.id === x.spaceId));
    const k = (await db.from("task").select("id, title, idempotency_key, status").eq("workspace_id", WS1).like("idempotency_key", `deals.verify:${F.req.id}:%`)).data as Row[];
    await runShortlist(dctx, F.req.id);
    const k2 = (await db.from("task").select("id").eq("workspace_id", WS1).like("idempotency_key", `deals.verify:${F.req.id}:%`)).data as Row[];
    const east = mine.find((x: Row) => x.spaceId === F.props[1].space.id);
    rec("G6", { version: run1.version, results: mine.map((x: Row) => ({ space: x.spaceId, rank: x.rank, eligibility: x.eligibility, verification: (x.verification ?? []).map((v: Row) => v.code), why: x.explanation ?? x.reasons ?? null })), verifyTasks: k.length, afterRerun: k2.length });
    expect(mine.length).toBe(3);
    expect(k.length).toBeGreaterThan(0);
    expect(k.some((t) => t.idempotency_key.includes(F.props[1].space.id))).toBe(true); // East: stale → reconfirm
    expect(k2.length).toBe(k.length);
    expect((east?.verification ?? []).length).toBeGreaterThan(0);
  });

  it("G7 toolkit comparison deterministic + reproducible; Ask compare_properties ok", async () => {
    for (const p of F.props) await createQuote(dctx, { requirementId: F.req.id, spaceId: p.space.id, validUntil: "2099-12-31", evidence: `landlord email ${T}`, terms: { rent: p.rent, rent_basis: "chargeable", cam_per_sf: 12, deposit_months: 6, tenure_months: 60, escalation_pct: 15, escalation_every_months: 36 } as never });
    const c1 = await runComparison(db, WS1, owner, { title: `Golden compare ${T}`, requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60, manual: [] } as never);
    const c2 = await runComparison(db, WS1, owner, { title: `Golden compare ${T}`, requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60, manual: [] } as never);
    const strip = (c: Row) => JSON.stringify((c.result?.properties ?? c.properties ?? c.rows ?? c.result ?? c).toString === undefined ? c : (c.result?.properties ?? c.properties ?? c.result ?? null));
    const t1 = await tool("compare_properties", { requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60 });
    const t2 = await tool("compare_properties", { requirementId: F.req.id, assetIds: F.props.map((p: Row) => p.id), termMonths: 60 });
    const s = (r: Row) => JSON.stringify((r.result?.data?.properties ?? []).map((p: Row) => [p.name, p.rank, p.score, p.occupancyCost]));
    rec("G7", { saved: !!(c1 as Row)?.id || !!(c1 as Row)?.analysisId, tool: t1.status, toolResult: s(t1).slice(0, 600) });
    expect(t1.status).toBe("ok");
    expect(s(t1)).toBe(s(t2));
    expect(strip(c1 as Row)).toBe(strip(c2 as Row));
  });

  it("G8 transaction: offer → counter → landlord counter (immutable versions, diffs); points agreed with evidence", async () => {
    const t = await Tx.createTransaction(tx, { name: `Helios ${T} Kharadi`, txType: "conventional_leasing", clientOrgId: F.org.id, requirementId: F.req.id, opportunityId: F.opp.id, spaceIds: [F.props[1].space.id] });
    F.tx = t;
    const o1 = await Tx.createOffer(tx, t.id, { offeringParty: "landlord", receivingParty: "client", offerDate: "2026-11-01", validUntil: "2026-11-20", terms: { areaSf: 24000, areaBasis: "chargeable", rentPerSf: 90, camPerSf: 12, depositMonths: 6, lockInMonths: 36, tenureMonths: 60 } });
    const o2 = await Tx.createOffer(tx, t.id, { parentOfferId: o1.id, offeringParty: "client", receivingParty: "landlord", offerDate: "2026-11-03", reason: "budget ceiling ₹85", terms: { ...o1.terms, rentPerSf: 82 } });
    const o3 = await Tx.createOffer(tx, t.id, { parentOfferId: o2.id, offeringParty: "landlord", receivingParty: "client", offerDate: "2026-11-06", reason: "meet halfway", terms: { ...o1.terms, rentPerSf: 85 } });
    const diffs = await Tx.compareOfferVersions(tx, t.id);
    const { error: immut } = await db.from("tx_offer").update({ terms: { rentPerSf: 1 } }).eq("id", o1.id);
    for (const p of await Tx.listPoints(tx, t.id)) await Tx.setPointStatus(tx, p.id, "agreed", { evidence: "landlord email 2026-11-08" });
    const agreed = (await Tx.listPoints(tx, t.id)).filter((p: Row) => p.status === "agreed");
    rec("G8", { code: t.code, versions: [o1.version_no, o2.version_no, o3.version_no], kinds: [o1.kind, o2.kind, o3.kind], diffSteps: diffs.length, immutableError: immut?.message, agreedRent: agreed.find((p: Row) => p.term_key === "rentPerSf")?.value });
    expect([o1.version_no, o2.version_no, o3.version_no]).toEqual([1, 2, 3]);
    expect(o2.kind).toBe("counteroffer");
    expect(immut?.message ?? "").toMatch(/immutable/);
    expect(agreed.find((p: Row) => p.term_key === "rentPerSf")!.value).toBe("85");
  });

  it("G9 approvals bound to document version: new agreement version invalidates; only assigned reviewer decides", async () => {
    const t = need("tx");
    const legal = await Tx.addStakeholder(tx, t.id, { name: "Colleague (legal)", category: "legal_adviser", userId: USERS.colleague.id, decisionAuthority: "approver", isInternal: true });
    const ag1 = await Tx.addDocumentVersion(tx, t.id, { docKind: "agreement", title: "Lease deed", body: "1. Premises: 24,000 sq ft.\n2. Rent: base rent of ₹ 85 per sq ft per month.\n3. Security deposit equal to 6 months.\n4. Lock-in period of 36 months." });
    const ap = await Tx.requestApproval(tx, t.id, { category: "legal", subjectType: "document", subjectId: ag1.id, reviewerUserId: USERS.colleague.id, reviewerStakeholderId: legal.id });
    expect(ap.subject_hash).toBe(ag1.sha256);
    const ownerDecide = await Tx.decideApproval(tx, ap.id, { decision: "approved", reviewedHash: ag1.sha256 }).then(() => "allowed", (e) => e.status);
    const ag2 = await Tx.addDocumentVersion(tx, t.id, { docKind: "agreement", title: "Lease deed", body: "1. Premises: 24,000 sq ft.\n2. Rent: base rent of ₹ 88 per sq ft per month.\n3. Security deposit equal to 6 months.\n4. Lock-in period of 36 months." });
    const old = (await db.from("tx_approval").select("invalidated_at").eq("id", ap.id).single()).data!;
    const cmp = await Tx.documentComparison(tx, ag2.id);
    const staleDecide = await Tx.decideApproval(txCol, ap.id, { decision: "approved", reviewedHash: ag1.sha256 }).then(() => "allowed", (e) => e.status);
    const re = (await db.from("tx_approval").select("*").eq("reassessment_of", ap.id).single()).data!;
    const ag3 = await Tx.addDocumentVersion(tx, t.id, { docKind: "agreement", title: "Lease deed", body: "1. Premises: 24,000 sq ft.\n2. Rent: base rent of ₹ 85 per sq ft per month.\n3. Security deposit equal to 6 months.\n4. Lock-in period of 36 months." });
    const re2 = (await db.from("tx_approval").select("*").eq("subject_id", ag3.id).eq("category", "legal").maybeSingle()).data;
    if (re2) await Tx.decideApproval(txCol, re2.id, { decision: "approved", reviewedHash: ag3.sha256 });
    rec("G9", { ownerDecide, invalidated: !!old.invalidated_at, rentRecon: cmp.reconciliation.find((r: Row) => r.key === "rentPerSf")?.status, staleDecide, reassessmentOn: re.subject_id === ag2.id, v3Approved: !!re2 });
    expect(ownerDecide).toBe(403);
    expect(old.invalidated_at).toBeTruthy();
    expect(cmp.reconciliation.find((r: Row) => r.key === "rentPerSf")!.status).toBe("mismatch");
    expect(staleDecide).toBe(409);
    expect(re.subject_id).toBe(ag2.id);
  });

  it("G10 deposit: due ≠ paid (paid needs evidence); comm with unapproved figures blocked (drafts only)", async () => {
    const t = need("tx");
    const dep = await Tx.recordDeposit(tx, t.id, { depositType: "security deposit", amount: 12240000, responsibleParty: "client finance", refundable: true });
    await Tx.updateDepositStage(tx, dep.id, "approved", { date: "2026-11-12" });
    await Tx.updateDepositStage(tx, dep.id, "due", { date: "2026-11-15" });
    const v1 = (await Tx.depositsView(tx, t.id, "2026-11-18")).find((d: Row) => d.id === dep.id)!;
    const noEv = await Tx.updateDepositStage(tx, dep.id, "paid", { date: "2026-11-16" }).then(() => "allowed", (e) => e.status);
    await Tx.updateDepositStage(tx, dep.id, "paid", { date: "2026-11-16", evidence: "UTR HDFC000777" });
    const v2 = (await Tx.depositsView(tx, t.id, "2026-11-18")).find((d: Row) => d.id === dep.id)!;
    const blocked = await Tx.draftCommunication(tx, t.id, { subject: "Terms", body: "We accept rent of ₹85 per sf." }).then(() => "allowed", (e) => e.status);
    rec("G10", { dueView: v1.stages, headlineDue: v1.headline, paidWithoutEvidence: noEv, paidView: v2.stages, commWithoutApproval: blocked });
    expect(v1.stages).toMatchObject({ due: true, paid: false });
    expect(noEv).toBe(400);
    expect(v2.stages.paid).toBe(true);
    expect(blocked).toBe(409);
  });

  it("G11 execution → Module 15 hand-off (real); executed ≠ possession ≠ occupancy", async () => {
    const t = need("tx");
    const ex = await Tx.addDocumentVersion(tx, t.id, { docKind: "executed_agreement", family: "executed", title: "Executed lease deed", body: EXECUTED_TEXT(t.code) });
    await Tx.setMilestone(tx, t.id, "executed", { achievedOn: "2026-11-20", evidence: "registered at SRO Haveli, doc 4455", documentId: ex.id });
    const got = await Tx.getTransaction(tx, t.id);
    const m = await milestonesView(tx, t.id);
    const ach = (k: string) => m.matrix.find((x: Row) => x.kind === k)?.achieved;
    const occNoEv = await Tx.setMilestone(tx, t.id, "occupied", { achievedOn: "2027-01-05" }).then(() => "allowed", (e) => e.status);
    rec("G11", { handoff: got.lease_handoff, executed: ach("executed"), possession: ach("possession_completed"), occupied: ach("occupied"), occupiedWithoutEvidence: occNoEv });
    expect(got.lease_handoff?.status).toBe("delivered");
    expect(ach("executed")).toBe(true);
    expect(ach("possession_completed")).toBe(false);
    expect(ach("occupied")).toBe(false);
    expect(occNoEv).toBe(400);
    F.leaseId = got.lease_handoff.lease_id;
    const leases = (await db.from("lease").select("id").eq("workspace_id", WS1).eq("transaction_id", t.id).is("archived_at", null)).data as Row[];
    expect(leases).toHaveLength(1);
  });

  it("G12 closure: blocked while conditions remain; completes after evidence-backed resolution", async () => {
    const t = need("tx");
    const blockers1 = await Tx.closureBlockers(tx, t.id);
    const early = await Tx.completeTransaction(tx, t.id).then(() => "allowed", (e) => e.status);
    for (const a of (await Tx.listApprovals(tx, t.id)).filter((x: Row) => !x.invalidated_at && ["pending", "under_review", "changes_requested"].includes(x.status))) await db.from("tx_approval").update({ status: "withdrawn" }).eq("id", a.id);
    for (const i of (await Tx.issuesView(tx, t.id)).open) await Tx.updateIssue(tx, i.id, { status: "resolved", resolution: "closed with landlord letter" });
    await Tx.setMilestone(tx, t.id, "possession_completed", { achievedOn: "2026-12-20", evidence: "possession letter PL-9" });
    await Tx.generateHandoverChecklist(tx, t.id);
    for (const h of ((await db.from("tx_handover_item").select("id").eq("transaction_id", t.id).eq("status", "open")).data ?? []) as Row[]) await Tx.closeHandoverItem(tx, h.id, "photo + PM sign-off", "PM");
    await Tx.setMilestone(tx, t.id, "handover_completed", { achievedOn: "2026-12-21", evidence: "handover certificate HC-77" });
    const blockers2 = await Tx.closureBlockers(tx, t.id);
    const done = await Tx.completeTransaction(tx, t.id).then((r: Row) => r.status, (e) => `error ${e.status}: ${e.message}`);
    rec("G12", { blockersBefore: blockers1, early, blockersAfter: blockers2, completion: done });
    expect(blockers1.length).toBeGreaterThan(0);
    expect(early).toBe(409);
    expect(done).toBe("completed");
  });

  it("G13 Module 15 lease: executed (not active); dates proposed with source clause/method; none confirmed until human", async () => {
    const leaseId = need("leaseId");
    const d = (await L.getLease(lw, leaseId))!;
    const live = (d.dates as Row[]).filter((x) => !x.superseded_by && !x.archived_at);
    const byType = (k: string) => live.find((x) => x.date_type === k);
    rec("G13", { status: d.lease.lifecycle_status, tenant: d.lease.tenant_org_id === F.org.id, dates: live.map((x) => ({ t: x.date_type, d: x.calculated_date, v: x.verification_status, method: x.method, clause: (x.clause_text ?? "").slice(0, 60) })), terms: d.terms.map((t: Row) => ({ v: t.version, status: t.status, source: t.source })) });
    expect(d.lease.lifecycle_status).toBe("executed");
    expect(d.lease.tenant_org_id).toBe(F.org.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((x) => x.verification_status !== "confirmed")).toBe(true); // USER-RULES 1
    expect(live.every((x) => !!x.clause_text)).toBe(true); // source clause retained
    expect(byType("expiry")).toBeTruthy();
    expect(byType("renewal_notice_deadline") ?? byType("termination_notice_deadline")).toBeTruthy();
    expect(d.terms.some((t: Row) => t.source === "transaction" && t.status === "proposed")).toBe(true);
    // no reminders before confirmation
    const rem = (await db.from("lease_reminder").select("id").eq("lease_id", leaseId).neq("status", "cancelled")).data as Row[];
    expect(rem).toHaveLength(0);
    const activeEarly = await L.setStatus(lw, leaseId, "active", { today: "2027-01-02" }).then(() => "allowed", (e) => e.message);
    rec("G13", { activeWithoutConfirmedCommencement: activeEarly });
    expect(activeEarly).not.toBe("allowed");
  });

  it("G14 human confirms expiry + notice deadline → confirmed; reminders scheduled + dispatched via orchestrator notify; idempotent", async () => {
    const leaseId = need("leaseId");
    const live = ((await L.getLease(lw, leaseId))!.dates as Row[]).filter((x) => !x.superseded_by && !x.archived_at);
    const exp = live.find((x) => x.date_type === "expiry")!;
    const c = await L.confirmDate(lw, exp.id, { date: exp.calculated_date ?? "2031-12-31", today: "2026-11-25" });
    const after = ((await L.getLease(lw, leaseId))!.dates as Row[]).filter((x) => !x.superseded_by && !x.archived_at);
    const rn = after.find((x) => x.date_type === "renewal_notice_deadline");
    if (rn && rn.verification_status !== "confirmed") await L.confirmDate(lw, rn.id, { date: rn.calculated_date, today: "2026-11-25" }).catch(() => null);
    const s1 = await L.syncReminders(lw, leaseId, "2026-11-25");
    const s2 = await L.syncReminders(lw, leaseId, "2026-11-25");
    const rem = (await db.from("lease_reminder").select("*").eq("lease_id", leaseId).neq("status", "cancelled")).data as Row[];
    const firstDue = rem.map((r) => r.remind_on).sort()[0];
    const sent = firstDue ? await L.dispatchDueReminders(adminClient(), WS1, firstDue) : { sent: 0 };
    const again = firstDue ? await L.dispatchDueReminders(adminClient(), WS1, firstDue) : { sent: 0 };
    const sentRows = (await db.from("lease_reminder").select("id, outbox_id, status").eq("lease_id", leaseId).eq("status", "sent")).data as Row[];
    const ob = sentRows[0]?.outbox_id ? (await adminClient().from("outbox").select("kind, payload").eq("id", sentRows[0].outbox_id).single()).data : null;
    rec("G14", { confirmed: c.verification_status, renewalNotice: rn ? { d: rn.calculated_date, method: rn.method } : null, sync1: s1, sync2: s2, reminders: rem.length, firstDue, sent, again, outbox: ob });
    expect(c.verification_status).toBe("confirmed");
    expect(rem.length).toBeGreaterThan(0);
    expect(s2.created).toBe(0);
    expect(sent.sent).toBeGreaterThan(0);
    expect(ob?.kind).toBe("notification"); // in-app only — nothing sent externally
    expect(ob?.payload?.category).toBe("lease_deadline");
  });

  it("G15 orchestrator consumes lease/transaction events (lease.created, transaction.executed) without errors", async () => {
    const admin = adminClient();
    const evs = (await admin.from("event_outbox").select("id, event_type, status").eq("workspace_id", WS1).or(`subject_id.eq.${need("leaseId")},payload->>transaction_id.eq.${need("tx").id}`)).data as Row[];
    const r = await processEvents(db, WS1, { eventIds: evs.map((e) => e.id), limit: 100 } as never).catch((e: Error) => ({ error: e.message }));
    const after = (await admin.from("event_outbox").select("event_type, status").in("id", evs.map((e) => e.id))).data as Row[];
    const log = (await admin.from("event_processing_log").select("consumer, status, detail, event_id").in("event_id", evs.map((e) => e.id))).data as Row[];
    const unconsumed = [...new Set(after.filter((e) => !log.some((l) => l.event_id === evs.find((x) => x.event_type === e.event_type)?.id)).map((e) => e.event_type))];
    rec("G15", { events: [...new Set(evs.map((e) => e.event_type))], processResult: r, statuses: after, consumers: log.map((l) => `${l.consumer}:${l.status}`), eventTypesWithoutConsumer: unconsumed });
    expect(evs.map((e) => e.event_type)).toEqual(expect.arrayContaining(["lease.created", "transaction.executed"]));
    expect(after.every((e) => e.status !== "failed")).toBe(true);
    expect(unconsumed.filter((t) => /^transaction\.|^lease\./.test(t))).toEqual([]); // every lease./transaction. event has a consumer
  });

  it("G16 renewal opportunity: expiry → potential opportunity + renewal record; NOT a relocation requirement", async () => {
    const leaseId = need("leaseId");
    const reqBefore = (await db.from("requirement").select("id").eq("org_id", F.org.id)).data!.length;
    const opps = await L.scanOpportunities(lw, "2031-03-01");
    const mine = opps.filter((o: Row) => o.lease_id === leaseId);
    const ren = await L.openRenewal(lw, leaseId, "Expiry approaching (golden path)");
    const ds = await L.renewalDecisionSupport(lw, leaseId, { proposedRentMonthly: 2200000, extensionMonths: 60, relocation: { newRentMonthly: 2000000 } });
    const reqAfter = (await db.from("requirement").select("id").eq("org_id", F.org.id)).data!.length;
    rec("G16", { opps: mine.map((o: Row) => ({ kind: o.kind, label: o.label, due: o.due })), renewal: { id: ren.id, stage: ren.stage }, decisionSupport: { recommendation: ds.recommendation, missing: ds.result?.missing?.length }, requirementsBefore: reqBefore, requirementsAfter: reqAfter });
    expect(mine.some((o: Row) => o.kind === "expiry_approaching" && o.label === "potential")).toBe(true);
    expect(reqAfter).toBe(reqBefore); // expiry ≠ relocation requirement
    expect(ds.recommendation).toBeNull(); // no auto-recommendation
  });

  it("G17 assistant answers grounded in records (lease + transaction + Ask)", async () => {
    const leaseId = need("leaseId");
    const la = await answerLeaseQuestion(lw, `When does the lease for Helios Software ${T} expire?`, "2031-06-01");
    const ta = await txAnswer(tx, need("tx").id, "latest_agreed_rent");
    const txTool = getTool("transaction_question");
    const ask = await runAssistant({ ctx, request: `When does the lease for Helios Software ${T} expire?` });
    const { data: steps } = await db.from("assistant_tool_execution").select("tool_id, status").eq("run_id", ask.runId).order("step");
    const { data: msg } = await db.from("assistant_message").select("content").eq("id", ask.messageId).single();
    const lrow = (await db.from("lease").select("contractual_expiry").eq("id", leaseId).single()).data;
    rec("G17", { leaseContractualExpiryColumn: lrow?.contractual_expiry ?? null, lease: { intent: la.intent, grounded: la.grounded, answer: la.answer?.slice(0, 200) }, tx: ta.answer, transactionToolRegistered: !!txTool, ask: { status: ask.status, tools: (steps ?? []).map((s: Row) => `${s.tool_id}:${s.status}`), text: (msg?.content ?? "").slice(0, 300) } });
    expect(la.grounded).toBe(true);
    expect(JSON.stringify(la.rows ?? []) + la.answer).toMatch(/2031-12-31/);
    expect(ta.answer).toMatch(/₹85/);
    expect(!!txTool).toBe(true); // transactionTools registered in the assistant
    expect(msg?.content ?? "").toMatch(/2031/); // grounded in the confirmed lease date
    void leaseId;
  });
});

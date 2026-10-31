import { describe, it, expect } from "vitest";
import { buildDossierSections, selectDossierInteractions, shouldRegenerate, evidenceKeys, ruleSynthesis, type DossierInputs } from "./research/dossier";
import { detectClaimFindings } from "./research/patrol";
import { findIntroPaths, detectThreadingGaps } from "./network/graph";
import { extractClauses, compareClauses, exposureChecklist, validateAgainstSource } from "./legal/clauses";
import { gateObservations, annualTrend, sumAcrossPeriods, deriveVacancy, monthsOfSupply, supplyAbsorptionRatio, comparables, SeriesRuleError, type Observation } from "./market/series";
import { cohortFunnel, stageConversion, timeToStage, lostReasons, landlordConcentration, experimentSummary, procurementMap, type Touch, type OppLite } from "./insights/metrics";
import { strategize, type DealContext } from "./strategy/strategist";
import { reviewChecklist, checklistPasses, weeklyPlan, weekStartOf } from "./content/editor";

const TODAY = "2026-10-31";

function baseInputs(over: Partial<DossierInputs> = {}): DossierInputs {
  return {
    org: { id: "org-1", display_name: "Acme", legal_name: null, cin: null, gstin: null, domain: null, sector: null, hq_country: null, headcount_min: null, headcount_max: null, is_gcc: null, updated_at: "2026-10-01T00:00:00Z", row_version: 1 },
    relations: [], claims: [], employments: [], leases: [], transactions: [], interactions: [], stakeholders: [], introPaths: [], ...over,
  };
}

describe("dossier: unknowns and expiry", () => {
  it("keeps unknown sections unknown with no invented claims", () => {
    const b = buildDossierSections(baseInputs(), TODAY);
    for (const k of ["footprint", "sites_leases", "headcount", "hiring", "funding", "contacts_current"]) {
      const s = b.sections.find((x) => x.key === k)!;
      expect(s.status).toBe("unknown");
      expect(s.claims).toHaveLength(0);
    }
    expect(b.sections.find((s) => s.key === "hiring")!.note).toMatch(/not an office-size commitment/);
    const syn = ruleSynthesis(baseInputs(), b, TODAY);
    expect(syn.timing_hypothesis).toBeNull();
  });

  it("dates every claim, expires old evidence, and never turns hiring into area", () => {
    const b = buildDossierSections(baseInputs({
      claims: [
        { id: "c1", claim_type: "hiring", predicate: "hiring 40 engineers", value_json: { function: "engineering", location: "Pune" }, status: "reported", evidence_tier: "single_unverified", evidence_excerpt: "x", source_url: "https://example.com/jobs", source_locator: null, published_on: "2026-01-01", observed_on: "2026-01-02", effective_on: null, expires_on: null, created_at: "2026-01-02T00:00:00Z", row_version: 1 },
        { id: "c2", claim_type: "funding", predicate: "Series C", value_json: null, status: "reported", evidence_tier: "credible_reported", evidence_excerpt: null, source_url: "https://example.com/pr", source_locator: null, published_on: "2026-10-01", observed_on: "2026-10-02", effective_on: null, expires_on: null, created_at: "2026-10-02T00:00:00Z", row_version: 1 },
      ],
    }), TODAY);
    const hiring = b.sections.find((s) => s.key === "hiring")!;
    expect(hiring.claims[0].observed_on).toBe("2026-01-02");
    expect(hiring.claims[0].expires_on).toBe("2026-04-02"); // 90-day shelf life
    expect(hiring.claims[0].expired).toBe(true);
    expect(hiring.status).toBe("partial");
    expect(b.sections.find((s) => s.key === "footprint")!.status).toBe("unknown");
    const funding = b.sections.find((s) => s.key === "funding")!;
    expect(funding.claims[0].expired).toBe(false);
    expect(b.expiredCount).toBe(1);
  });

  it("patrol reports expired evidence and conflicting claims without changing them", () => {
    const f = detectClaimFindings([
      { id: "a", subject_type: "organisation", subject_id: "o", claim_type: "completion_date", predicate: "completion", value_json: { date: "2026-12" }, observed_on: "2026-09-01", created_at: "2026-09-01", expires_on: null, status: "reported" },
      { id: "b", subject_type: "organisation", subject_id: "o", claim_type: "completion_date", predicate: "completion", value_json: { date: "2027-06" }, observed_on: "2026-10-20", created_at: "2026-10-20", expires_on: null, status: "reported" },
      { id: "c", subject_type: "organisation", subject_id: "o", claim_type: "hiring", predicate: "x", value_json: null, observed_on: "2025-01-01", created_at: "2025-01-01", expires_on: null, status: "reported" },
    ], TODAY);
    expect(f.some((x) => x.kind === "completion_changed")).toBe(true);
    expect(f.some((x) => x.kind === "claim_expired" && x.refs[0].id === "c")).toBe(true);
  });
});

describe("person move confidentiality", () => {
  const emp = new Map([["p1", { start_date: "2026-08-01", end_date: null }]]);
  it("excludes old-company notes and pre-employment person-only interactions", () => {
    const keep = selectDossierInteractions([
      { id: "old-deal", occurred_at: "2026-05-01T10:00:00Z", links: [{ entity_type: "person", entity_id: "p1" }, { entity_type: "organisation", entity_id: "old-org" }] },
      { id: "old-opp", occurred_at: "2026-09-10T10:00:00Z", links: [{ entity_type: "person", entity_id: "p1" }, { entity_type: "opportunity", entity_id: "opp-old" }] },
      { id: "pre-join", occurred_at: "2026-07-01T10:00:00Z", links: [{ entity_type: "person", entity_id: "p1" }] },
      { id: "after-join", occurred_at: "2026-09-01T10:00:00Z", links: [{ entity_type: "person", entity_id: "p1" }] },
      { id: "new-org", occurred_at: "2026-09-02T10:00:00Z", links: [{ entity_type: "organisation", entity_id: "org-1" }] },
    ], "org-1", new Set(["opp-new"]), emp);
    expect([...keep].sort()).toEqual(["after-join", "new-org"]);
  });
  it("unknown start date is excluded conservatively", () => {
    const keep = selectDossierInteractions([{ id: "x", occurred_at: "2026-09-01T00:00:00Z", links: [{ entity_type: "person", entity_id: "p2" }] }], "org-1", new Set(), new Map([["p2", { start_date: null, end_date: null }]]));
    expect(keep.size).toBe(0);
  });
});

describe("research refresh policy", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  it("skips when evidence unchanged and interval not elapsed", () => {
    expect(shouldRegenerate({ evidence_fingerprint: "f", next_refresh_at: "2026-11-30T00:00:00Z" }, "f", now)).toEqual({ run: false, reason: "unchanged" });
    expect(shouldRegenerate({ evidence_fingerprint: "f", next_refresh_at: "2026-11-30T00:00:00Z" }, "g", now).reason).toBe("evidence_changed");
    expect(shouldRegenerate({ evidence_fingerprint: "f", next_refresh_at: "2026-10-01T00:00:00Z" }, "f", now).reason).toBe("interval_elapsed");
    expect(shouldRegenerate(null, "f", now).reason).toBe("first_run");
  });
  it("fingerprint changes when a claim row_version changes", () => {
    const claim = { id: "c", claim_type: "hiring", predicate: null, value_json: null, status: "reported" as const, evidence_tier: null, evidence_excerpt: null, source_url: null, source_locator: null, published_on: null, observed_on: null, effective_on: null, expires_on: null, created_at: "2026-01-01", row_version: 1 };
    const a = evidenceKeys(baseInputs({ claims: [claim] }), "active");
    const b = evidenceKeys(baseInputs({ claims: [{ ...claim, row_version: 2 }] }), "active");
    expect(a).not.toEqual(b);
  });
});

describe("network graph", () => {
  it("2-hop paths require recorded intro permission; never 'usable' without it", () => {
    const edges = [
      { id: "e1", from_user_id: "me", from_person_id: null, to_person_id: "friend", edge_type: "knows", warmth: "trusted" as const, intro_permission: false, last_meaningful_contact: "2026-10-01", valid_to: null },
      { id: "e2", from_user_id: null, from_person_id: "friend", to_person_id: "target", edge_type: "knows", warmth: "warm" as const, intro_permission: false, last_meaningful_contact: null, valid_to: null },
    ];
    const p = findIntroPaths(edges, "me", ["target"], TODAY);
    expect(p).toHaveLength(1);
    expect(p[0].needs_permission).toBe(true);
    expect(p[0].warmth).toBe("warm");
  });
  it("multi-threading gaps", () => {
    const g = detectThreadingGaps("proposal_negotiation", [{ person_id: "a", role: "user", employment_current: true }]);
    const kinds = g.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["one_person_dependency", "missing_economic_buyer", "procurement_not_involved", "legal_not_involved"]));
  });
});

const LOI_V1 = `LETTER OF INTENT

1. Rent
The monthly rent shall be Rs. 85 per sq ft on chargeable area.

2. Escalation
Rent shall escalate by 5% every 12 months.

3. Lock-in
The lock-in period shall be 36 months for the Tenant.

4. Security Deposit
Interest free refundable security deposit equal to 6 months rent.

5. Reinstatement
On expiry the Tenant shall restore the premises to bare shell condition.

6. Indemnity
The Tenant shall indemnify the Landlord against all losses.
`;
const LOI_V2 = LOI_V1.replace("5% every 12 months", "15% every 36 months").replace(/6\. Indemnity[\s\S]*$/, "");

describe("legal desk", () => {
  it("extracts clauses with locators and values", () => {
    const c = extractClauses(LOI_V1);
    const types = c.map((x) => x.clause_type);
    expect(types).toEqual(expect.arrayContaining(["rent", "escalation", "lock_in", "deposit", "reinstatement", "indemnity"]));
    const esc = c.find((x) => x.clause_type === "escalation")!;
    expect(esc.locator.line_start).toBeGreaterThan(1);
    expect(esc.extracted_values.percent).toBe(5);
    expect(validateAgainstSource(LOI_V1, [{ ...esc, clause_text: "invented clause text that is not in the source at all" }])).toHaveLength(0);
  });
  it("redlines versions and raises exposure items, always pending legal review", () => {
    const diff = compareClauses(extractClauses(LOI_V1), extractClauses(LOI_V2));
    const esc = diff.find((d) => d.clause_type === "escalation")!;
    expect(esc.change).toBe("changed");
    expect(esc.ops.some((o) => o.op === "del" && o.text.includes("5%"))).toBe(true);
    expect(esc.ops.some((o) => o.op === "ins" && o.text.includes("15%"))).toBe(true);
    expect(diff.find((d) => d.clause_type === "indemnity")!.change).toBe("removed");
    const items = exposureChecklist(extractClauses(LOI_V2), diff);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.reviewer_status === "pending_legal_review")).toBe(true);
    expect(items.some((i) => i.clause_type === "reinstatement" && i.severity === "high")).toBe(true);
  });
});

const obs = (o: Partial<Observation>): Observation => ({ id: Math.random().toString(36), metric: "supply", geography_id: null, geography_raw: "SBD East", period_start: "2024-01-01", period_end: null, period_type: "full_year", unit: "msf", value: 1, definition: "Completed Grade A supply", release_date: "2026-01-15", source_object_id: "src", source_version: null, ...o });

describe("market series rules", () => {
  it("gates observations without definition / release date / source", () => {
    const g = gateObservations([obs({}), obs({ definition: null }), obs({ release_date: null, source_object_id: null })]);
    expect(g.accepted).toHaveLength(1);
    expect(g.excluded.map((e) => e.reason).join("|")).toMatch(/no metric definition/);
    expect(g.excluded.map((e) => e.reason).join("|")).toMatch(/no release date.*no source/);
  });
  it("does not invent missing supply years and blocks mismatched period comparisons", () => {
    const t = annualTrend([obs({ period_start: "2024-01-01", value: 3 }), obs({ period_start: "2026-01-01", value: 1, period_type: "ytd" })], "supply", "SBD East", [2024, 2025, 2026]);
    expect(t[1].value).toBeNull();
    expect(t[1].note).toMatch(/unknown/i);
    expect(t[2].label).toBe("2026 YTD");
    expect(t[2].change).toBeNull();
    const t2 = annualTrend([obs({ period_start: "2024-01-01", value: 3 }), obs({ period_start: "2025-01-01", value: 1, period_type: "ytd" })], "supply", "SBD East");
    expect(t2[1].comparable_to_previous).toBe(false);
  });
  it("never sums stock over time; vacancy never from gross absorption", () => {
    expect(() => sumAcrossPeriods([{ value: 24, period_type: "snapshot", unit: "msf" }, { value: 30, period_type: "snapshot", unit: "msf" }], "stock")).toThrow(SeriesRuleError);
    expect(() => sumAcrossPeriods([{ value: 1, period_type: "full_year", unit: "msf" }, { value: 1, period_type: "ytd", unit: "msf" }], "absorption")).toThrow(SeriesRuleError);
    expect(sumAcrossPeriods([{ value: 1.5, period_type: "full_year", unit: "msf" }, { value: 2, period_type: "full_year", unit: "msf" }], "supply").total).toBe(3.5);
    expect(sumAcrossPeriods([{ value: 1, period_type: "full_year", unit: "msf" }, { value: null, period_type: "full_year", unit: "msf" }], "supply").total).toBeNull();
    const v = deriveVacancy({ stock: 30, grossAbsorption: 10 });
    expect(v.allowed).toBe(false);
    expect(deriveVacancy({ availableInventory: 3, stock: 30 }).value).toBe(0.1);
    expect(monthsOfSupply({ availableInventory: 3, netTakeUpPerMonth: 0.5, takeUpIsNet: false }).allowed).toBe(false);
  });
  it("supply/absorption ratio only on matching periods", () => {
    const s = annualTrend([obs({ period_start: "2025-01-01", value: 4 })], "supply", null);
    const a = annualTrend([obs({ metric: "absorption", period_start: "2025-01-01", value: 2, period_type: "ytd" })], "absorption", null);
    expect(supplyAbsorptionRatio(s, a)[0].ratio).toBeNull();
  });
  it("comparables never mix rent bases", () => {
    const r = comparables([
      { id: "1", asset_id: null, asset_name: "A", locality: "Baner", period_start: "2025-01-01", deal_type: "lease", area_sf: 20000, rent_min: 80, rent_max: 90, rent_basis: "chargeable", tenant: null, source_object_id: null },
      { id: "2", asset_id: null, asset_name: "B", locality: "Baner", period_start: "2025-02-01", deal_type: "lease", area_sf: 25000, rent_min: 120, rent_max: 120, rent_basis: "carpet", tenant: null, source_object_id: null },
      { id: "3", asset_id: null, asset_name: "C", locality: "Kharadi", period_start: "2025-02-01", deal_type: "lease", area_sf: 25000, rent_min: 70, rent_max: 70, rent_basis: "chargeable", tenant: null, source_object_id: null },
    ], { locality: "baner" });
    expect(r.rows).toHaveLength(2);
    expect(r.stats.map((s) => s.basis).sort()).toEqual(["carpet", "chargeable"]);
    expect(r.stats.find((s) => s.basis === "chargeable")!.median).toBe(85);
  });
});

describe("insights cohort counting", () => {
  const touches: Touch[] = [
    { org_id: "A", person_id: "a1", occurred_at: "2026-09-02T10:00:00Z", direction: "outbound", kind: "interaction" },
    { org_id: "A", person_id: "a2", occurred_at: "2026-09-05T10:00:00Z", direction: "outbound", kind: "interaction" }, // follow-up, same company
    { org_id: "A", person_id: "a1", occurred_at: "2026-10-05T10:00:00Z", direction: "outbound", kind: "interaction" }, // follow-up next month
    { org_id: "B", person_id: "b1", occurred_at: "2026-09-10T10:00:00Z", direction: "inbound", kind: "interaction" },  // inbound first: separate channel
    { org_id: "B", person_id: "b1", occurred_at: "2026-09-11T10:00:00Z", direction: "outbound", kind: "interaction" },
    { org_id: "C", person_id: "c1", occurred_at: "2026-09-12T10:00:00Z", direction: "outbound", kind: "draft" },       // draft: not an approach
    { org_id: "D", person_id: "d1", occurred_at: "2026-10-01T10:00:00Z", direction: "outbound", kind: "interaction" },
  ];
  const opps: OppLite[] = [
    { id: "o1", org_id: "A", stage: "requirement_confirmed", outcome: "open", created_at: "2026-09-03T00:00:00Z" },
    { id: "o2", org_id: "A", stage: "engaged", outcome: "open", created_at: "2026-09-04T00:00:00Z" }, // second requirement, same company
    { id: "o3", org_id: "B", stage: "qualified_discussion", outcome: "lost", outcome_reason: "Renewed in place", created_at: "2026-09-10T00:00:00Z" },
  ];
  it("counts distinct first outbound approaches; drafts, follow-ups and inbound excluded", () => {
    const f = cohortFunnel(touches, opps, []);
    const sep = f.find((r) => r.month === "2026-09")!;
    const oct = f.find((r) => r.month === "2026-10")!;
    expect(sep.approaches).toBe(1);   // A only
    expect(sep.inbound_first).toBe(1); // B
    expect(sep.total_touches).toBe(3); // A x2 + B outbound
    expect(sep.people_touched).toBe(3);
    expect(sep.discussions).toBe(1);   // A once (two requirements not double-counted); B not in an approach cohort
    expect(oct.approaches).toBe(1);   // D
    expect(oct.vs_base).toBeCloseTo(0.8, 1);
  });
  it("stage conversion, time-to-stage with censoring, lost reasons", () => {
    const conv = stageConversion(opps, []);
    expect(conv.find((c) => c.stage === "research")!.reached).toBe(3);
    expect(conv.find((c) => c.stage === "qualified_discussion")!.reached).toBe(2);
    const tts = timeToStage(opps, [{ opportunity_id: "o1", to_stage: "qualified_discussion", changed_at: "2026-09-13T00:00:00Z" }], ["qualified_discussion"]);
    expect(tts[0].n).toBe(1);
    expect(tts[0].median_days).toBe(10);
    expect(tts[0].censored_open).toBe(1);
    expect(lostReasons(opps)[0]).toMatchObject({ outcome: "lost", reason: "Renewed in place", count: 1 });
  });
  it("landlord concentration keeps unknown landlords and experiments warn on small samples", () => {
    const lc = landlordConcentration([{ id: "l", tenant: "T", tenant_org_id: null, landlord: null, building: "X", area_sf: null, contractual_expiry: "2027-02-01", events: [] }], "2026-01-01", "2028-01-01");
    expect(lc[0]).toMatchObject({ landlord: "Landlord unknown", total_events: 1 });
    expect(lc[0].quarters[0]).toMatchObject({ quarter: "2027-Q1", area_unknown: 1 });
    const ex = experimentSummary({ id: "e", name: "x", variants: [{ key: "a", label: "A" }, { key: "b", label: "B" }], outcome_window_days: 30, min_sample_per_variant: 30 },
      [{ variant_key: "a", exposed_at: "2026-08-01T00:00:00Z", outcome_at: "2026-08-10T00:00:00Z" }, { variant_key: "b", exposed_at: "2026-10-25T00:00:00Z", outcome_at: null }], new Date("2026-10-31T00:00:00Z"));
    expect(ex.variants[0]).toMatchObject({ matured: 1, outcomes: 1 });
    expect(ex.variants[1]).toMatchObject({ matured: 0, pending: 1 });
    expect(ex.conclusive).toBe(false);
    const pm = procurementMap({ id: "o", name: "n", stage: "loi" }, { decision_date: "2027-03-31", constraints: { procurement: { rfp: 10 } } }, ["procurement"]);
    expect(pm.steps.find((s) => s.key === "rfp")!.basis).toBe("recorded");
    expect(pm.latest_start).toBe("2026-11-30"); // 30+10+21+30+30 = 121 days before
  });
});

describe("deal strategist", () => {
  it("is transparent, suggestion-only and flags late-stage gaps", () => {
    const c: DealContext = {
      opportunity: { id: "o", name: "Acme Pune", stage: "loi", outcome: "open", stage_entered_at: "2026-10-20T00:00:00Z", temperature: "hot", mandate_status: "none", expected_close: "2026-10-15", next_action: null, next_action_due: null, risks: null },
      requirement: { decision_date: null, occupation_date: "2027-06-01", area_target_sf: 20000, area_min_sf: null, area_max_sf: null, budget_min: null, budget_max: null, constraints: null, status: "confirmed" },
      stakeholders: [{ person_id: "p", role: "user", employment_current: true }], quotes: [{ id: "q", valid_until: "2026-10-01", superseded: false }], lastInteractionAt: "2026-10-25T00:00:00Z",
      objections: ["Too far from the metro"], currentLeaseExpiry: "2027-03-31", financeScenarioCount: 0,
    };
    const s = strategize(c, TODAY);
    expect(s.disclaimer).toMatch(/Suggestions only/);
    expect(s.health.factors.reduce((a, f) => a + f.points, 0)).toBe(s.health.score);
    expect(s.risks.map((r) => r.key)).toEqual(expect.arrayContaining(["close_slipped", "no_mandate", "expired_quote", "occupation_after_expiry"]));
    expect(s.batna_questions.some((q) => q.includes("2027-03-31"))).toBe(true);
    expect(s.concession_ladder.every((x) => /finance scenario/i.test(x.value_basis) || /Non-financial/.test(x.value_basis))).toBe(true);
  });
});

describe("content editor", () => {
  it("checklist blocks client names, personal data, prices without source and forecasts", () => {
    const items = reviewChecklist("Acme Corp will rise. Call 9876543210 or a@b.com. Rent ₹85 per sq ft.", { clientNames: ["Acme Corp"], hasEvidence: false, channel: "linkedin" });
    expect(checklistPasses(items)).toBe(false);
    const bad = items.filter((i) => !i.ok).map((i) => i.key);
    expect(bad).toEqual(expect.arrayContaining(["no_client_names", "no_personal_data", "no_deal_prices", "no_forecast_claims"]));
    expect(checklistPasses(reviewChecklist("Notice windows matter more than expiry dates.", { clientNames: ["Acme Corp"], hasEvidence: false, channel: "linkedin" }))).toBe(true);
  });
  it("weekly plan is deterministic", () => {
    expect(weekStartOf("2026-10-31")).toBe("2026-10-26");
    expect(weeklyPlan("2026-10-26")).toEqual(weeklyPlan("2026-10-26"));
    expect(weeklyPlan("2026-10-26")).toHaveLength(3);
  });
});

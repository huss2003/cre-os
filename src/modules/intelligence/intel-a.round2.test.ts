/**
 * Round 2 (intel-A) pure acceptance tests — workflows 05 Prospect Researcher, 06 Network Intelligence, 15 Deal Strategist.
 * Test names follow the acceptance criterion they prove.
 */
import { describe, it, expect } from "vitest";
import { detectSignals, hypothesisSummary } from "./research/signals";
import { evidencePolicy, validateSource, SourceInput, EvidenceSourceError, SourceRuleError, type RegistrySourceLite, type LicensedSourceLite } from "./research/sources";
import { buildDossierSections, claimDateLabel, type DossierInputs } from "./research/dossier";
import { findIntroPaths, type Edge } from "./network/graph";
import { consentIsActive, jobMoveVerified, verifyTaskKey } from "./network/consent";
import { strategize, concessionLadder, evidenceGaps, financeSize, type DealContext } from "./strategy/strategist";

const TODAY = "2026-10-31";

describe("05 signal detection: rule-based hypotheses with evidence links; hiring is not office size", () => {
  it("detects expansion, consolidation, RTO, GCC, hiring surge, leadership change and funding", () => {
    const kinds = (t: string) => detectSignals(t).map((s) => s.kind);
    expect(kinds("Acme opens a new office in Kharadi next year")).toContain("expansion");
    expect(kinds("The firm is consolidating its two Pune sites into one campus")).toContain("consolidation");
    expect(kinds("Employees must return to office four days a week from January")).toContain("rto");
    expect(kinds("Acme to set up a global capability centre in Pune")).toContain("gcc_plan");
    expect(kinds("Acme announced a new GCC")).toContain("gcc_plan");
    expect(kinds("The company appointed Ravi Mehta as Country Head")).toContain("leadership_change");
    expect(kinds("Acme raised $40 million in a Series C funding round")).toContain("funding");
    const hiring = detectSignals("Acme plans to hire 600 engineers in Pune; hiring spree continues");
    expect(hiring.find((s) => s.kind === "hiring")?.surge).toBe(true);
  });
  it("skips negated statements and keeps the hiring caveat in the hypothesis text", () => {
    expect(detectSignals("The company has no plans to expand in Pune").map((s) => s.kind)).not.toContain("expansion");
    const h = detectSignals("Hiring 40 analysts in Pune")[0];
    expect(h.kind).toBe("hiring");
    const txt = hypothesisSummary(h);
    expect(txt).toMatch(/hypothesis/);
    expect(txt).toMatch(/not an office-size commitment/);
    expect(txt).not.toMatch(/\bsf\b|seats? needed/);
  });
});

const reg = (over: Partial<RegistrySourceLite> = {}): RegistrySourceLite => ({ id: "s1", name: "Acme press", kind: "press", base_url: "https://acme.example", acquisition_method: "manual_paste", allowed: true, licensed_source_id: null, ...over });
const lic = (over: Partial<LicensedSourceLite> = {}): LicensedSourceLite => ({ id: "l1", name: "CRE Matrix", expires_on: "2027-12-31", allowed_purposes: ["research"], permits_ai_processing: false, permits_colleague_sharing: false, ...over });

describe("05 licences on pasted evidence: must name an allowed source or be a manual note (lower tier)", () => {
  it("rejects evidence that names no source", () => {
    expect(() => evidencePolicy({ evidenceTier: "credible_reported", manualNote: false }, null, null, TODAY)).toThrow(EvidenceSourceError);
  });
  it("manual notes are allowed but capped at single unverified", () => {
    const p = evidencePolicy({ evidenceTier: "documentary_current", manualNote: true }, null, null, TODAY);
    expect(p.evidence_tier).toBe("single_unverified");
    expect(p.tier_lowered).toBe(true);
    expect(p.source_locator).toMatch(/manual note/);
  });
  it("disabled sources, foreign links, LinkedIn and web-search-only sources are refused", () => {
    expect(() => evidencePolicy({ evidenceTier: "credible_reported", manualNote: false }, reg({ allowed: false }), null, TODAY)).toThrow(/not an allowed source/);
    expect(() => evidencePolicy({ url: "https://other.example/x", evidenceTier: "credible_reported", manualNote: false }, reg(), null, TODAY)).toThrow(/not from the registered source/);
    expect(() => evidencePolicy({ url: "https://www.linkedin.com/posts/x", evidenceTier: "credible_reported", manualNote: true }, null, null, TODAY)).toThrow(/LinkedIn/);
    expect(() => evidencePolicy({ evidenceTier: "credible_reported", manualNote: false }, reg({ acquisition_method: "gateway_web_search" }), null, TODAY)).toThrow(/not for pasted evidence/);
    expect(evidencePolicy({ url: "https://news.acme.example/a", evidenceTier: "credible_reported", manualNote: false }, reg(), null, TODAY).registry_source_id).toBe("s1");
  });
  it("licensed-restricted content respects the licence (expiry, purpose) and keeps its classification and AI permission", () => {
    const s = reg({ licensed_source_id: "l1", acquisition_method: "licensed_export", base_url: null });
    expect(() => evidencePolicy({ evidenceTier: "documentary_current", manualNote: false }, s, lic({ expires_on: "2026-01-01" }), TODAY)).toThrow(/expired/);
    expect(() => evidencePolicy({ evidenceTier: "documentary_current", manualNote: false }, s, lic({ allowed_purposes: ["valuation"] }), TODAY)).toThrow(/purpose/);
    const ok = evidencePolicy({ evidenceTier: "documentary_current", manualNote: false }, s, lic(), TODAY);
    expect(ok.classification).toBe("licensed_restricted");
    expect(ok.permits_ai_processing).toBe(false);
    expect(ok.licensed_source_id).toBe("l1");
  });
});

describe("05 source registry rules", () => {
  const base = { name: "Careers page", kind: "careers", acquisitionMethod: "manual_paste" } as const;
  it("always prohibits scraping/automation/bypass and requires licence links for licensed sources", () => {
    const row = validateSource(SourceInput.parse({ ...base, prohibitedMethods: ["redistribution"] }), null, TODAY);
    expect(row.prohibited_methods).toEqual(expect.arrayContaining(["scraping", "session_automation", "captcha_bypass", "paywall_bypass", "fake_accounts", "redistribution"]));
    expect(() => validateSource(SourceInput.parse({ ...base, kind: "licensed", acquisitionMethod: "licensed_export" }), null, TODAY)).toThrow(SourceRuleError);
    expect(() => validateSource(SourceInput.parse({ ...base, acquisitionMethod: "gateway_web_search" }), null, TODAY)).toThrow(/rate limit/);
    expect(() => validateSource(SourceInput.parse({ ...base, baseUrl: "https://www.linkedin.com/company/x", acquisitionMethod: "rss" }), null, TODAY)).toThrow(/LinkedIn/);
    expect(() => validateSource(SourceInput.parse({ ...base, kind: "licensed", acquisitionMethod: "licensed_export", licensedSourceId: "00000000-0000-4000-8000-0000000000aa", storageRights: "x", reuseRights: "y" }), lic({ expires_on: "2025-01-01" }), TODAY)).toThrow(/expired/);
  });
});

function inputs(over: Partial<DossierInputs> = {}): DossierInputs {
  return {
    org: { id: "org-1", display_name: "Acme", legal_name: "Acme Pvt Ltd", cin: null, gstin: null, domain: null, sector: null, hq_country: null, headcount_min: null, headcount_max: null, is_gcc: null, updated_at: "2026-09-15T00:00:00Z", row_version: 1 },
    relations: [], claims: [], employments: [], leases: [], transactions: [], interactions: [], stakeholders: [], introPaths: [], ...over,
  };
}

describe("05 claim dating: internal records labelled distinctly; undated claims stay date-unknown (never today)", () => {
  it("labels internal records with their last update and never stamps today on undated stakeholder/intro claims", () => {
    const b = buildDossierSections(inputs({
      stakeholders: [{ id: "sh1", person_name: "Priya", role: "finance", requirement_title: "Pune HQ", row_version: 1 }],
      introPaths: [{ target_person_id: "p2", target_name: "Arun", hops: ["You", "Arun"], warmth: "warm", needs_permission: false, last_contact: null }],
      claims: [{ id: "c1", claim_type: "funding", predicate: "raised money", value_json: {}, status: "reported", evidence_tier: "single_unverified", evidence_excerpt: "x", source_url: null, source_locator: null, published_on: null, observed_on: null, effective_on: null, expires_on: null, created_at: "2026-10-01T00:00:00Z", row_version: 1 }],
    }), TODAY);
    const all = b.sections.flatMap((s) => s.claims);
    const sh = all.find((c) => c.source.kind === "stakeholder")!;
    expect(sh.observed_on).toBeNull();
    expect(sh.date_basis).toBe("internal_record");
    expect(claimDateLabel(sh)).toBe("internal record (date unknown)");
    const intro = all.find((c) => c.source.kind === "relationship_edge")!;
    expect(intro.observed_on).toBeNull();
    expect(intro.observed_on).not.toBe(TODAY);
    const ident = all.find((c) => c.source.kind === "organisation")!;
    expect(ident.observed_on).toBeNull();
    expect(claimDateLabel(ident)).toBe("internal record (last updated 2026-09-15)");
    const sig = all.find((c) => c.source.kind === "signal_claim")!;
    expect(sig.observed_on).toBeNull();               // not the created_at date
    expect(sig.date_basis).toBe("unknown");
    expect(claimDateLabel(sig)).toMatch(/date unknown \(recorded 2026-10-01\)/);
    // every material claim has a source and either a date or an explicit "unknown" basis
    for (const c of all) { expect(c.source.kind).toBeTruthy(); expect(c.date_basis).toBeTruthy(); }
  });
  it("dated external evidence keeps its observation/publication dates", () => {
    const b = buildDossierSections(inputs({ claims: [{ id: "c2", claim_type: "expansion", predicate: "new site", value_json: {}, status: "reported", evidence_tier: "credible_reported", evidence_excerpt: "x", source_url: "https://acme.example/n", source_locator: null, published_on: "2026-10-02", observed_on: "2026-10-03", effective_on: null, expires_on: null, created_at: "2026-10-05T00:00:00Z", row_version: 1 }] }), TODAY);
    const c = b.sections.flatMap((s) => s.claims).find((x) => x.source.id === "c2")!;
    expect(c.date_basis).toBe("source");
    expect(claimDateLabel(c)).toBe("observed 2026-10-03 · published 2026-10-02");
  });
});

const edge = (id: string, o: Partial<Edge>): Edge => ({ id, from_user_id: null, from_person_id: null, to_person_id: "t", edge_type: "worked_with", warmth: "warm", intro_permission: false, last_meaningful_contact: null, valid_to: null, ...o });

describe("06 intro paths use only permitted relationship context and confirmed consent", () => {
  const edges = [edge("e1", { from_user_id: "me", to_person_id: "p1" }), edge("e2", { from_person_id: "p1", to_person_id: "t", intro_permission: true })];
  it("a bare intro_permission flag is not enough when consent records are checked", () => {
    const [p] = findIntroPaths(edges, "me", ["t"], TODAY, { consentedEdgeIds: new Set() });
    expect(p.needs_permission).toBe(true);
    expect(p.consent_edge_id).toBe("e2");
    const [ok] = findIntroPaths(edges, "me", ["t"], TODAY, { consentedEdgeIds: new Set(["e2"]) });
    expect(ok.needs_permission).toBe(false);
  });
  it("suppressed people never appear in suggested paths", () => {
    expect(findIntroPaths(edges, "me", ["t"], TODAY, { blockedPersonIds: new Set(["p1"]) })).toHaveLength(0);
  });
  it("consent is active only when given, unrevoked and unexpired", () => {
    expect(consentIsActive({ given_on: "2026-10-01", expires_on: null, revoked_at: null }, TODAY)).toBe(true);
    expect(consentIsActive({ given_on: "2026-11-01", expires_on: null, revoked_at: null }, TODAY)).toBe(false);
    expect(consentIsActive({ given_on: "2026-10-01", expires_on: "2026-10-30", revoked_at: null }, TODAY)).toBe(false);
    expect(consentIsActive({ given_on: "2026-10-01", expires_on: null, revoked_at: "2026-10-15T00:00:00Z" }, TODAY)).toBe(false);
  });
  it("unverified moves stay labelled until confirmed; verification task key is deterministic", () => {
    expect(jobMoveVerified("reported", [])).toBe(false);
    expect(jobMoveVerified("reported", ["proposed"])).toBe(false);
    expect(jobMoveVerified("reported", ["applied"])).toBe(true);
    expect(jobMoveVerified("currently_confirmed", [])).toBe(true);
    expect(verifyTaskKey("p", "o")).toBe(verifyTaskKey("p", "o"));
  });
});

function deal(over: Partial<DealContext> = {}): DealContext {
  return {
    opportunity: { id: "opp", name: "Acme Pune", stage: "proposal_negotiation", outcome: "open", stage_entered_at: "2026-10-10T00:00:00Z", temperature: "warm", mandate_status: "exclusive", expected_close: null, next_action: "Send comparison", next_action_due: "2026-11-05", risks: null },
    requirement: { id: "req", decision_date: "2026-12-15", occupation_date: "2027-04-01", area_target_sf: 20000, area_min_sf: null, area_max_sf: 25000, budget_min: null, budget_max: null, constraints: null, status: "client_confirmed", confirmed_at: "2026-09-01T00:00:00Z" },
    stakeholders: [{ id: "sh1", person_id: "p1", name: "Priya", role: "sponsor", employment_current: true, employment_status: "currently_confirmed" }],
    quotes: [{ id: "q2", version: 2, valid_until: "2026-11-30", superseded: false, created_at: "2026-10-20T00:00:00Z", terms: { rent: 95, escalation: 5, deposit: 10, lockin: 36, rent_free: 1 }, evidence: "landlord email 20 Oct", approved: false, label: "Tower A" }],
    lastInteractionAt: "2026-10-28T00:00:00Z",
    objections: [{ id: "obj-1", source: "objection_log", text: "Rent is above budget", category: "price", raised_on: "2026-10-25", outcome: "open" }],
    currentLeaseExpiry: "2027-03-31", currentLeaseId: "lease-1", financeScenarioCount: 1,
    latestStageChange: { id: "hist-1", to_stage: "proposal_negotiation", changed_at: "2026-10-10T00:00:00Z" },
    ...over,
  };
}

describe("15 recommendations cite recorded facts and separate assumptions", () => {
  it("BATNA questions are tailored from deal facts and cite the objection id, quote version and stage", () => {
    const s = strategize(deal(), TODAY);
    const price = s.batna_questions.find((q) => q.basis.some((b) => b.kind === "objection" && b.id === "obj-1"))!;
    expect(price.text).toMatch(/Price objection/);
    expect(price.basis.some((b) => b.kind === "quote" && b.id === "q2" && /v2/.test(b.label))).toBe(true);
    expect(s.batna_questions.some((q) => q.basis.some((b) => b.kind === "lease"))).toBe(true);
    expect(s.risks.every((r) => Array.isArray(r.basis) && Array.isArray(r.assumptions))).toBe(true);
    expect(s.facts.some((f) => f.kind === "stage" && f.id === "hist-1")).toBe(true);
    expect(s.disclaimer).toMatch(/Suggestions only/);
  });
  it("missing facts become explicit assumptions, not invented values", () => {
    const s = strategize(deal({ currentLeaseExpiry: null, quotes: [], objections: [] }), TODAY);
    expect(s.assumptions.join(" ")).toMatch(/lease expiry not recorded/i);
    expect(s.assumptions.join(" ")).toMatch(/No quote recorded/);
    expect(s.concession_ladder.every((c) => c.basis.every((b) => b.kind !== "quote"))).toBe(true);
  });
  it("concession ladder order follows the quote terms and objections (not a fixed template)", () => {
    const price = concessionLadder(deal());
    const spec = concessionLadder(deal({ objections: [{ id: "o2", source: "objection_log", text: "Floor plate needs work", category: "specification", raised_on: "2026-10-25", outcome: "open" }], quotes: [{ id: "q3", version: 1, valid_until: null, superseded: false, terms: { rent_free: 6, escalation: 0, deposit: 3, lockin: 12 } }] }));
    expect(price[0].item).toBe("rent_free");
    expect(spec[0].item).toBe("capex");
    expect(spec.some((c) => c.item === "escalation")).toBe(false);   // quote already has 0% escalation
    expect(spec.some((c) => c.item === "deposit")).toBe(false);      // 3 months is not worth asking
    const rf = price.find((c) => c.item === "rent_free")!;
    expect(rf.concession_type).toBe("rent_free");
    expect(rf.basis.map((b) => b.id)).toEqual(expect.arrayContaining(["q2", "obj-1"]));
    expect(rf.value_basis).toMatch(/finance scenario/i);
  });
  it("evidence-gap check flags stale quotes, unverified availability and claims without evidence", () => {
    const g = evidenceGaps(deal({
      quotes: [{ id: "qx", version: 1, valid_until: "2026-09-30", superseded: false, evidence: null, approved: false }],
      availability: [{ id: "av1", label: "Option Tower B", as_of: "2026-08-01", valid_until: null, status: "available", fact_status: "reported" }],
      unsourcedClaims: [{ id: "sc1", claim_type: "expansion", text: "heard they want more space" }],
      stakeholders: [{ id: "sh2", person_id: "p2", name: "Arun", role: "finance", employment_current: null, employment_status: null }],
    }), TODAY);
    const keys = g.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["stale_quote:qx", "quote_no_evidence:qx", "availability:av1", "claim:sc1", "stakeholder:sh2"]));
  });
});

describe("15 ladder steps carry a finance_value only where deal facts give a number (never 0)", () => {
  it("sizes from the quote terms or a recorded requirement target; unknown stays absent", () => {
    const l = concessionLadder(deal());   // quote q2: rent_free 1, escalation 5, deposit 10, no capex
    const by = (k: string) => l.find((c) => c.item === k)!;
    expect(by("rent_free")).toMatchObject({ finance_type: "rent_free", finance_value: 1 });
    expect(by("escalation")).toMatchObject({ finance_type: "escalation_pct", finance_value: -1 });
    expect(by("deposit")).toMatchObject({ finance_type: "deposit_months", finance_value: -1 });
    expect(by("capex").finance_value).toBeNull();        // no ₹ figure on record
    expect(by("fitout_period").finance_value).toBeNull(); // fit-out term not quoted
    expect(by("rent_free").finance_value_basis).toMatch(/v2/);
    const t = concessionLadder(deal({ requirement: { ...deal().requirement!, constraints: { target_rent_free_months: 4, max_escalation_pct: 4.5, target_capex_support: 500000 } }, quotes: [{ ...deal().quotes[0], terms: { rent_free: 1, escalation: 5, capex: 200000, deposit: 10 } }] }));
    expect(t.find((c) => c.item === "rent_free")!.finance_value).toBe(3);
    expect(t.find((c) => c.item === "escalation")!.finance_value).toBe(-0.5);
    expect(t.find((c) => c.item === "capex")!.finance_value).toBe(300000);
    expect(concessionLadder(deal({ quotes: [] })).every((c) => c.finance_value === null)).toBe(true);
    expect(financeSize("escalation", { escalation: 0 }, null, null).value).toBeNull();
    for (const c of [...l, ...t]) expect(c.finance_value).not.toBe(0);
  });
});

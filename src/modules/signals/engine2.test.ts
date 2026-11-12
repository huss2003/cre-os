// Signal Engine v2 — pure rules (spec §3, §7, §8, §11, §13, §14, §15, §16). No DB.
import { describe, it, expect } from "vitest";
import { detectAll, leadershipSubType, plausibleCreLink } from "./taxonomy";
import { independentGroups, derive, contextSummary, hiringCheck, buildLabels, evidenceLabel, DEFAULT_RULES } from "./rules";
import { leaseSignal, counterEvidence, priorityOf } from "./engine";
import { compareRents, type LeaseRent, type Offer } from "./commercial";
import { selectDue } from "./refresh";
import { entitlementProblem } from "./sources";

const T = "2026-11-12";
const subs = (t: string) => detectAll(t).map((d) => d.subType);

describe("categories A–G with sub-types", () => {
  it("A expansion: GCC, hiring campaign, new office, funding", () => {
    expect(subs("Acme will set up a global capability centre in Pune.")).toContain("gcc");
    expect(subs("Acme is on a hiring spree and plans to hire 500 engineers.")).toContain("hiring_campaign");
    expect(subs("Acme opens a new office in Pune.")).toContain("new_office");
    expect(subs("Acme raised $40 million in a Series C funding round.")).toContain("funding");
  });
  it("B restructuring: closure, M&A, layoffs ≠ space reduction", () => {
    expect(subs("Acme is closing its Mumbai office next quarter.")).toContain("closure");
    expect(subs("Acme has agreed to acquire Beta Systems.")).toContain("merger_acquisition");
    const lay = subs("Acme announced layoffs affecting 300 staff.");
    expect(lay).toContain("workforce_reduction");
    expect(lay).not.toContain("footprint_reduction");
    expect(counterEvidence({ category: "restructuring", kind: "layoff", texts: ["layoffs"], focusCities: ["Pune"], sourceCount: 1, latestEvidenceOn: T, today: T, hasOccupancyInFocus: false }).join(" ")).toMatch(/do not automatically mean office-space reduction/);
  });
  it("E leadership role → sub-type; non-CRE role flagged", () => {
    expect(leadershipSubType("Head of Facilities")).toBe("facilities_leader");
    expect(leadershipSubType("Chief Financial Officer (CFO)")).toBe("finance_leader");
    expect(leadershipSubType("Brand Marketing Manager")).toBe("other_role");
    expect(counterEvidence({ category: "leadership", kind: "job_move", texts: [], focusCities: ["Pune"], sourceCount: 1, latestEvidenceOn: T, today: T, hasOccupancyInFocus: false, personFunction: "Brand Marketing Manager" }).join(" ")).toMatch(/may not influence real-estate/);
  });
  it("F infrastructure: forecast separated from fact", () => {
    const d = detectAll("The new metro line to Hinjewadi is expected to open by 2027.").find((x) => x.subType === "metro")!;
    expect(d.category).toBe("infrastructure");
    expect(d.forecast).toBe(true);
    expect(detectAll("The Hinjewadi metro line opened to the public today.").find((x) => x.subType === "metro")!.forecast).toBe(false);
  });
  it("G macro only with a plausible CRE link", () => {
    expect(subs("RBI cut the repo rate, lowering interest rates for office developers.")).toContain("interest_rate");
    expect(plausibleCreLink("Cricket scores were high this weekend.")).toBe(false);
    expect(detectAll("New regulation on cricket broadcasting announced.").filter((d) => d.category === "macro")).toHaveLength(0);
  });
});

describe("C lease events are never interchangeable", () => {
  const ev = (event_type: any, days: number) => ({ id: "e", event_type, event_date: new Date(Date.parse(T) + days * 86_400_000).toISOString().slice(0, 10), date_basis: "contractual", confirmed: true, notice_days: null });
  it("each type keeps its own kind; past expiry → verification, not a claim", () => {
    const kinds = (["expiry", "lockin_end", "notice_deadline", "break", "option"] as const).map((t) => leaseSignal(ev(t, 60), T)!.kind);
    expect(new Set(kinds).size).toBe(5);
    const past = leaseSignal(ev("expiry", -30), T)!;
    expect(past.verification).toBe("unknown");
    expect(past.recommended).toMatch(/Do not assume a space need/);
    expect(leaseSignal(ev("notice_deadline", -30), T)).toBeNull();
  });
});

describe("grouping, labels, derived fields", () => {
  const pr = "Acme announces a new 2,000-seat Pune GCC in Kharadi, the company said in a statement on Monday.";
  it("repeated articles are not independent confirmations", () => {
    const g = independentGroups([
      { role: "support", source_url: "https://acme.com/pr", excerpt: pr },
      { role: "support", source_url: "https://news-a.test/x", excerpt: `Reported: ${pr}` },
      { role: "support", source_url: "https://news-b.test/y", excerpt: pr },
      { role: "support", source_url: "https://jobs.test/z", excerpt: "Acme is hiring 300 software engineers in Pune for its new centre." },
    ]);
    expect(g.count).toBe(2);
  });
  it("funding alone does not create a requirement; hiring checks location/remote/role", () => {
    const base = { category: "expansion" as const, subType: "funding", kinds: ["funding"], orgResolved: true, isWatched: false, texts: ["raised $40m"], location: null, contextLocations: [], focusCities: ["Pune"], daysAway: null, confidence: "low", tiers: [], adapters: [], latestEvidenceOn: T, today: T, hasLease: false, hasRequirement: false, hasOpenOpportunity: false, hasContact: false, leaseWithin18m: false, missingInfo: [], nextAction: { text: "x", actionKind: "research" } };
    const d = derive(base);
    expect(d.fundingOnly).toBe(true);
    expect(d.creRelevance.level).toBe("low");
    expect(d.missingInfo.join(" ")).toMatch(/Funding alone/);
    expect(d.commercialImpact.level).toBe("unknown");
    const h = hiringCheck(["Hiring 200 engineers who will work remotely"], ["Pune"], []);
    expect(h.remote).toBe("yes"); expect(h.roleType).toBe("technology"); expect(h.location).toMatch(/unknown/);
    expect(hiringCheck(["Hiring 200 engineers in Bengaluru, on-site"], ["Pune"], []).occupancyImplication).toMatch(/outside Pune/);
  });
  it("fact / inference / hypothesis / unknown labels", () => {
    expect(evidenceLabel({ fact_status: "currently_confirmed" })).toBe("fact");
    expect(evidenceLabel({ fact_status: "reported" })).toBe("inference");
    expect(evidenceLabel({ fact_status: "ai_inference" })).toBe("hypothesis");
    expect(evidenceLabel({ fact_status: "reported" }, true)).toBe("hypothesis");
    const l = buildLabels({ evidence: [{ role: "support", fact_status: "reported", source_name: "PR", excerpt: "Expanding" }], creRelevance: "may matter", title: "Acme", missingInfo: ["Area unknown"], contextFacts: ["Recorded occupancy: Kharadi."], forecast: false });
    expect(l.facts).toContain("Recorded occupancy: Kharadi.");
    expect(l.inferences.join(" ")).toMatch(/unconfirmed/);
    expect(l.hypotheses.join(" ")).toMatch(/requires validation/);
    expect(l.unknowns).toEqual(["Area unknown"]);
  });
  it("contextual summary follows the Kharadi example and invents nothing", () => {
    const in14m = new Date(Date.parse(T) + 426 * 86_400_000).toISOString().slice(0, 10);
    const s = contextSummary("Potential Pune expansion", { locations: ["Kharadi"], leaseEvents: [{ event_type: "expiry", event_date: in14m }], contacts: [{ name: "Asha", title: "Facilities Manager" }], lastInteractionOn: "2026-08-12", requirements: [] },
      "Reconnect with the facilities contact and confirm whether the expansion can be accommodated in the existing premises.", T);
    expect(s).toMatch(/^Potential Pune expansion\. Existing Kharadi occupancy, a known lease expiry in 14 months and a known facilities contact \(Asha\) are recorded\./);
    expect(s).toMatch(/Current spare capacity is unverified/);
    expect(s).toMatch(/3 months ago/);
    expect(s).toMatch(/No requirement, budget, area or move-in date is recorded/);
    expect(s).not.toMatch(/sq|seats|₹|\$/);
  });
});

describe("counter-evidence (§14) and priority (§13)", () => {
  it("covers outdated lease, unavailable property, infra with no target, repeats", () => {
    const c = counterEvidence({ category: "infrastructure", kind: "metro", texts: [], focusCities: ["Pune"], sourceCount: 3, independentCount: 1, latestEvidenceOn: T, today: T, hasOccupancyInFocus: false, leaseOutdated: true, propertyUnavailable: true, infraNoTarget: true }).join(" ");
    expect(c).toMatch(/3 sources refer to 1 underlying announcement/);
    expect(c).toMatch(/lease event is outdated/);
    expect(c).toMatch(/no longer listed as available/);
    expect(c).toMatch(/no material effect/);
  });
  it("high model/evidence confidence alone never makes high priority", () => {
    const p = priorityOf({ category: "macro", daysAway: null, confidence: "high", inFocusGeo: true, hasContact: false, hasOpenOpportunity: false, hasRequirement: false, leaseWithin18m: false, freshnessDays: 1, needsVerification: false });
    expect(p.band).not.toBe("high");
    expect(p.reasons.length).toBeGreaterThan(0);
  });
});

describe("D commercial value compares like-for-like only", () => {
  const lease: LeaseRent = { id: "l1", tenant_org_id: "o", tenant_name_raw: null, rent_per_sf: 120, rent_basis: "chargeable", area_sf: 10000, asset_id: "a1", asset_name: "Tower A", micro_market_id: "mm", micro_market: "Kharadi" };
  const offer = (o: Partial<Offer>): Offer => ({ id: "x", asset_id: "a2", asset_name: "Tower B", micro_market_id: "mm", asking_rent_min: 90, asking_rent_max: 100, rent_basis: "chargeable", fitout_basis: "warm_shell", status: "available", valid_until: null, ...o });
  it("same basis + same micro-market + available only", () => {
    expect(compareRents([lease], [offer({})], T)).toHaveLength(1);
    expect(compareRents([lease], [offer({ rent_basis: "carpet", asking_rent_max: 60 })], T)).toHaveLength(0);
    expect(compareRents([lease], [offer({ micro_market_id: "other" })], T)).toHaveLength(0);
    expect(compareRents([lease], [offer({ status: "leased" })], T)).toHaveLength(0);
    expect(compareRents([{ ...lease, rent_per_sf: null }], [offer({})], T)).toHaveLength(0);
    expect(compareRents([lease], [offer({})], T)[0].savingPct).toBe("16.7");
  });
});

describe("refresh universe (§15) and source entitlements (§16)", () => {
  it("bounded universe, tier order, due only", () => {
    const now = new Date(`${T}T12:00:00Z`);
    const rows = Array.from({ length: 50 }, (_, i) => ({ org_id: `o${i}`, tier: i < 5 ? "critical" : i < 20 ? "active" : "universe", next_due_at: i % 2 ? "2026-01-01T00:00:00Z" : "2027-01-01T00:00:00Z", last_researched_at: null, active: true }));
    const r = selectDue(rows, 10, now);
    expect(r.universe).toHaveLength(10);
    expect(r.universe.slice(0, 5).every((x) => x.tier === "critical")).toBe(true);
    expect(r.due.every((x) => x.next_due_at < now.toISOString())).toBe(true);
    expect(DEFAULT_RULES.version).toBe("signals-2");
  });
  it("blocks unavailable, paused, wrong-purpose and rate-limited sources", () => {
    const ok = { name: "Paste", adapter: "manual_paste", allowed: true, paused: false, permission_status: "permitted", connection_status: "connected", permitted_purposes: ["signal_detection"], rate_limit_per_day: 2, calls_day: T, calls_today: 0 };
    expect(entitlementProblem(ok, T, null)).toBeNull();
    expect(entitlementProblem({ ...ok, adapter: "rss" }, T, null)).toMatch(/needs access/);
    expect(entitlementProblem({ ...ok, paused: true }, T, null)).toMatch(/paused/);
    expect(entitlementProblem({ ...ok, permitted_purposes: ["research"] }, T, null)).toMatch(/not permitted/);
    expect(entitlementProblem({ ...ok, calls_today: 2 }, T, null)).toMatch(/daily limit/);
    expect(entitlementProblem({ ...ok, permission_status: "denied" }, T, null)).toMatch(/denied/);
  });
});

/**
 * Module 13 — pure tests for change detection, consolidation, recommendations, lifecycle and integration hooks
 * (spec §17 scenarios 9, 10, 11, 12, 13, 16, 18, 23 at the rule level; DB-backed versions in memory-changes.db.test.ts).
 */
import { describe, it, expect } from "vitest";
import { detectRequirementChanges, detectEmploymentChanges, detectAvailabilityChanges, detectLeaseChanges, detectDecisionMakerChange, detectOpportunityInactive, detectRejectedRelevant, decisionMakerImpact, numericDiff } from "./changes/detect";
import { consolidate, consolidateMeetingNotes, type Obs } from "./consolidate/consolidate";
import { liveRecommendations, recommendationForChange, rankRecommendations, toPlannerRec } from "./recommend/rules";
import { lifecycleStatus, applyCorrections } from "./quality/lifecycle";
import { similarity } from "./integrate/similar";
import { reasonTheme } from "./integrate/rejections";
import { buildPlannerView } from "@/modules/orchestrator/ui/planner";
import { classifyIntent } from "@/modules/assistant/engine/router";

const src = (id: string) => ({ type: "capture", id, label: `capture ${id}`, href: `/capture/${id}` });
const obs = (p: Partial<Obs> & { id: string; text: string }): Obs => ({ kind: "preference", field: "preference", value: null, at: "2026-10-01", sourceKey: p.id, independent: true, repeatOf: null, factClass: "preference", verification: "user_stated", source: src(p.id), ...p });

describe("§5.2 requirement evolution / §17.7–9", () => {
  const v1 = { version: 1, created_at: "2026-08-01T00:00:00Z", change_reason: null, change_proposal_id: null, field_status: { area: "client_confirmed" },
    snapshot: { area_target_sf: 10000, area_min_sf: null, area_max_sf: null, area_basis: "chargeable", budget_max: 90, budget_basis: "per_sf_month", preferred_geography_ids: ["hinj"], excluded_geography_ids: [], occupation_date: "2026-12-01", decision_date: null } };
  const v2 = { version: 2, created_at: "2026-10-01T00:00:00Z", change_reason: "Client call", change_proposal_id: "cp1", field_status: { area: "client_confirmed", budget: "estimated" },
    snapshot: { ...v1.snapshot, area_target_sf: 15000, budget_max: 110, preferred_geography_ids: ["khar"], occupation_date: "2027-03-01" } };
  const ch = detectRequirementChanges("r1", [v2, v1], (id) => ({ hinj: "Hinjawadi", khar: "Kharadi" } as Record<string, string>)[id]);
  it("detects area, budget, location and timeline changes with both values kept", () => {
    expect(ch.map((c) => c.kind).sort()).toEqual(["requirement_area_change", "requirement_budget_change", "requirement_location_change", "requirement_timeline_change"]);
    const area = ch.find((c) => c.kind === "requirement_area_change")!;
    expect((area.previous as any).area_target_sf).toBe(10000);
    expect((area.latest as any).area_target_sf).toBe(15000);
    expect(area.difference.delta).toBe(5000);
    expect(area.difference.pct).toBe(50);
    expect(area.material).toBe(true);
    expect(area.verification).toBe("verified");
    expect(area.source?.type).toBe("change_proposal");
    expect(area.changedAt).toBe("2026-10-01T00:00:00Z");
    expect(ch.find((c) => c.kind === "requirement_location_change")!.difference.text).toContain("added Kharadi");
    expect(ch.find((c) => c.kind === "requirement_budget_change")!.verification).toBe("estimated");
  });
  it("a small area change (<10%) is not material; unknown previous value stays unknown", () => {
    const small = detectRequirementChanges("r", [v1, { ...v2, snapshot: { ...v1.snapshot, area_target_sf: 10500 } }]);
    expect(small[0].material).toBe(false);
    expect(numericDiff(null, 5).delta).toBeNull();
  });
});

describe("§6.1 change detection", () => {
  it("employer change keeps both employers; promotion vs designation change", () => {
    const e = detectEmploymentChanges("p1", "Asha", [
      { id: "e1", org_id: "A", org_name: "Alpha", title: "Facilities Manager", seniority: "manager", start_date: "2020-01-01", fact_status: "currently_confirmed" },
      { id: "e2", org_id: "B", org_name: "Beta", title: "CRE Director", seniority: "director", start_date: "2025-01-01", fact_status: "reported" },
      { id: "e3", org_id: "B", org_name: "Beta", title: "VP Real Estate", seniority: "vp", start_date: "2026-06-01", fact_status: "reported" },
    ]);
    expect(e.map((x) => x.kind)).toEqual(["employer_change", "promotion"]);
    expect((e[0].previous as any).org).toBe("Alpha");
    expect(e[0].difference.text).toContain("opportunities stay with that company");
    expect(e[0].verification).toBe("reported");
  });
  it("rent, CAM and inventory changes from availability snapshots", () => {
    const c = detectAvailabilityChanges({ id: "s1", assetId: "a1", label: "Tower A" }, [
      { id: "v1", as_of: "2026-01-01", status: "available", asking_rent_min: 80, cam_psf_month: 12, rent_basis: "chargeable", fact_status: "reported" },
      { id: "v2", as_of: "2026-06-01", status: "under_offer", asking_rent_min: 85, cam_psf_month: 14, rent_basis: "chargeable", fact_status: "reported" },
    ]);
    expect(c.map((x) => x.kind)).toEqual(["rent_change", "cam_change", "inventory_change"]);
    expect(c[0].difference.delta).toBe(5);
  });
  it("office move, expansion and lease expiry approaching", () => {
    const c = detectLeaseChanges({ id: "o1", name: "Acme" }, [
      { id: "l1", asset_id: "a1", asset_name: "Old Park", area_sf: 10000, area_basis: "chargeable", start_date: "2020-01-01" },
      { id: "l2", asset_id: "a2", asset_name: "New Tower", area_sf: 20000, area_basis: "chargeable", start_date: "2025-01-01", contractual_expiry: "2026-12-31", fact_status: "currently_confirmed", lease_event: [] },
    ], "2026-11-11");
    expect(c.map((x) => x.kind).sort()).toEqual(["expansion", "lease_expiry_approaching", "office_location_change"]);
    expect(c.find((x) => x.kind === "lease_expiry_approaching")!.verification).toBe("verified");
  });
  it("§17.16 decision-maker change + §6.3 impact never assumes the new person's preferences/authority", () => {
    const c = detectDecisionMakerChange("r1", [
      { id: "s1", person_id: "p1", person_name: "Old DM", role: "approver", created_at: "2026-01-01", archived_at: "2026-09-01" },
      { id: "s2", person_id: "p2", person_name: "New DM", role: "approver", created_at: "2026-09-02", archived_at: null },
    ]);
    expect(c).toHaveLength(1);
    expect((c[0].previous as any).name).toBe("Old DM");
    expect((c[0].latest as any).name).toBe("New DM");
    const imp = decisionMakerImpact({ previous: c[0].previous as any, next: c[0].latest as any, historyWithPrevious: { interactions: 4, lastAt: "2026-08-01", sources: [] }, historyWithNext: { interactions: 0, lastAt: null },
      contacts: [], activeOpportunities: [{ id: "o1", name: "Deal", stage: "loi" }] });
    expect(imp.opportunitiesNeedingReassessment).toHaveLength(1);
    expect(imp.caveats.join(" ")).toMatch(/not copied/);
    expect(imp.recommendations[0]).toMatch(/buying group/);
    // leaving the company (employment no longer current) also counts
    expect(detectDecisionMakerChange("r1", [{ id: "s1", person_id: "p1", role: "sponsor", created_at: "2026-01-01", archived_at: null, current_employment: false }, { id: "s2", person_id: "p2", role: "sponsor", created_at: "2026-02-01", archived_at: null }])).toHaveLength(1);
  });
  it("opportunity inactive and rejected property relevant again", () => {
    expect(detectOpportunityInactive({ id: "o", name: "D", stage: "engaged", updated_at: "2026-01-01" }, "2026-08-01T00:00:00Z", "2026-11-11")).toHaveLength(1);
    expect(detectOpportunityInactive({ id: "o", name: "D", stage: "signed", updated_at: "2026-01-01" }, null, "2026-11-11")).toHaveLength(0);
    const r = detectRejectedRelevant([{ assetId: "a", assetName: "Tower", requirementId: "r", at: "2026-05-01", reasons: ["Parking: too few"], explicit: true, source: src("f") }],
      [{ assetId: "a", at: "2026-04-01", id: "q0", kind: "quote", text: "old" }, { assetId: "a", at: "2026-09-01", id: "q1", kind: "quote", text: "new" }]);
    expect(r).toHaveLength(1);
    expect(r[0].source?.id).toBe("q1");
  });
});

describe("§8 consolidation (§17.10–12, 18)", () => {
  it("recurring preference from 3 separate meetings — retained originals, never a confirmed requirement", () => {
    const r = consolidate([
      obs({ id: "m1", text: "They prefer Grade A buildings with immediate occupancy", at: "2026-07-01" }),
      obs({ id: "m2", text: "prefer grade A buildings with immediate occupancy", at: "2026-08-01" }),
      obs({ id: "m3", text: "Grade A buildings with immediate occupancy preferred", at: "2026-09-01" }),
    ]);
    expect(r.recurring).toHaveLength(1);
    const p = r.recurring[0];
    expect(p.independentSources).toBe(3);
    expect(p.originals.map((o) => o.source.id)).toEqual(["m1", "m2", "m3"]);
    expect(p.isConfirmedRequirement).toBe(false);
    expect(p.status).toMatch(/not a confirmed requirement/);
  });
  it("repeat of the same source is not independent confirmation", () => {
    const r = consolidate([
      obs({ id: "a", text: "prefer Baner", sourceKey: "doc1" }),
      obs({ id: "b", text: "prefer Baner", sourceKey: "doc1", independent: false, repeatOf: "a" }),
      obs({ id: "c", text: "prefer Baner", sourceKey: "doc1" }),
    ]);
    expect(r.items[0].occurrences).toBe(3);
    expect(r.items[0].independentSources).toBe(1);
    expect(r.items[0].recurring).toBe(false);
    expect(r.items[0].corroboration).toBe("repeated_same_source");
  });
  it("conflicting commercial values are flagged, both kept", () => {
    const r = consolidate([
      obs({ id: "q1", kind: "commercial", field: "rent_psf", text: "rent 85", value: 85, factClass: "confirmed" }),
      obs({ id: "q2", kind: "commercial", field: "rent_psf", text: "rent 92", value: 92, factClass: "confirmed", at: "2026-10-05" }),
    ]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].values.map((v) => v.value)).toEqual(["rent 92", "rent 85"]);
  });
  it("meeting notes are combined with commitments pooled and originals kept", () => {
    const c = consolidateMeetingNotes([
      { id: "n2", at: "2026-09-01", title: "Visit", text: "Saw two towers", commitments: ["Send comps"], objections: ["Parking is tight"], source: src("n2") },
      { id: "n1", at: "2026-08-01", title: "Intro", text: "Discussed needs", commitments: ["send comps"], objections: [], source: src("n1") },
    ]);
    expect(c.meetings).toBe(2);
    expect(c.timeline[0].title).toBe("Intro");
    expect(c.commitments).toHaveLength(1);
    expect(c.commitments[0].mentions).toBe(2);
    expect(c.originals).toHaveLength(2);
  });
});

describe("§9 recommendations / §13 lifecycle / hooks", () => {
  it("every recommendation has what/why/supporting/sources/confidence/next action", () => {
    const r = liveRecommendations({ today: "2026-11-11", staleRequirements: [{ id: "r", title: "Req", orgName: "Acme", lastReviewed: "2026-07-01", days: 133 }], meetingsWithoutFollowup: [],
      repeatedRejections: [{ requirementId: "r", title: "Req", theme: "parking", count: 2, sources: [src("f1"), src("f2")] }],
      outdatedQuotes: [{ id: "q", requirementId: "r", label: "Tower quote", createdAt: "2026-01-01", validUntil: "2026-03-01", days: 314 }], relationshipBeforeTransaction: [{ opportunityId: "o", name: "Deal", stage: "loi", lastContact: null, days: null }], inactiveWithSignal: [] });
    expect(r).toHaveLength(4);
    for (const x of r) { expect(x.title && x.why && x.nextAction && x.confidence).toBeTruthy(); expect(x.sourceRefs.length).toBeGreaterThan(0); expect(x.supporting.length).toBeGreaterThan(0); }
    expect(rankRecommendations([...r, r[0]])).toHaveLength(4);
    expect(toPlannerRec(r[0]).ref).toMatch(/^intel:/);
  });
  it("decision-maker change → buying-group recommendation (suggestion only)", () => {
    const [c] = detectDecisionMakerChange("r1", [{ id: "s1", person_id: "p1", role: "approver", created_at: "2026-01-01", archived_at: "2026-02-01" }, { id: "s2", person_id: "p2", role: "approver", created_at: "2026-02-02", archived_at: null }]);
    expect(recommendationForChange(c, "x")!.nextAction).toMatch(/buying group/);
  });
  it("lifecycle statuses and manual corrections", () => {
    expect(lifecycleStatus({ conflicting: true, verification: "verified" })).toBe("conflicting");
    expect(lifecycleStatus({ superseded: true })).toBe("superseded");
    expect(lifecycleStatus({ ended: true, verification: "verified" })).toBe("historical");
    expect(lifecycleStatus({ verification: "inferred" })).toBe("unverified");
    expect(lifecycleStatus({ verification: "verified", isLatest: true })).toBe("current");
    const out = applyCorrections([{ key: "k", status: "current" as const }], [{ item_key: "k", status: "historical", note: "left", created_at: "2026-01-02" }, { item_key: "k", status: "conflicting", note: "old", created_at: "2026-01-01" }]);
    expect(out[0].status).toBe("historical");
    expect(out[0].corrected?.from).toBe("current");
  });
  it("similar requirements and rejection themes are deterministic; unknown is not a match", () => {
    expect(similarity({ area_target_sf: 10000, preferred_geography_ids: ["g"] }, { area_target_sf: 11000, preferred_geography_ids: ["g"] }).score).toBe(4);
    expect(similarity({ area_target_sf: null, preferred_geography_ids: [] }, { area_target_sf: 11000 }).score).toBe(0);
    expect(reasonTheme("Parking: only 20 slots")).toBe("parking");
  });
  it("Today planner merges intelligence recommendations without duplicates", () => {
    const ok = (items: unknown[]) => ({ state: "ok" as const, items, note: null });
    const v = buildPlannerView({ date: "2026-11-11", tz: "Asia/Kolkata", source: "live", generatedAt: null, headline: null, tasks: null, approvals: null, capacity: null, fmtTime: (s) => s,
      sections: { recommended_actions: ok([{ title: "A", why: "w", href: "/x", ref: "a" }]) },
      extraRecommendations: [{ title: "A", why: "w", href: "/x", ref: "a" }, { title: "Intel", why: "because", href: "/y", ref: "intel:1" }] });
    expect(v.sections.find((s) => s.key === "next")!.items.map((i) => i.key)).toEqual(["a", "intel:1"]);
  });
  it("§7.3 questions route to memory intents", () => {
    expect(classifyIntent("Has their requirement changed?")).toBe("requirement_change");
    expect(classifyIntent("Which companies have similar requirements?")).toBe("similar_requirements");
    expect(classifyIntent("What did we last discuss with Acme?")).toBe("history");
    expect(classifyIntent("Who is the actual decision-maker at Acme?")).toBe("decision_makers");
    expect(classifyIntent("What should I know before meeting Rahul?")).toBe("meeting_prep");
    expect(classifyIntent("Which properties have they rejected and why?")).toBe("rejected_options");
  });
});

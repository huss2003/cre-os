// Test Case 001 — VertexNova Pune expansion (synthetic). Creates the brief's records in the shared test workspace and
// prints all six scores with their factor breakdown. Run: npx vitest run tests/scenarios/vertexnova.db.test.ts
import { it, expect } from "vitest";
import { userClient, WS1, USERS, tag } from "../helpers";
import { recalcOrg, scoreEntity } from "@/modules/scoring/service";
import { runShortlist } from "@/modules/deals/matching/service";

it("VertexNova scores", async () => {
  const db = await userClient("owner");
  const t = tag("vx");
  const one = async (table: string, row: Record<string, unknown>) => { const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single(); if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string; };
  const pune = await one("geography", { name: `Pune ${t}`, level: "city" });
  const kharadi = await one("geography", { name: `Kharadi ${t}`, level: "locality", parent_id: pune });
  const viman = await one("geography", { name: `Viman Nagar ${t}`, level: "locality", parent_id: pune });
  const org = await one("organisation", { display_name: `VertexNova Technologies ${t}`, legal_name: "VertexNova Technologies Pvt. Ltd.", sector: "Information Technology", headcount_min: 2500, domain: `vertexnova-${t}.example`, hq_country: "IN" });
  // Existing Pune presence: Kharadi office (area not given in the brief → left unknown).
  const curAsset = await one("asset", { name: `VertexNova current office ${t}`, locality_id: kharadi });
  await one("lease", { tenant_org_id: org, asset_id: curAsset });
  // Signal: Pune expansion, high reliability, 2 independent sources, partially verified.
  const sig = await one("signal", { category: "expansion", kind: "expansion", title: "Pune Operations Expansion", org_id: org, location_text: "Kharadi, Pune",
    event_date: "2026-11-01", detected_at: "2026-11-05T09:00:00Z", latest_evidence_on: "2026-11-01", confidence: "high", verification: "inference",
    summary: "Announced expansion of Pune operations; ~300 additional hires.", cre_relevance: "Potential additional office-space requirement", dedupe_key: `vx:${t}` });
  for (const n of [1, 2]) await one("signal_evidence", { signal_id: sig, role: "support", dedupe_key: `src${n}`, source_name: `Synthetic source ${n}`, source_url: `https://news${n}.example/vertexnova`, evidence_tier: "credible_reported", fact_status: "reported", published_on: "2026-11-01", excerpt: "Expansion of Pune operations, ~300 hires" });
  await one("signal_evidence", { signal_id: sig, role: "counter", dedupe_key: "counter", excerpt: "Existing office capacity is unknown" });
  // Contact: Head of Administration, verified, 3 interactions (last 15 Oct 2026).
  const rahul = await one("person", { full_name: `Rahul Mehta ${t}` });
  await one("employment", { person_id: rahul, org_id: org, title: "Head of Administration", is_current: true, fact_status: "currently_confirmed" });
  await one("contact_method", { person_id: rahul, method_type: "email", value: `rahul.mehta+${t}@vertexnova.example`, verified_on: "2026-10-15" });
  await one("contact_method", { person_id: rahul, method_type: "phone", value: `+919000000001${t.slice(-3)}`, verified_on: "2026-10-15" });
  for (const d of ["2026-08-20", "2026-09-18", "2026-10-15"]) {
    const i = await one("interaction", { occurred_at: `${d}T10:00:00Z`, channel: d === "2026-10-15" ? "meeting" : "call", is_meaningful: true, subject: "VertexNova catch-up" });
    await one("interaction_link", { interaction_id: i, entity_type: "person", entity_id: rahul, role: "participant" });
  }
  // Requirement: unverified, 20–30k (pref 25k), Kharadi + Viman Nagar, budget unknown, move-in 1 Apr 2027, 5y, warm shell, parking.
  const req = await one("requirement", { org_id: org, title: "Pune Expansion – Additional Office", objective: "expansion", area_min_sf: 20000, area_target_sf: 25000, area_max_sf: 30000, area_basis: "chargeable",
    seats_target: 300, preferred_geography_ids: [kharadi, viman], occupation_date: "2027-04-01", status: "draft",
    constraints: { lease_term_years: 5, furnishing: "warm_shell", parking: "required", source: "research_signal" } });
  // Property: Orion Business Tower, Grade A, 28k sf on 8th floor, ₹95, warm shell, available 1 Mar 2027, verified 6 Nov 2026.
  const orion = await one("asset", { name: `Orion Business Tower ${t}`, locality_id: kharadi, grade: "A", specs: { parking: true, power_backup: true, elevators: true, security: true, cafeteria: true } });
  const sp = await one("space", { asset_id: orion, floor_text: "8", chargeable_sf: 28000 });
  await one("availability", { space_id: sp, as_of: "2026-11-06", status: "available", available_from: "2027-03-01", asking_rent_min: 95, rent_basis: "chargeable", fitout_basis: "warm_shell", fact_status: "currently_confirmed" });
  // Opportunity: qualification, mandate not signed, close 31 Jan 2027, next action set, no fee recorded.
  const opp = await one("opportunity", { org_id: org, requirement_id: req, name: "VertexNova – Pune Expansion", stage: "qualified_discussion", mandate_status: "none", expected_close: "2027-01-31", next_action: "Verify requirement and arrange meeting", outcome: "open" });

  const shortlist = await runShortlist({ db, workspaceId: WS1, userId: USERS.owner.id, role: "owner" } as never, req);
  await recalcOrg(db, WS1, org, "test-case-001");
  const o = await scoreEntity(db, WS1, "opportunity", opp, "test-case-001");
  const get = async (k: string, id: string) => (await db.from("score_result").select("score, band, confidence, completeness, factors, missing, recommended_action, extra").eq("workspace_id", WS1).eq("model_key", k).eq("entity_id", id).eq("is_current", true).single()).data!;
  const out: Record<string, unknown> = {};
  for (const [k, id] of [["company", org], ["lead", org], ["contact", rahul], ["requirement", req], ["opportunity", opp]] as const) {
    const r = await get(k, id);
    out[k] = { score: r.score, band: r.band, confidence: r.confidence, completeness: r.completeness, recommended: r.recommended_action, missing: r.missing, extra: k === "contact" ? r.extra.role_class : k === "requirement" ? { urgency: r.extra.urgency, size: r.extra.attractiveness } : undefined,
      factors: (r.factors as { label: string; points: number; max: number; known: boolean; explanation: string }[]).map((f) => `${f.label}: ${f.known ? `${f.points}/${f.max}` : "unknown"} — ${f.explanation}`) };
  }
  const mine = shortlist.results.find((x) => x.spaceId === sp);
  out.property = mine ? { eligibility: mine.eligibility, fit: mine.fitScore ?? (mine as never as { fit_score?: number }).fit_score, completeness: (mine as never as { completeness?: number }).completeness, disqualifiers: (mine as never as { disqualifiers?: string[] }).disqualifiers, breakdown: (mine as never as { breakdown?: unknown }).breakdown } : "not in shortlist";
  (await import("node:fs")).writeFileSync("/tmp/vertexnova.json", JSON.stringify(out, null, 1));
  expect(o.score).toBeGreaterThan(0);
}, 120_000);

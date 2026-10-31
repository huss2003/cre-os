/** Requirements (6), stakeholders, opportunities across stages (2 lost with reason codes), stage history, quotes, fees. */
import { Rng, addDays, base, did, edate, ist, OWNER_USER_ID, type GenContext, type Row } from "./core";
import { microMarketId, type MicroMarketKey } from "./geography";
import { orgId } from "./organisations";
import { RENT_BASE, type AssetDef, type SpaceDef } from "./assets";
import type { PersonDef } from "./people";

export const STAGES = [
  "research", "approach_attempted", "engaged", "qualified_discussion", "requirement_confirmed", "options_visits",
  "proposal_negotiation", "loi", "documentation", "signed", "possession", "invoiced", "recognised", "collected",
] as const;
type Stage = (typeof STAGES)[number];

interface ReqDef {
  key: string; org: string; title: string; objective: string; kinds: string[];
  area?: [number, number, number]; seats?: [number, number, number]; budget: [number, number, string];
  prefer: MicroMarketKey[]; exclude?: MicroMarketKey[]; status: "estimated" | "client_confirmed";
  decisionMonths: number; occupationMonths: number; constraints: Row; mandate: string;
}
const REQS: ReqDef[] = [
  { key: "R1", org: "northwind_gcc", title: "Northwind GCC — Pune expansion (Phase 2)", objective: "expansion", kinds: ["conventional", "gcc"], area: [120000, 150000, 180000], seats: [1200, 1400, 1600], budget: [85, 105, "INR/sf/month chargeable, warm shell"], prefer: ["sbd_east", "pbd_west"], status: "client_confirmed", decisionMonths: 3, occupationMonths: 11, constraints: { power_backup: "100%", parking: "1 per 1000 sf", certifications: ["LEED Gold"], floor_plate_min_sf: 25000, transit: "Metro or shuttle within 2 km" }, mandate: "exclusive" },
  { key: "R2", org: "glasswing_gcc", title: "Glasswing Retail Tech Centre — new Pune hub", objective: "new", kinds: ["conventional", "gcc"], area: [60000, 80000, 100000], seats: [600, 750, 900], budget: [80, 100, "INR/sf/month chargeable, warm shell"], prefer: ["sbd_east"], exclude: ["pcmc"], status: "estimated", decisionMonths: 4, occupationMonths: 12, constraints: { power_backup: "100%", certifications: ["LEED Gold"], cafeteria: true }, mandate: "non_exclusive" },
  { key: "R3", org: "banyan_helix", title: "Banyan Helix — corporate office relocation", objective: "relocation", kinds: ["conventional"], area: [40000, 50000, 60000], seats: [350, 420, 500], budget: [75, 92, "INR/sf/month chargeable, warm shell"], prefer: ["hadapsar", "sbd_east"], status: "client_confirmed", decisionMonths: 1, occupationMonths: 7, constraints: { power_backup: "100%", lab_ready: false, parking: "1 per 800 sf" }, mandate: "exclusive" },
  { key: "R4", org: "kestrelbay", title: "Kestrelbay Payments — managed space for India team", objective: "flex", kinds: ["managed", "coworking"], seats: [150, 200, 250], budget: [9500, 13500, "INR/seat/month, fully serviced"], prefer: ["cbd", "sbd_east"], status: "estimated", decisionMonths: 2, occupationMonths: 4, constraints: { min_term_months: 24, private_suite: true }, mandate: "non_exclusive" },
  { key: "R5", org: "cobaltfern", title: "Cobaltfern — consolidate three Pune sites", objective: "consolidation", kinds: ["conventional"], area: [80000, 95000, 110000], seats: [800, 950, 1100], budget: [65, 80, "INR/sf/month chargeable, bare shell"], prefer: ["pbd_west", "sbd_west"], status: "estimated", decisionMonths: 5, occupationMonths: 14, constraints: { power_backup: "100%", shuttle_access: true }, mandate: "unknown" },
  { key: "R6", org: "orchard_gcc", title: "Orchard Lumen GCC — renewal & expansion", objective: "renewal", kinds: ["conventional", "gcc"], area: [150000, 170000, 200000], seats: [1500, 1700, 2000], budget: [70, 85, "INR/sf/month chargeable, warm shell"], prefer: ["pbd_west"], status: "client_confirmed", decisionMonths: 2, occupationMonths: 9, constraints: { power_backup: "100%", certifications: ["LEED Platinum"] }, mandate: "exclusive" },
];

interface OppDef { key: string; org: string; req?: string; stage: Stage; outcome: "open" | "dormant" | "lost" | "won"; reason?: string; temp: "cold" | "warm" | "hot"; daysInStage: number; next?: [string, number] }
const OPPS: OppDef[] = [
  { key: "O1", org: "northwind_gcc", req: "R1", stage: "proposal_negotiation", outcome: "open", temp: "hot", daysInStage: 9, next: ["Send revised commercial comparison (v2 quote)", 1] },
  { key: "O2", org: "glasswing_gcc", req: "R2", stage: "options_visits", outcome: "open", temp: "warm", daysInStage: 16, next: ["Kharadi site visits today", 0] },
  { key: "O3", org: "banyan_helix", req: "R3", stage: "loi", outcome: "open", temp: "hot", daysInStage: 6, next: ["Chase landlord on LOI mark-up", -2] },
  { key: "O4", org: "kestrelbay", req: "R4", stage: "qualified_discussion", outcome: "open", temp: "warm", daysInStage: 21, next: ["Confirm seat count with finance", 3] },
  { key: "O5", org: "cobaltfern", req: "R5", stage: "options_visits", outcome: "open", temp: "warm", daysInStage: 12, next: ["Hinjewadi visits tomorrow", 1] },
  { key: "O6", org: "orchard_gcc", req: "R6", stage: "documentation", outcome: "open", temp: "hot", daysInStage: 18, next: ["Review lease deed draft clauses", -5] },
  { key: "O7", org: "marigold_loop", stage: "research", outcome: "open", temp: "cold", daysInStage: 30, next: ["Map decision-makers", 7] },
  { key: "O8", org: "quokka_grid", stage: "approach_attempted", outcome: "open", temp: "cold", daysInStage: 14, next: ["Follow-up on intro email", -1] },
  { key: "O9", org: "saffron_abacus", stage: "engaged", outcome: "open", temp: "warm", daysInStage: 25, next: ["Book discovery meeting", 5] },
  { key: "O10", org: "gearwell", stage: "proposal_negotiation", outcome: "lost", reason: "lost:went_direct_with_landlord", temp: "cold", daysInStage: 44 },
  { key: "O11", org: "tundra_forge", stage: "options_visits", outcome: "lost", reason: "lost:budget_below_market", temp: "cold", daysInStage: 70 },
  { key: "O12", org: "peacock_ridge", stage: "collected", outcome: "won", temp: "hot", daysInStage: 20 },
  { key: "O13", org: "lotuscore", stage: "signed", outcome: "won", temp: "hot", daysInStage: 33, next: ["Raise invoice for signing milestone", -8] },
  { key: "O14", org: "velvetbyte", stage: "engaged", outcome: "dormant", reason: "dormant:hiring_freeze", temp: "cold", daysInStage: 120 },
];

export const reqId = (k: string) => did("requirement", k);
export const oppId = (k: string) => did("opportunity", k);
export const OPP_DEFS = OPPS;

export function buildDeals(ctx: GenContext, roster: PersonDef[], assets: AssetDef[], spaces: SpaceDef[]) {
  const rng = new Rng("deals");
  const requirements: Row[] = [];
  const stakeholders: Row[] = [];
  const opportunities: Row[] = [];
  const history: Row[] = [];
  const quotes: Row[] = [];
  const fees: Row[] = [];
  const peopleAt = (org: string) => roster.filter((p) => p.orgKey === org);

  for (const r of REQS) {
    const people = peopleAt(r.org);
    const confirmer = people[0];
    requirements.push({
      ...base(), id: reqId(r.key), org_id: orgId(r.org), title: r.title, objective: r.objective, transaction_kinds: r.kinds,
      area_min_sf: r.area?.[0] ?? null, area_target_sf: r.area?.[1] ?? null, area_max_sf: r.area?.[2] ?? null, area_basis: r.area ? "chargeable" : null,
      seats_min: r.seats?.[0] ?? null, seats_target: r.seats?.[1] ?? null, seats_max: r.seats?.[2] ?? null,
      budget_min: r.budget[0], budget_max: r.budget[1], budget_basis: r.budget[2],
      preferred_geography_ids: r.prefer.map(microMarketId), excluded_geography_ids: (r.exclude ?? []).map(microMarketId),
      decision_date: edate(ctx.today, r.decisionMonths), occupation_date: edate(ctx.today, r.occupationMonths),
      constraints: { ...r.constraints, synthetic: true },
      status: r.status,
      confirmed_by_person_id: r.status === "client_confirmed" ? confirmer.id : null,
      confirmed_at: r.status === "client_confirmed" ? ist(addDays(ctx.today, -rng.int(5, 30)), "16:00") : null,
      mandate_status: r.mandate, conflict_status: r.status === "client_confirmed" ? "cleared" : "not_checked",
    });
    const roles = ["sponsor", "finance", "procurement", "legal", "technical", "user"] as const;
    people.forEach((p, i) => {
      stakeholders.push({
        ...base("permitted_personal"), id: did("stakeholder", `${r.key}:${p.key}`), requirement_id: reqId(r.key), person_id: p.id, employment_id: p.employmentId,
        role: i === 0 ? "sponsor" : p.title.fn === "finance" ? "finance" : p.title.fn === "procurement" ? "procurement" : p.title.fn === "legal" ? "legal" : rng.pick(roles.slice(4)),
        influence_basis: i === 0 ? "Owns the real-estate decision; signs off shortlist" : rng.pick(["Budget approver", "Runs the RFP process", "Day-to-day contact", "Technical due diligence"]),
        access_status: rng.pick(["direct", "direct", "via_sponsor", "not_yet_met"]),
      });
    });
  }

  for (const o of OPPS) {
    const req = REQS.find((r) => r.key === o.req);
    const stageIdx = STAGES.indexOf(o.stage);
    const enteredDate = addDays(ctx.today, -o.daysInStage);
    const areaForFee = req?.area?.[1] ?? rng.step(20000, 80000, 1000);
    const fee = req?.seats && !req.area ? Math.round(req.seats[1] * 11000 * 1.5) : Math.round(areaForFee * (req ? (req.budget[0] + req.budget[1]) / 2 : 80) * 1.0);
    opportunities.push({
      ...base(), id: oppId(o.key), requirement_id: o.req ? reqId(o.req) : null, org_id: orgId(o.org),
      name: req ? req.title : `${o.org.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} — Pune office opportunity`,
      stage: o.stage, outcome: o.outcome, outcome_reason: o.reason ?? null,
      stage_entered_at: ist(enteredDate, "11:00"), temperature: o.temp,
      mandate_status: req ? req.mandate : rng.pick(["none", "unknown"]),
      account_owner_user_id: OWNER_USER_ID, expected_fee: fee, credit_share: rng.pick([1, 1, 0.5]),
      expected_close: o.outcome === "lost" || o.outcome === "dormant" ? null : o.outcome === "won" ? enteredDate : edate(ctx.today, rng.int(1, 8)),
      next_action: o.next?.[0] ?? null, next_action_due: o.next ? addDays(ctx.today, o.next[1]) : null,
      risks: o.outcome === "open" && stageIdx >= 5 ? rng.pick(["Competing broker active", "Landlord slow on fit-out contribution", "Budget sign-off pending at parent"]) : null,
      crm_external_id: null,
    });
    // stage history: research -> ... -> current, entries spaced back from enteredDate
    const path = STAGES.slice(0, stageIdx + 1).filter((s, i) => i === 0 || i === stageIdx || rng.chance(0.7));
    let when = enteredDate;
    const stamps: string[] = [];
    for (let i = path.length - 1; i >= 0; i--) {
      stamps[i] = when;
      when = addDays(when, -rng.int(7, 35));
    }
    path.forEach((s, i) =>
      history.push({
        ...base(), id: did("opportunity_stage_history", `${o.key}:${s}`), opportunity_id: oppId(o.key),
        from_stage: i === 0 ? null : path[i - 1], to_stage: s, changed_at: ist(stamps[i], "12:00"),
        evidence: i === 0 ? "Created from demo seed" : "Stage change recorded (synthetic)",
      }),
    );
    if (o.outcome === "lost" || o.outcome === "dormant") {
      // outcome lives on the opportunity; history keeps the last stage only
    }
  }

  // ---------------------------------------------------------------- quotes (versions; one expired)
  const assetById = new Map(assets.map((a) => [a.key, a]));
  const pickSpace = (r: ReqDef, salt: number) => {
    const target = r.area?.[1] ?? (r.seats ? r.seats[1] * 60 : 50000);
    const cands = spaces
      .filter((s) => r.prefer.includes(assetById.get(s.assetKey)!.microMarket) && (r.kinds.includes("managed") ? s.config === "managed" : s.config !== "managed"))
      .sort((a, b) => Math.abs(a.chargeable - target) - Math.abs(b.chargeable - target));
    return cands[Math.min(salt, cands.length - 1)] ?? spaces[salt];
  };
  const quote = (key: string, r: ReqDef, salt: number, version: number, validUntil: string, supersededBy: string | null, rentAdj: number) => {
    const s = pickSpace(r, salt);
    const a = assetById.get(s.assetKey)!;
    const seat = r.kinds.includes("managed");
    const rent = seat ? Math.round(12500 * rentAdj) : Math.round(RENT_BASE[a.microMarket] * rentAdj);
    quotes.push({
      ...base(), id: did("quote", key), counterparty_org_id: orgId(a.developer), space_id: s.id, requirement_id: reqId(r.key),
      version, currency: "INR", valid_until: validUntil,
      terms_json: seat
        ? { synthetic: true, rent_per_seat: rent, rent_basis: "seat", seats: r.seats?.[1], lockin_months: 24, tenure_months: 36, escalation_pct: 5, escalation_every_months: 12, deposit_months: 3, taxes: "GST 18% extra", inclusions: ["furniture", "IT backbone", "housekeeping", "power"] }
        : { synthetic: true, rent_per_sf: rent, rent_basis: "chargeable", area_sf: s.chargeable, cam_per_sf: rng.int(12, 18), escalation_pct: 15, escalation_every_months: 36, deposit_months: 6, rent_free_months: rng.pick([2, 3, 4]), capex_contribution_per_sf: rng.pick([0, 0, 300, 500]), lockin_months: 36, tenure_months: 108, taxes: "GST 18% extra; property tax included" },
      approved_floor: null, approved_ceiling: null,
      evidence: `Landlord proposal v${version} (synthetic email)`, approved_at: null, superseded_by: supersededBy ? did("quote", supersededBy) : null,
    });
  };
  const R = (k: string) => REQS.find((r) => r.key === k)!;
  quote("Q-R1-a-v2", R("R1"), 0, 2, addDays(ctx.today, 20), null, 0.97);
  quote("Q-R1-a-v1", R("R1"), 0, 1, addDays(ctx.today, -10), "Q-R1-a-v2", 1.03);
  quote("Q-R6-a-v2", R("R6"), 0, 2, addDays(ctx.today, 35), null, 0.95);
  quote("Q-R6-a-v1", R("R6"), 0, 1, addDays(ctx.today, -25), "Q-R6-a-v2", 1.0);
  quote("Q-R3-a-v1", R("R3"), 0, 1, addDays(ctx.today, 14), null, 0.99);
  quote("Q-R2-a-v1", R("R2"), 1, 1, addDays(ctx.today, -12), null, 1.05); // expired, never superseded
  quote("Q-R5-a-v1", R("R5"), 0, 1, addDays(ctx.today, 40), null, 0.93);
  quote("Q-R4-a-v1", R("R4"), 0, 1, addDays(ctx.today, 21), null, 1.0);

  // ---------------------------------------------------------------- fee milestones
  const fee = (key: string, opp: string, gross: number, milestone: string, extra: Row) =>
    fees.push({
      ...base(), id: did("fee_milestone", key), opportunity_id: oppId(opp), gross_fee: gross, exclusions: "Excludes GST; excludes fit-out PM fees",
      credit_share: 1, milestone, invoiced_amount: null, invoiced_on: null, recognised_amount: null, recognised_on: null,
      collected_amount: null, collected_on: null, currency: "INR", tax_basis: "GST 18% extra", evidence: "Engagement letter (synthetic)", ...extra,
    });
  fee("F-O12-signing", "O12", 3800000, "on_signing", { invoiced_amount: 3800000, invoiced_on: addDays(ctx.today, -95), recognised_amount: 3800000, recognised_on: addDays(ctx.today, -90), collected_amount: 3800000, collected_on: addDays(ctx.today, -40) });
  fee("F-O13-signing", "O13", 2400000, "on_signing", { invoiced_amount: 1200000, invoiced_on: addDays(ctx.today, -20) });
  fee("F-O13-possession", "O13", 2400000, "on_possession", {});
  fee("F-O6-signing", "O6", 6500000, "on_signing", {});
  fee("F-O3-signing", "O3", 3100000, "on_signing", { credit_share: 0.5, exclusions: "Shared 50:50 with partner desk (synthetic)" });

  return { requirements, stakeholders, opportunities, history, quotes, fees };
}

// @ts-nocheck -- journey tests read untyped Supabase rows (no generated DB types); runtime assertions do the checking.
// Journey test plan — STAGE 3: Module 3 Scoring Engine (TC 3.1–3.7). Synthetic ABC Technologies, WS1 owner, rules only (mock-AI).
// Real services behind /scoring and /companies/[id]?tab=scores: scoring/service (scoreEntity, recalcOrg, overridePriority, preview),
// deals/requirements (createRequirement, updateRequirementFields), deals/pipeline (createOpportunity, logObjection), signals ingestText.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, USERS, tag } from "../helpers";
import { createEntity } from "@/modules/admin/entities";
import { ingestText } from "@/modules/signals/service";
import { scoreEntity, recalcOrg, overridePriority, preview } from "@/modules/scoring/service";
import { MODELS } from "@/modules/scoring/models";
import { createRequirement, updateRequirementFields } from "@/modules/deals/requirements/service";
import { createOpportunity, logObjection } from "@/modules/deals/pipeline/service";
import { proposeChange } from "@/lib/services/changes";

const log = (id: string, actual: unknown) => console.log(`[ACTUAL ${id}]`, JSON.stringify(actual));
type Row = Record<string, any>;
const factor = (r: Row, k: string) => (r.factors as Row[]).find((f) => f.key === k);
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("Journey M3 — Scoring Engine", () => {
  let db: Awaited<ReturnType<typeof userClient>>;
  const owner = USERS.owner.id;
  const t = tag("j3");
  const ABC = `ABC Technologies Pvt. Ltd. ${t}`;
  const ids: Record<string, string> = {};
  const ctx = () => ({ db, workspaceId: WS1, userId: owner });
  const one = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: owner, ...row }).select("id").single();
    if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string;
  };
  const interaction = async (orgId: string, personId: string | null, channel: string, daysAgo: number, extra: Row = {}) => {
    const id = await one("interaction", { occurred_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(), channel, direction: "outbound", subject: `${channel} ${t}`, is_meaningful: true, ...extra });
    await one("interaction_link", { interaction_id: id, entity_type: "organisation", entity_id: orgId });
    if (personId) await one("interaction_link", { interaction_id: id, entity_type: "person", entity_id: personId });
    return id;
  };

  beforeAll(async () => {
    db = await userClient("owner");
    ids.org = (await createEntity(db, WS1, owner, "organisation", { display_name: ABC, sector: "Information Technology", headcount_min: "250", headcount_max: "250" })).id;
    ids.loc = await one("geography", { name: `Kharadi ${t}`, level: "locality" });
    ids.asset = await one("asset", { name: `ABC Kharadi Office ${t}`, locality_id: ids.loc, address: "Kharadi, Pune" });
    ids.lease = await one("lease", { tenant_org_id: ids.org, asset_id: ids.asset, area_sf: 15000, fact_status: "reported" });
    for (const [n, title] of [["Rahul Sharma", "Head of Administration"], ["Priya Mehta", "Head of Finance"], ["Amit Verma", "Head of Human Resources"]]) {
      ids[n] = await one("person", { full_name: `${n} ${t}` });
      await one("employment", { person_id: ids[n], org_id: ids.org, title, is_current: true });
    }
    await ingestText(db, WS1, { text: `${ABC} announces expansion of its Pune operations.`, companyName: ABC, sourceName: "Synthetic press release", publishedOn: days(-3), actorUserId: owner });
    await interaction(ids.org, ids["Rahul Sharma"], "call", 20);
    const req = await createRequirement(ctx(), { orgId: ids.org, title: `ABC 25k SF ${t}`, changes: [
      { key: "area", value: [25000, 25000, 25000] }, { key: "preferred_locations", value: [ids.loc] },
      { key: "occupation_date", value: days(270) }, { key: "tenure_months", value: 60 }, { key: "budget", value: [110, 125] }, { key: "budget_basis", value: "per_sf_month" },
    ] });
    ids.req = String(req.id);
  });

  it("TC3.1 lead priority: score generated; timing/need/access/fit/engagement/freshness considered; plan weights configurable", async () => {
    const r = await scoreEntity(db, WS1, "lead", ids.org, "journey");
    const keys = (r.factors as Row[]).map((f) => `${f.key}:${f.weight}`);
    log("3.1", { score: r.score, band: r.band, factors: (r.factors as Row[]).map((f) => [f.key, f.weight, f.value, f.explanation]), missing: r.missing, action: r.recommended_action });
    expect(typeof r.score).toBe("number");
    for (const k of ["timing", "need", "authority", "fit", "engagement", "evidence"]) expect(factor(r, k), k).toBeTruthy();
    // configurable plan weights: Timing 25, Need 25, Relationship access 20, Commercial fit 15, Engagement 10, Evidence freshness 5
    const draft = { ...MODELS.lead.version, factors: [
      { ...MODELS.lead.version.factors.find((f) => f.key === "timing")!, weight: 25 },
      { ...MODELS.lead.version.factors.find((f) => f.key === "need")!, weight: 25 },
      { ...MODELS.lead.version.factors.find((f) => f.key === "authority")!, weight: 20 },
      { ...MODELS.lead.version.factors.find((f) => f.key === "fit")!, weight: 15 },
      { ...MODELS.lead.version.factors.find((f) => f.key === "engagement")!, weight: 10 },
      { ...MODELS.lead.version.factors.find((f) => f.key === "evidence")!, weight: 5 },
    ] };
    const p = await preview(db, WS1, "lead", draft, ids.org);
    log("3.1-planweights", { current: p.current.score, planWeights: p.draft.score, defaultWeights: keys });
    expect(p.draft.score).toBeGreaterThanOrEqual(0);
    expect.soft(keys.sort(), "shipped DEFAULT lead weights differ from the plan's 25/25/20/15/10/5").toEqual(["authority:20", "engagement:10", "evidence:5", "fit:15", "need:25", "timing:25"].sort());
    // "Evidence freshness" must be considered as freshness (recency), not only strength
    expect(String(factor(r, "evidence")!.explanation)).toMatch(/day|fresh|recen|ago|\d{4}-\d{2}/i);
  });

  it("TC3.2 requirement readiness: checks 9 items and lists missing ones separately", async () => {
    const r = await scoreEntity(db, WS1, "requirement", ids.req, "journey");
    const blob = JSON.stringify({ f: r.factors, m: r.missing });
    const items = { location: /location|micro-market/i, area: /area/i, budget: /budget/i, timeline: /move-in|occupation|timing|decision date/i, tenure: /lease terms|tenure|lease duration/i,
      decisionMakers: /decision-maker|stakeholder/i, approvalProcess: /approval|procurement|commercial authority/i, technical: /technical|power|it load|spec/i, feasibility: /feasib|commercial/i };
    const covered = Object.fromEntries(Object.entries(items).map(([k, re]) => [k, re.test(blob)]));
    log("3.2", { score: r.score, covered, missing: r.missing, factors: (r.factors as Row[]).map((f) => [f.key, f.value, f.known]) });
    expect(Array.isArray(r.missing)).toBe(true);
    expect((r.missing as unknown[]).length).toBeGreaterThan(0); // decision-maker / approval missing in this fixture
    expect.soft(r.missing, "tenure (60 months) was entered on the requirement but readiness reports 'Lease duration' missing").not.toContain("Lease duration");
    for (const [k, v] of Object.entries(covered)) expect.soft(v, `readiness does not assess "${k}"`).toBe(true);
  });

  it("TC3.3 missing budget: identified, not scored as zero, explained", async () => {
    const before = await scoreEntity(db, WS1, "requirement", ids.req, "journey");
    const { data: cur } = await db.from("requirement").select("row_version").eq("id", ids.req).single();
    const u = await updateRequirementFields(ctx(), ids.req, Number(cur.row_version), [{ key: "budget", value: [null, null] }], "Journey TC3.3: remove budget");
    const after = await scoreEntity(db, WS1, "requirement", ids.req, "journey");
    const b = factor(after, "budget")!;
    log("3.3", { proposals: u.proposals, applied: u.applied, before: before.score, after: after.score, budgetFactor: b, missing: after.missing });
    expect(JSON.stringify(after.missing)).toMatch(/budget/i);
    expect.soft(b.known === false && b.points === 0 && b.max === 0, "missing budget is counted as a ZERO value (unknown policy 'zero'), lowering the score as if budget were 0").toBe(true);
    expect.soft(JSON.stringify(after.missing) + b.explanation, "explain why budget matters").toMatch(/because|needed|matters|shortlist|affordab|filter/i);
  });

  it("TC3.4 deal health: blocker, pending approval, overdue action, stall explained", async () => {
    const opp = await createOpportunity(ctx(), { name: `ABC Pune expansion deal ${t}`, requirementId: ids.req, stage: "qualified_discussion", nextAction: "Send revised shortlist", nextActionDue: days(-20) });
    ids.opp = String(opp.id);
    await interaction(ids.org, ids["Rahul Sharma"], "meeting", 45, { opportunity_id: ids.opp, summary: "Initial client interaction" });
    await one("shortlist_option", { requirement_id: ids.req, asset_id: ids.asset, eligible: true, rubric_version: "journey" }).catch((e) => log("3.4-shortlist-insert-error", String(e)));
    await logObjection(ctx(), ids.opp, { category: "price", objection: "Rent above approved budget" });
    const { data: o } = await db.from("opportunity").select("row_version, classification").eq("id", ids.opp).single();
    await proposeChange(db, WS1, { targetType: "opportunity", targetId: ids.opp, operation: "update", expectedVersion: Number(o.row_version), patch: [{ op: "replace", path: "/expected_fee", value: 5000000 }], reason: "Pending approval (journey TC3.4)", proposedByKind: "user", classification: o.classification });
    const r = await scoreEntity(db, WS1, "opportunity", ids.opp, "journey");
    const blob = JSON.stringify({ f: r.factors, m: r.missing, a: r.recommended_action, x: r.extra });
    const found = { blocker: /objection|blocker/i.test(blob), pendingApproval: /pending approval|awaiting approval|approval pending/i.test(blob), overdue: /overdue/i.test(blob), stalled: /stall|no recent progress|no progress/i.test(blob) };
    log("3.4", { score: r.score, band: r.band, found, missing: r.missing, action: r.recommended_action, factors: (r.factors as Row[]).map((f) => [f.key, f.explanation]) });
    for (const [k, v] of Object.entries(found)) expect.soft(v, `deal health does not identify: ${k}`).toBe(true);
  });

  it("TC3.5 score changes after meeting + budget + confirmed timeline: explained, history kept, unrelated unchanged", async () => {
    const leadBefore = await scoreEntity(db, WS1, "lead", ids.org, "journey");
    const reqBefore = await scoreEntity(db, WS1, "requirement", ids.req, "journey");
    const relBefore = await scoreEntity(db, WS1, "relationship", ids.org, "journey");
    const coBefore = await scoreEntity(db, WS1, "company", ids.org, "journey");
    await interaction(ids.org, ids["Priya Mehta"], "meeting", 1, { summary: "Confirmed meeting with Head of Finance (decision-maker)" });
    const { data: cur } = await db.from("requirement").select("row_version").eq("id", ids.req).single();
    const u = await updateRequirementFields(ctx(), ids.req, Number(cur.row_version), [{ key: "budget", value: [100, 115], status: "client_confirmed" }, { key: "occupation_date", value: days(270), status: "client_confirmed" }], "Journey TC3.5: client confirmed budget + timeline");
    await recalcOrg(db, WS1, ids.org, "journey");
    const cur2 = async (k: string, id: string) => (await db.from("score_result").select("*").eq("workspace_id", WS1).eq("model_key", k).eq("entity_id", id).eq("is_current", true).single()).data as Row;
    const [lead, req, rel, co] = await Promise.all([cur2("lead", ids.org), cur2("requirement", ids.req), cur2("relationship", ids.org), cur2("company", ids.org)]);
    const { count } = await db.from("score_result").select("id", { count: "exact", head: true }).eq("workspace_id", WS1).eq("model_key", "requirement").eq("entity_id", ids.req);
    log("3.5", { proposals: u.proposals, applied: u.applied, lead: [leadBefore.score, lead.score, lead.change_reason], req: [reqBefore.score, req.score, req.change_reason], rel: [relBefore.score, rel.score, rel.change_reason], company: [coBefore.score, co.score], reqHistoryRows: count });
    expect(req.score !== reqBefore.score || rel.score !== relBefore.score || lead.score !== leadBefore.score).toBe(true);
    expect(rel.score).toBeGreaterThan(relBefore.score);
    expect(String(rel.change_reason ?? "")).not.toBe("");
    expect(count!).toBeGreaterThan(1);
    expect(co.score).toBe(coBefore.score);
  });

  it("TC3.6 manual override: saved with reason, original score kept, review date visible", async () => {
    const calc = await scoreEntity(db, WS1, "lead", ids.org, "journey");
    await overridePriority(db, WS1, owner, "lead", ids.org, "High", "Board approved Pune expansion — journey TC3.6");
    const { data: ov } = await db.from("score_override").select("*").eq("workspace_id", WS1).eq("model_key", "lead").eq("entity_id", ids.org).eq("active", true).single();
    const { data: still } = await db.from("score_result").select("score").eq("workspace_id", WS1).eq("model_key", "lead").eq("entity_id", ids.org).eq("is_current", true).single();
    log("3.6", { override: ov, calcScore: calc.score, currentScore: still.score });
    expect(ov.value).toBe("High");
    expect(ov.reason).toMatch(/Board approved/);
    expect(ov.original_score).toBe(calc.score);
    expect(still.score).toBe(calc.score);
    expect.soft(Object.keys(ov).some((k) => /review/.test(k)), "score_override has no review date field (overridePriority takes none)").toBe(true);
  });

  it("TC3.7 ranked accounts: ranked, distinguishable, reasons, missing info, next action", async () => {
    const mk = async (n: string) => (await createEntity(db, WS1, owner, "organisation", { display_name: `${n} ${t}`, sector: "Information Technology" })).id;
    const hot = await mk("Hotco Systems"); const warm = await mk("Warmco Analytics"); const cold = await mk("Coldco Retail");
    // hot: lease expiry in 120 days + expansion signal + contact + meeting + requirement
    const l = await one("lease", { tenant_org_id: hot, asset_id: ids.asset, area_sf: 30000, fact_status: "reported" });
    await one("lease_event", { lease_id: l, event_type: "expiry", event_date: days(120), date_basis: "contractual", confirmed: true });
    await ingestText(db, WS1, { text: `Hotco Systems ${t} announces expansion of its Pune operations.`, orgId: hot, companyName: `Hotco Systems ${t}`, sourceName: "Synthetic", publishedOn: days(-2), actorUserId: owner });
    const hp = await one("person", { full_name: `Hot Admin ${t}` }); await one("employment", { person_id: hp, org_id: hot, title: "Head of Facilities", is_current: true });
    await interaction(hot, hp, "meeting", 5);
    await createRequirement(ctx(), { orgId: hot, title: `Hotco req ${t}`, changes: [{ key: "area", value: [30000, 35000, 40000] }, { key: "occupation_date", value: days(200) }] });
    // warm: hiring signal + contact only
    await ingestText(db, WS1, { text: `Warmco Analytics ${t} is hiring 200 engineers in Pune.`, orgId: warm, companyName: `Warmco Analytics ${t}`, sourceName: "Synthetic", publishedOn: days(-10), actorUserId: owner });
    const wp = await one("person", { full_name: `Warm HR ${t}` }); await one("employment", { person_id: wp, org_id: warm, title: "HR Manager", is_current: true });
    // cold: nothing
    const rows: Row[] = [];
    for (const id of [hot, warm, cold]) { await recalcOrg(db, WS1, id, "journey"); rows.push({ ...(await scoreEntity(db, WS1, "lead", id, "journey")), org: id }); }
    const ranked = [...rows].sort((a, b) => b.score - a.score);
    log("3.7", ranked.map((r) => ({ id: r.org === hot ? "hot" : r.org === warm ? "warm" : "cold", score: r.score, band: r.band, missing: r.missing, action: r.recommended_action, top: (r.factors as Row[]).filter((f) => f.points > 0).map((f) => f.label) })));
    expect(ranked.map((r) => r.org)).toEqual([hot, warm, cold]);
    expect(new Set(rows.map((r) => r.score)).size).toBe(3);
    for (const r of rows) {
      expect((r.factors as Row[]).every((f) => typeof f.explanation === "string")).toBe(true);
      expect(Array.isArray(r.missing)).toBe(true);
      expect(String(r.recommended_action ?? "")).not.toBe("");
    }
  });

  it("M3 pass: lead priority, requirement readiness, deal health and relationship strength kept separate", async () => {
    const { data } = await db.from("score_result").select("model_key").eq("workspace_id", WS1).eq("is_current", true).in("entity_id", [ids.org, ids.req, ids.opp]);
    const keys = new Set((data ?? []).map((r) => r.model_key));
    for (const k of ["lead", "requirement", "opportunity", "relationship"]) expect(keys.has(k), k).toBe(true);
  });
});

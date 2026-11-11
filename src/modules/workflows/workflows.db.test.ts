// Workflow orchestrator (Module 9): Workflow 1 (signal → action) and Workflow 7 (lease → renewal/relocation).
// Runs against the local stack as the seeded owner (RLS enforced). Fixtures are tagged; nothing is deleted.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import { runSignalChain, runLeaseChain, getSettings } from "./service";
import { leaseWindow, signalStrength, monthlyRent, parseSettings } from "./rules";
import { approveAndApply } from "@/modules/changes/service";
import { localDate, edate } from "@/lib/util/time";

const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
type Db = Awaited<ReturnType<typeof userClient>>;
type Row = Record<string, any>;
const today = localDate();

describe("workflow rules", () => {
  it("picks the earliest window, ignores past and far dates", () => {
    const l = { id: "L", contractual_expiry: edate(today, 10) };
    expect(leaseWindow(l, [], today)?.kind).toBe("expiry_12m");
    expect(leaseWindow(l, [{ lease_id: "L", event_type: "notice_deadline", event_date: edate(today, 4) }], today)?.kind).toBe("notice_6m");
    expect(leaseWindow(l, [{ lease_id: "L", event_type: "lockin_end", event_date: edate(today, 8) }], today)?.kind).toBe("expiry_12m");
    expect(leaseWindow({ id: "L", contractual_expiry: edate(today, 13) }, [], today)).toBeNull();
    expect(leaseWindow({ id: "L", contractual_expiry: edate(today, -1) }, [], today)).toBeNull();
  });
  it("signal strength follows signal confidence/verification; unknowns stay null; toggles default on", () => {
    expect(signalStrength({ verification: "hypothesis", confidence: "low" }).strong).toBe(false);
    expect(signalStrength({ verification: "inference", confidence: "medium" }).strong).toBe(true);
    expect(monthlyRent(null, 1000)).toBeNull();
    expect(monthlyRent("95.5", 1000)).toBe("95500.00");
    expect(parseSettings(null)).toMatchObject({ signal_chain: true, lease_chain: true });
    expect(parseSettings({ lease_chain: false }).lease_chain).toBe(false);
  });
});

async function company(db: Db, t: string, name: string, o: { dms?: number; dnc?: boolean; leaseMonths?: number | null } = {}) {
  const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `${name} ${t}`, sector: "Technology" }).select("id").single()).data!.id as string;
  const people: string[] = [];
  for (let i = 0; i < (o.dms ?? 0); i++) {
    const pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Asha Rao${i} ${t}`, do_not_contact: !!o.dnc }).select("id").single()).data!.id as string;
    await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: org, title: "Head of Corporate Real Estate", is_current: true });
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "email", value: `asha${i}@${t}.example`, verify_status: "verified" });
    await db.from("contact_role_assessment").insert({ workspace_id: WS1, person_id: pid, org_id: org, role_class: "decision_maker", cre_relevance: "high", active: true, source: "user", reason: "test fixture" });
    people.push(pid);
  }
  if (o.leaseMonths != null) {
    const l = (await db.from("lease").insert({ workspace_id: WS1, tenant_org_id: org, contractual_expiry: edate(today, o.leaseMonths), area_sf: 10000, status: "active" }).select("id").single()).data!.id;
    await db.from("lease_event").insert({ workspace_id: WS1, lease_id: l, event_type: "expiry", event_date: edate(today, o.leaseMonths), date_basis: "contractual", confirmed: true });
  }
  return { org, people };
}
async function signal(db: Db, t: string, org: string, strong = true) {
  const r = await db.from("signal").insert({
    workspace_id: WS1, category: "expansion", kind: "expansion", title: `Pune expansion ${t}`, org_id: org, event_date: edate(today, 1),
    verification: strong ? "fact" : "hypothesis", confidence: strong ? "high" : "low", dedupe_key: `wf:${t}:${Math.random()}`, latest_evidence_on: today,
  }).select("id").single();
  if (r.error) throw new Error(r.error.message);
  return r.data.id as string;
}
const steps = async (db: Db, runId: string) => Object.fromEntries(((await db.from("workflow_step").select("step_key, status, reason, output_refs").eq("run_id", runId)).data ?? []).map((s: Row) => [s.step_key, s]));
const outreachFor = async (db: Db, org: string) => (await db.from("outreach_item").select("id, status, sent_at, draft_id").eq("workspace_id", WS1).eq("org_id", org)).data ?? [];

describe("Workflow 1 — signal → action", () => {
  let db: Db; const t = tag("wf1");
  beforeAll(async () => { db = await userClient("owner"); expect((await getSettings(db, WS1)).signal_chain).toBe(true); });

  it("happy path: company, contacts skipped (2 decision-makers), scores, one draft — nothing sent; second run does nothing", async () => {
    const { org } = await company(db, t, "Helix", { dms: 2, leaseMonths: 3 });
    const sid = await signal(db, t, org);
    const r = await runSignalChain(db, WS1, sid, { ai: noAi });
    expect(r).toBeTruthy();
    const s = await steps(db, r!.runId);
    expect(s.company.status).toBe("done");
    expect(s.contacts.status, s.contacts.reason).toBe("skipped"); expect(s.contacts.reason).toMatch(/2 current decision-makers/);
    expect(s.scores.status).toBe("done");
    expect(s.outreach.status, s.outreach.reason).toBe("done");
    const items = await outreachFor(db, org);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("draft"); expect(items[0].sent_at).toBeNull();
    const d = (await db.from("draft").select("state, approved_at, marked_sent_at").eq("id", items[0].draft_id).single()).data!;
    expect(d.state).not.toMatch(/sent|approved/); expect(d.approved_at).toBeNull(); expect(d.marked_sent_at).toBeNull();
    expect(await runSignalChain(db, WS1, sid, { ai: noAi })).toBeNull();
    expect(await outreachFor(db, org)).toHaveLength(1);

    // A second signal for the same company: outreach skipped by the 30-day quiet period.
    const sid2 = await signal(db, `${t}b`, org);
    const r2 = await runSignalChain(db, WS1, sid2, { ai: noAi });
    expect((await steps(db, r2!.runId)).outreach.reason).toMatch(/quiet period/);
    expect(await outreachFor(db, org)).toHaveLength(1);
  });

  it("do-not-contact decision-makers block the draft", async () => {
    const { org } = await company(db, `${t}d`, "Quorra", { dms: 2, dnc: true, leaseMonths: 3 });
    const r = await runSignalChain(db, WS1, await signal(db, `${t}d`, org), { ai: noAi });
    const s = await steps(db, r!.runId);
    expect(s.outreach.status).toBe("skipped");
    expect(s.outreach.reason).toMatch(/do-not-contact/);
    expect(await outreachFor(db, org)).toHaveLength(0);
  });

  it("no decision-maker: contact research runs (mock), no draft", async () => {
    const { org } = await company(db, `${t}n`, "Nimbus", { leaseMonths: 3 });
    const r = await runSignalChain(db, WS1, await signal(db, `${t}n`, org), { ai: noAi });
    const s = await steps(db, r!.runId);
    expect(s.contacts.status).toBe("done");
    expect(s.contacts.output_refs[0].type).toBe("enrichment_job");
    expect(s.outreach.status).toBe("skipped");
    expect(s.outreach.reason).toMatch(/No decision-maker/);
    expect(await outreachFor(db, org)).toHaveLength(0);
  });

  it("weak (hypothesis) signal: steps a–c run, outreach skipped with the signals-rules reason", async () => {
    const { org } = await company(db, `${t}w`, "Wisp", { dms: 2, leaseMonths: 3 });
    const r = await runSignalChain(db, WS1, await signal(db, `${t}w`, org, false), { ai: noAi });
    const s = await steps(db, r!.runId);
    expect(s.scores.status).toBe("done");
    expect(s.outreach.status).toBe("skipped"); expect(s.outreach.reason).toMatch(/signals rules/);
    expect(await outreachFor(db, org)).toHaveLength(0);
  });
});

describe("Workflow 7 — lease → renewal / relocation", () => {
  let db: Db; const t = tag("wf7");
  let mm: string; let asset: string;
  beforeAll(async () => {
    db = await userClient("owner");
    const city = (await db.from("geography").insert({ workspace_id: WS1, level: "city", name: `City ${t}` }).select("id").single()).data!.id;
    mm = (await db.from("geography").insert({ workspace_id: WS1, level: "micro_market", name: `MM ${t}`, parent_id: city }).select("id").single()).data!.id;
    await db.from("geography").insert({ workspace_id: WS1, level: "micro_market", name: `MM2 ${t}`, parent_id: city });
    asset = (await db.from("asset").insert({ workspace_id: WS1, name: `Current Tower ${t}`, micro_market_id: mm, specs: {} }).select("id").single()).data!.id;
    const alt = (await db.from("asset").insert({ workspace_id: WS1, name: `Alt Tower ${t}`, micro_market_id: mm, specs: {} }).select("id").single()).data!.id;
    const sp = (await db.from("space").insert({ workspace_id: WS1, asset_id: alt, chargeable_sf: 10000, carpet_sf: 7000 }).select("id").single()).data!.id;
    await db.from("availability").insert({ workspace_id: WS1, space_id: sp, as_of: today, status: "available", asking_rent_min: 90, asking_rent_max: 95, rent_basis: "chargeable", fact_status: "currently_confirmed", valid_until: "2099-12-31" });
  });
  async function leaseFor(name: string, rent: number | null) {
    const org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `${name} ${t}` }).select("id, display_name").single()).data!;
    const lease = (await db.from("lease").insert({ workspace_id: WS1, tenant_org_id: org.id, asset_id: asset, area_sf: 10000, area_basis: "chargeable", rent_per_sf: rent, rent_basis: "chargeable", contractual_expiry: edate(today, 8), status: "active" }).select("id").single()).data!.id as string;
    return { org, lease };
  }

  it("proposes the requirement (unknowns null), waits for approval, then shortlists, compares, adds one task; idempotent", async () => {
    const { org, lease } = await leaseFor("Orion", 100);
    const r1 = await runLeaseChain(db, WS1, lease, { ai: noAi });
    expect(r1!.status).toBe("waiting_approval");
    const s1 = await steps(db, r1!.runId);
    expect(s1.requirement.status).toBe("waiting_approval");
    const pid = s1.requirement.output_refs[0].id;
    const prop = (await db.from("change_proposal").select("patch, risk").eq("id", pid).single()).data!;
    expect(prop.risk).toBe("material_fact");
    const paths = (prop.patch as Row[]).map((p) => p.path);
    expect(paths).not.toContain("/seats_target"); expect(paths).not.toContain("/budget_max"); expect(paths).not.toContain("/occupation_date");
    expect(await db.from("requirement").select("id").eq("org_id", org.id).then((x) => x.data)).toHaveLength(0);

    await approveAndApply(db, pid);
    const r2 = await runLeaseChain(db, WS1, lease, { ai: noAi });
    expect(r2!.runId).toBe(r1!.runId);
    const s2 = await steps(db, r2!.runId);
    expect(s2.requirement.status).toBe("done");
    expect(s2.shortlist.status, s2.shortlist.reason).toBe("done");
    expect(s2.analysis.status, s2.analysis.reason).toBe("done");
    expect(s2.task.status).toBe("done");
    const req = (await db.from("requirement").select("*").eq("org_id", org.id).single()).data!;
    expect(req.title).toBe(`Renewal or relocation — ${org.display_name}`);
    expect(Number(req.area_target_sf)).toBe(10000);
    expect(req.preferred_geography_ids).toContain(mm);
    expect(req.preferred_geography_ids.length).toBeGreaterThanOrEqual(2); // same + adjacent micro-market
    for (const k of ["seats_min", "seats_target", "seats_max", "budget_min", "budget_max", "decision_date", "occupation_date"]) expect(req[k]).toBeNull();
    const an = (await db.from("deal_analysis").select("kind, inputs, missing, status").eq("id", s2.analysis.output_refs[0].id).single()).data!;
    expect(an.kind).toBe("renewal_vs_relocation");
    expect(an.inputs.renewal.proposedRentMonthly).toBe("1000000.00");
    expect(an.inputs.relocation.fitout).toBeNull();
    expect(an.missing.length).toBeGreaterThan(0);
    const tasks = (await db.from("task").select("id, title").eq("workspace_id", WS1).eq("linked_entity_id", req.id).eq("source", "workflow")).data!;
    expect(tasks).toHaveLength(1); expect(tasks[0].title).toMatch(/Discuss renewal vs relocation/);
    expect(await outreachFor(db, org.id)).toHaveLength(0); // no decision-maker → no draft
    expect(s2.outreach.status).toBe("skipped");

    expect(await runLeaseChain(db, WS1, lease, { ai: noAi })).toBeNull();
    expect((await db.from("task").select("id").eq("linked_entity_id", req.id).eq("source", "workflow")).data).toHaveLength(1);
    expect((await db.from("deal_analysis").select("id").eq("requirement_id", req.id)).data).toHaveLength(1);
  }, 120_000);

  it("missing lease rent: comparison skipped with a reason", async () => {
    const { lease } = await leaseFor("Vega", null);
    const r1 = await runLeaseChain(db, WS1, lease, { ai: noAi });
    await approveAndApply(db, (await steps(db, r1!.runId)).requirement.output_refs[0].id);
    const r2 = await runLeaseChain(db, WS1, lease, { ai: noAi });
    const s = await steps(db, r2!.runId);
    expect(s.analysis.status).toBe("skipped");
    expect(s.analysis.reason).toMatch(/Current rent unknown/);
    expect(s.task.status).toBe("done");
  }, 120_000);
});

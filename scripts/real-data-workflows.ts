/**
 * Downstream workflows for scripts/real-data-e2e.ts (imported by it; not run on its own). Drives the module services exactly as the
 * app does: user-scoped (RLS) client for user actions, service-role client only for the scheduled-job paths (radar/recalc,
 * stale detector), always filtered by the test workspace id.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Client as Pg } from "pg";

type Db = SupabaseClient<any, any, any>;
interface Args { db: Db; admin: Db; ws: string; owner: string; out: string; data: string; log: (...a: unknown[]) => void }

const detUuid = (s: string) => {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

async function sql(q: string, params: unknown[] = []) {
  const pg = new Pg({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    return (await pg.query(q, params)).rows;
  } finally {
    await pg.end();
  }
}

/* ------------------------------------------------------------------ 1. lease radar */

async function leaseRadar(a: Args, today: string) {
  const { loadRadar, persistCalculatedEvents, raiseRadarTasks, raiseRadarAlerts } = await import("../src/modules/brief/radar-data");
  const { runCaretaker } = await import("../src/modules/brief/caretaker-data");
  const { computeScores, persistScores } = await import("../src/modules/brief/scoring-data");
  const { loadSettings } = await import("../src/modules/brief/db");
  // Same steps, same order as brief/jobs.ts#runRecalc (the 07:00 brief.recalc job). jobs.ts itself is not imported because its
  // transitive imports (job registry -> UI) need the Next.js React runtime.
  const runRecalc = async () => {
    const settings = await loadSettings(a.admin, a.ws, null);
    const radar = await loadRadar(a.admin, a.ws, today, settings);
    const events = await persistCalculatedEvents(a.admin, a.ws, radar);
    const tasks = await raiseRadarTasks(a.admin, a.ws, radar, today, a.owner);
    const alerts = await raiseRadarAlerts(a.admin, a.ws, radar, today, a.owner);
    const caretaker = await runCaretaker(a.admin, a.ws, today, radar.items, a.owner);
    const scores = await computeScores(a.admin, a.ws, today, settings, radar.items);
    const persisted = await persistScores(a.admin, a.ws, scores);
    return { leases: radar.items.length, events, tasks, alerts, caretaker, scored: scores.length, ...persisted };
  };
  const t0 = Date.now();
  const recalc1 = await runRecalc();
  const recalc2 = await runRecalc(); // idempotent re-run: no new tasks/events
  const settings = await loadSettings(a.admin, a.ws, null);
  const { items } = await loadRadar(a.admin, a.ws, today, settings);
  const leases = await sql(`select id, tenure_months_raw, lockin_months_raw, contractual_expiry from mudar.lease where workspace_id=$1 and archived_at is null`, [a.ws]);
  const byId = new Map(leases.map((l: any) => [l.id, l]));
  const count = (f: (i: any) => boolean) => items.filter(f).length;
  const basisCount = (pick: (i: any) => any) => {
    const m: Record<string, number> = {};
    for (const i of items) {
      const f = pick(i);
      if (f) m[f.basis] = (m[f.basis] ?? 0) + 1;
    }
    return m;
  };
  // lock-in must never become expiry: (a) lock-in-only leases have no expiry; (b) when both exist, they come from different events
  const lockinOnly = items.filter((i) => { const l = byId.get(i.leaseId); return l && l.tenure_months_raw === null && l.lockin_months_raw !== null; });
  const lockinOnlyWithExpiry = lockinOnly.filter((i) => i.expiry);
  const both = items.filter((i) => i.expiry && i.lockinEnd);
  const sameEvent = both.filter((i) => i.expiry!.eventId && i.expiry!.eventId === i.lockinEnd!.eventId);
  const sameDate = both.filter((i) => i.expiry!.date === i.lockinEnd!.date);
  const events = await sql(`select event_type, date_basis, (calc_key is not null) calc, count(*)::int n from mudar.lease_event where workspace_id=$1 and archived_at is null group by 1,2,3 order by 1,2,3`, [a.ws]);
  const tasks = await sql(`select coalesce(source,'') source, split_part(idempotency_key, ':', 3) kind, status, count(*)::int n from mudar.task where workspace_id=$1 group by 1,2,3 order by 4 desc`, [a.ws]);
  const fmtFact = (f: any) => f ? { date: f.date, basis: f.basis, label: f.basisLabel, formula: f.formula ?? null, verified: f.verified } : null;
  const upcoming = items.filter((i) => i.nextKeyDate && i.nextKeyDate >= today).sort((x, y) => (x.nextKeyDate! < y.nextKeyDate! ? -1 : 1));
  const next10 = upcoming.slice(0, 10).map((i) => ({
    tenant: i.tenantName, building: i.assetName, areaSf: i.areaSf, nextKeyDate: i.nextKeyDate, status: i.status,
    expiry: fmtFact(i.expiry), lockinEnd: fmtFact(i.lockinEnd), notice: fmtFact(i.noticeDeadline),
    plan: i.plan ? { occupation: i.plan.occupation, basis: i.plan.occupationBasis, optionsStart: i.plan.optionsStart, decisionBy: i.plan.decisionBy, fitoutStart: i.plan.fitoutStart, moveBy: i.plan.moveBy, lastDecision: i.plan.lastDecision, viable: i.plan.viable } : null,
    callWindow: i.callWindow, issues: i.issues.slice(0, 3),
  }));
  const notices = items.filter((i) => i.noticeDeadline).sort((x, y) => (x.noticeDeadline!.date < y.noticeDeadline!.date ? -1 : 1)).slice(0, 10)
    .map((i) => ({ tenant: i.tenantName, building: i.assetName, notice: fmtFact(i.noticeDeadline) }));
  const statuses: Record<string, number> = {};
  for (const i of items) statuses[i.status] = (statuses[i.status] ?? 0) + 1;
  const windows: Record<string, number> = {};
  for (const i of items) if (i.callWindow) windows[i.callWindow.state] = (windows[i.callWindow.state] ?? 0) + 1;
  const reviewFlags = count((i) => i.reviewFlags.length > 0);
  const sampleLockinOnly = lockinOnly.slice(0, 3).map((i) => ({ tenant: i.tenantName, building: i.assetName, lockinEnd: fmtFact(i.lockinEnd), expiry: fmtFact(i.expiry), issues: i.issues }));
  const tasksAfter2 = await sql(`select count(*)::int n from mudar.task where workspace_id=$1`, [a.ws]);
  return {
    ms: Date.now() - t0, recalc1, recalc2, leases: items.length,
    withExpiry: count((i) => !!i.expiry), withLockinEnd: count((i) => !!i.lockinEnd), withNotice: count((i) => !!i.noticeDeadline),
    withBreaks: count((i) => i.breaks.length > 0), withPlan: count((i) => !!i.plan), withReviewFlags: reviewFlags,
    expiryBasis: basisCount((i) => i.expiry), lockinBasis: basisCount((i) => i.lockinEnd), statuses, callWindows: windows,
    lockinCheck: { lockinOnlyLeases: lockinOnly.length, lockinOnlyWithExpiry: lockinOnlyWithExpiry.length, bothDates: both.length, sameEventUsedForBoth: sameEvent.length, sameDateBoth: sameDate.length, sampleLockinOnly },
    eventsInDb: events, tasks, taskTotalAfterRerun: tasksAfter2[0].n, next10, notices,
    upcomingIn12m: upcoming.filter((i) => i.nextKeyDate! <= addMonths(today, 12)).length,
  };
}

function addMonths(d: string, m: number) {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCMonth(dt.getUTCMonth() + m);
  return dt.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ 2. scoring + plan + brief */

async function briefFlow(a: Args, today: string) {
  const { loadSettings, loadMemberAccess } = await import("../src/modules/brief/db");
  const { buildDailyPlan, loadCurrentScores } = await import("../src/modules/brief/plan");
  const { generateDailyBrief, noAiCaller, latestBrief } = await import("../src/modules/brief/brief-service");
  const c = { db: a.db, workspaceId: a.ws, userId: a.owner, tz: "Asia/Kolkata", access: null };
  const settings = await loadSettings(a.db, a.ws, a.owner);
  const scores = await loadCurrentScores(c as any);
  const tiers: Record<string, number> = {};
  for (const s of scores) tiers[s.tier] = (tiers[s.tier] ?? 0) + 1;
  const top = [...scores].sort((x, y) => Number(y.total) - Number(x.total)).slice(0, 5).map((s) => ({ name: s.name, total: Number(s.total), tier: s.tier, overrides: s.overrides, components: Object.fromEntries(Object.entries(s.components ?? {}).map(([k, v]: any) => [k, { points: v?.points ?? v?.score ?? v, why: v?.why ?? v?.reason ?? null }])) }));
  const now = new Date(`${today}T02:30:00.000Z`); // 08:00 IST
  const plan = await buildDailyPlan(c as any, settings, today, { now, reason: "real-data e2e" });
  const planTargets = plan.targets.slice(0, 5).map((t: any) => ({ name: t.name, total: t.total, tier: t.tier, why: t.why ?? t.reasons ?? null, displaced: t.displaced ?? null, action: t.action ?? null }));
  // 08:00 brief: deterministic fallback (no AI) — exactly what the 07:55 watchdog builds when AI is unavailable
  const gen = await generateDailyBrief(c as any, settings, { date: today, now, caller: noAiCaller, generatedBy: "real-data-e2e" });
  const again = await generateDailyBrief(c as any, settings, { date: today, now, caller: noAiCaller, generatedBy: "real-data-e2e" });
  const stored = await latestBrief(a.db, a.ws, a.owner, today);
  const content: any = gen.brief.content;
  writeFileSync(path.join(a.out, "brief-fallback.txt"), content.fallbackText ?? "");
  return {
    scored: scores.length, tiers, topScores: top,
    plan: { id: plan.id, mode: plan.mode, capacity: plan.capacity, targets: planTargets, displaced: plan.displaced.slice(0, 3), agendaTimeline: plan.agenda?.timeline?.length ?? null, agendaUnscheduled: plan.agenda?.unscheduled?.length ?? null, conflicts: plan.agenda?.conflicts?.length ?? null },
    brief: {
      created: gen.created, recreatedSameContent: again.created, synthesis: (gen.brief as any).synthesis_status ?? (stored as any)?.synthesis_status ?? null,
      sources: content.sources, staleSections: content.staleSections, deadlines: { count: content.deadlines?.items?.length, expiredNeedingConfirmation: content.deadlines?.expiredNeedingConfirmation, first5: content.deadlines?.items?.slice(0, 5) },
      replies: content.replies?.state, repliesNote: content.replies?.note, meetings: content.meetings?.state, actions: content.actions?.slice(0, 5), targets: content.targets?.slice(0, 5).map((t: any) => ({ name: t.name, total: t.total, why: t.why })),
      approvals: content.approvals, fallbackChars: (content.fallbackText ?? "").length,
    },
    accessCheck: await loadMemberAccess(a.admin, a.ws, a.owner).then((x) => !!x),
  };
}

/* ------------------------------------------------------------------ 3. market analyst */

async function marketFlow(a: Args) {
  const { marketComparables, runMarketAnalysis, marketOverview } = await import("../src/modules/intelligence/market/service");
  const txs = await sql(`select t.id, t.area_sf::float area, t.seats, t.period_start::text period_start, t.period_precision, t.deal_type, t.rent_min::float rmin, t.rent_max::float rmax, t.asset_id,
      t.extras->>'layout' layout, t.extras->>'corridor_a' ca, t.extras->>'corridor_b' cb, t.extras->>'locality_raw' loc, t.extras->>'ern' ern, t.extras->>'absorption_type' abs, s.file_name
    from mudar.market_transaction t join mudar.source_object s on s.id=t.source_object_id where t.workspace_id=$1 and t.archived_at is null`, [a.ws]);
  const year = (t: any) => (t.period_start ? String(t.period_start).slice(0, 4) : "unknown");
  const sumBy = (rows: any[], key: (t: any) => string) => {
    const m: Record<string, { sf: number; n: number }> = {};
    for (const t of rows) { const k = key(t) || "(blank)"; m[k] ??= { sf: 0, n: 0 }; m[k].sf += t.area ?? 0; m[k].n++; }
    return Object.fromEntries(Object.entries(m).sort((x, y) => y[1].sf - x[1].sf));
  };
  const conv = txs.filter((t: any) => t.layout === "conventional");
  const cw = txs.filter((t: any) => t.layout === "coworking");
  const conv22 = conv.filter((t: any) => t.file_name.startsWith("da47"));
  const conv23 = conv.filter((t: any) => t.file_name.startsWith("95fe"));
  const comps: Record<string, unknown> = {};
  for (const loc of ["Kharadi", "Viman Nagar", "Baner", "Hinjewadi"]) {
    const r = await marketComparables(a.db, a.ws, { locality: loc });
    comps[loc] = { n: r.rows.length, stats: r.stats, sample: r.rows.slice(0, 4).map((x: any) => ({ tenant: x.tenant, building: x.asset_name, period: x.period_start, sf: x.area_sf, rent: [x.rent_min, x.rent_max] })) };
  }
  const allComps = await marketComparables(a.db, a.ws, {});
  const kharadiRaw = conv.filter((t: any) => (t.loc ?? "").toLowerCase() === "kharadi");
  const analysis = await runMarketAnalysis(a.db, a.ws, { trigger: "manual", ownerUserId: a.owner }).catch((e: Error) => ({ error: e.message }));
  const overview = await marketOverview(a.db, a.ws).catch((e: Error) => ({ error: e.message }));
  return {
    transactions: { total: txs.length, conventional: conv.length, coworking: cw.length, linkedToAsset: txs.filter((t: any) => t.asset_id).length },
    byYear: sumBy(conv, (t) => `${t.file_name.slice(0, 4)}:${year(t)}`),
    conv2022: { byCorridorB: sumBy(conv22, (t) => t.cb), byCorridorA: sumBy(conv22, (t) => t.ca), byErn: sumBy(conv22, (t) => t.ern), total: conv22.reduce((s: number, t: any) => s + (t.area ?? 0), 0), n: conv22.length },
    conv2023: { byCorridorB: sumBy(conv23, (t) => t.cb), byCorridorA: sumBy(conv23, (t) => t.ca), byQuarterYear: sumBy(conv23, (t) => year(t)), topLocalities: Object.fromEntries(Object.entries(sumBy(conv23, (t) => t.loc)).slice(0, 8)), total: conv23.reduce((s: number, t: any) => s + (t.area ?? 0), 0), n: conv23.length },
    coworkingSeats: { y2022: cw.filter((t: any) => t.file_name.startsWith("da47")).reduce((s: number, t: any) => s + (t.seats ?? 0), 0), y2023: cw.filter((t: any) => t.file_name.startsWith("95fe")).reduce((s: number, t: any) => s + (t.seats ?? 0), 0) },
    comparables: comps, comparablesAll: { n: allComps.rows.length, stats: allComps.stats, localitiesKnown: allComps.localities.length },
    kharadiRawLabelDeals: kharadiRaw.length,
    analysis, overview: overview && typeof overview === "object" ? Object.fromEntries(Object.entries(overview).map(([k, v]) => [k, Array.isArray(v) ? v.length : v])) : overview,
  };
}

/* ------------------------------------------------------------------ 4/5/6. requirement, shortlist, finance, documents */

// Commercial terms as printed in the comparative workbook (5 YEAR Commercial Comparative, rows 6-21). Locations are NOT stated there.
const OPTIONS = [
  { name: "ITPP", floor: "4th floor, Wing 1", carpet: 37500, builtUp: 50000, rent: 120, cam: 18, p4: 16 / 3, p2: null as number | null, capex: 3500, capexM: 83, opex: 69, mgmt: 14, wbYear1Seat: 11600.000000000005 },
  { name: "aVance II", floor: "6th floor", carpet: 37803.75, builtUp: 50405, rent: 268 / 3, cam: 18, p4: 5.290480441755117, p2: null, capex: 3500, capexM: 83, opex: 69, mgmt: 14, wbYear1Seat: 10533.024999999996 },
  { name: "Global Business City (Maple)", floor: "3rd floor - Tower 3", carpet: 38980.5, builtUp: 51974, rent: 120, cam: 18.53333333333333, p4: 5.233385923731096, p2: 5.233385923731096, capex: 3500, capexM: 83, opex: 69, mgmt: 14, wbYear1Seat: 12278.861599999993 },
  { name: "EON West", floor: "Multiple floor", carpet: 37500, builtUp: 50000, rent: 100, cam: 19, p4: 8, p2: 6.933333333333334, capex: 3500, capexM: 83, opex: 69, mgmt: 14, wbYear1Seat: 11247.500000000002 },
  { name: "Infinity IT Park", floor: "Multiple floor", carpet: 35000, builtUp: 50000, rent: 127.14285714285714, cam: 22.142857142857142, p4: 3.857142857142857, p2: 0.9642857142857143, capex: 3500, capexM: 83, opex: 69, mgmt: 14, wbYear1Seat: 11203.749999999993 },
];
const SEATS = 1000;

function financeInput(o: (typeof OPTIONS)[number]) {
  const yr = (y: number) => ({ fromPeriod: (y - 1) * 12 + 1, toPeriod: y * 12, f: 1.05 ** (y - 1) });
  const escalating = (label: string, perSf: number, category: string) =>
    [1, 2, 3, 4, 5].map((y) => ({ label: `${label} Y${y}`, monthly: (perSf * o.carpet * yr(y).f).toFixed(2), fromPeriod: yr(y).fromPeriod, toPeriod: yr(y).toPeriod, category }));
  return {
    name: `${o.name} — 5-yr lock-in (comparative 12.12.2024)`, kind: "conventional" as const, baseDate: "2026-11-01", horizonMonths: 60, annualDiscountRatePct: 12,
    area: { carpetSf: o.carpet, chargeableSf: o.builtUp, plannedSeats: SEATS }, tenureMonths: 60,
    rent: { basis: "carpet" as const, rate: o.rent.toFixed(6), escalation: { pct: 5, everyMonths: 12 } },
    cam: { mode: "per_sf" as const, ratePerSf: o.cam.toFixed(6), basis: "carpet" as const, escalation: { pct: 5, everyMonths: 12 } },
    // parking is quoted per SF of carpet, not per slot: modelled as ONE lump "slot" = monthly amount (4W + 2W where stated), 5%/yr
    parking: { slots: 1, ratePerSlot: ((o.p4 + (o.p2 ?? 0)) * o.carpet).toFixed(2), escalation: { pct: 5, everyMonths: 12 } },
    recurring: [...escalating("Opex", o.opex, "opex"), ...escalating("Management fee", o.mgmt, "opex")],
    capex: { fitoutCost: (o.capex * o.carpet).toFixed(2), spendPeriod: 0 },
    // not stated in the workbook => unknown (never zero): deposit, reinstatement, GST treatment. 2W parking "NA" (ITPP, aVance II)
    // cannot be expressed: the engine models parking as one item (known/none/unknown) — reported as a limitation.
    costStates: { rent: "known", cam: "known", parking: "known", deposit: "unknown", fitout: "known", opex: "known", reinstatement: "unknown" } as any,
    assumptionSources: { rent: "comparative workbook 12.12.2024 row 11", cam: "row 12", parking: "rows 13-14", fitout: "row 15 (₹3,500/SF carpet)", opex: "rows 17-18", escalation: "note 5: 5% every year" },
  };
}

async function dealsFlow(a: Args, today: string) {
  const { createRequirement, resolveGeographies, getRequirementDetail } = await import("../src/modules/deals/requirements/service");
  const { runShortlist } = await import("../src/modules/deals/matching/service");
  const { evaluateScenario, compare } = await import("../src/modules/deals/finance/service");
  const { generateDocument, downloadDocument } = await import("../src/modules/deals/documents/service");
  const ctx = { db: a.db, workspaceId: a.ws, userId: a.owner, role: "owner" as const };

  // --- test spaces from the comparative workbook (the six real files contain no availability). Locations unknown => left blank.
  const created: any[] = [];
  for (const o of OPTIONS) {
    const assetId = detUuid(`${a.ws}|e2e-asset|${o.name}`);
    const spaceId = detUuid(`${a.ws}|e2e-space|${o.name}`);
    const availId = detUuid(`${a.ws}|e2e-avail|${o.name}`);
    const ra = await a.db.from("asset").upsert({ id: assetId, workspace_id: a.ws, owner_user_id: a.owner, classification: "corporate_confidential", name: `${o.name} (comparative option)`, asset_kind: "building", status: null }, { onConflict: "id", ignoreDuplicates: true });
    if (ra.error) throw ra.error;
    const rs = await a.db.from("space").upsert({ id: spaceId, workspace_id: a.ws, owner_user_id: a.owner, classification: "corporate_confidential", asset_id: assetId, floor_text: o.floor, carpet_sf: o.carpet, chargeable_sf: o.builtUp, efficiency: Number((o.carpet / o.builtUp).toFixed(4)), seats: SEATS }, { onConflict: "id", ignoreDuplicates: true });
    if (rs.error) throw rs.error;
    const rv = await a.db.from("availability").upsert({ id: availId, workspace_id: a.ws, owner_user_id: a.owner, classification: "corporate_confidential", space_id: spaceId, as_of: "2024-12-12", status: "unverified", available_from: null, asking_rent_min: Number(o.rent.toFixed(2)), asking_rent_max: Number(o.rent.toFixed(2)), rent_basis: "carpet", fitout_basis: "warm_shell", fact_status: "reported" }, { onConflict: "id", ignoreDuplicates: true });
    if (rv.error) throw rv.error;
    created.push({ option: o.name, assetId, spaceId });
  }

  // --- requirement (estimates, not client-confirmed)
  const title = "Real-data test: ~37,500 sf carpet, SBD East (Kharadi / Viman Nagar)";
  let { data: req } = await a.db.from("requirement").select("*").eq("workspace_id", a.ws).eq("title", title).maybeSingle();
  const geos = await resolveGeographies(ctx, ["Kharadi", "Viman Nagar"]);
  if (!req) {
    req = await createRequirement(ctx, {
      orgName: "Real-data test occupier", title,
      changes: [
        { key: "objective", value: "relocation", status: "estimated" },
        { key: "area", value: [35000, 37500, 40000], status: "estimated" },
        { key: "area_basis", value: "carpet", status: "estimated" },
        { key: "seats", value: [900, 1000, 1100], status: "estimated" },
        { key: "occupation_date", value: addMonths(today, 12), status: "estimated" },
        { key: "budget", value: [null, 95], status: "estimated" },
        { key: "budget_basis", value: "per_sf_month", status: "estimated" },
        { key: "preferred_locations", value: geos, status: "estimated" },
        { key: "tenure_months", value: 60, status: "estimated" },
        { key: "lockin_months", value: 60, status: "estimated" },
      ],
    });
  }
  const reqId = (req as any).id as string;
  const detail: any = await getRequirementDetail(ctx, reqId);
  const sl = await runShortlist(ctx, reqId, { asOf: today, note: "real-data e2e" });
  const shortlist = sl.results.map((r: any) => ({
    rank: r.rank, asset: created.find((c) => c.spaceId === r.spaceId)?.option ?? r.assetId, eligibility: r.eligibility, label: r.label,
    fit: r.fitScore, completeness: r.completenessScore, disqualifiers: r.disqualifiers, verification: (r.verification ?? []).map((v: any) => v.text ?? v), qualifies: (r.qualifies ?? []).slice(0, 4), flags: r.flags,
    criteria: r.criteria, area: r.area, allInCostPerUnit: r.allInCostPerUnit,
  }));

  // --- finance: one scenario per comparative option (saved, linked to the requirement)
  const fin: any[] = [];
  const inputs = OPTIONS.map(financeInput);
  for (let i = 0; i < OPTIONS.length; i++) {
    const o = OPTIONS[i];
    const r: any = await evaluateScenario(ctx, { input: inputs[i] as any, requirementId: reqId, save: true });
    const p1 = r.result.cashflows.filter((c: any) => c.period === 1).reduce((s: number, c: any) => s + Number(c.amount), 0);
    const y1 = r.result.cashflows.filter((c: any) => c.period >= 1 && c.period <= 12).reduce((s: number, c: any) => s + Number(c.amount), 0) / 12;
    const wbExCapex = o.wbYear1Seat - (o.capexM * o.carpet) / SEATS;
    fin.push({
      option: o.name, scenarioId: r.scenarioId, complete: r.result.complete, gaps: r.result.gaps.map((g: any) => g.label), totalsLabel: r.result.totalsLabel, warnings: r.result.warnings,
      npv: r.result.totals.npv, nominalTco: r.result.totals.nominalTco, equivalentMonthly: r.result.totals.equivalentMonthly, perSeatMonth: r.result.totals.perPlannedSeatMonth, perCarpetSfMonth: r.result.totals.perCarpetSfMonth,
      appMonth1PerSeat: +(p1 / SEATS).toFixed(2), appYear1AvgPerSeatExCapex: +(y1 / SEATS).toFixed(2),
      workbookYear1PerSeat: +o.wbYear1Seat.toFixed(2), workbookYear1PerSeatExCapex: +wbExCapex.toFixed(2), workbookCapexPerSeat: +((o.capexM * o.carpet) / SEATS).toFixed(2),
      capexStraight60PerSeat: +((o.capex * o.carpet) / 60 / SEATS).toFixed(2),
    });
  }
  const cmp: any = compare(inputs as any);

  // --- design studio: shortlist deck + proposal
  const docs: any[] = [];
  for (const purpose of ["shortlist_deck", "proposal"] as const) {
    try {
      const g: any = await generateDocument(ctx, { purpose, requirementId: reqId, scenarioIds: fin.map((f) => f.scenarioId).filter(Boolean), preparedFor: "Real-data test occupier" });
      const docId = g.id ?? g.document?.id ?? g.documentId;
      const dl = await downloadDocument(ctx, docId);
      const file = path.join(a.out, dl.fileName.replace(/[^\w.\-]+/g, "_"));
      writeFileSync(file, dl.buffer);
      docs.push({ purpose, docId, file, bytes: dl.buffer.length, sha256: dl.sha256, warnings: g.warnings ?? null, status: g.status ?? g.document?.status ?? null, check: checkOffice(file) });
    } catch (e) {
      docs.push({ purpose, error: (e as Error).message });
    }
  }
  return {
    requirement: { id: reqId, status: (req as any).status, geos, completeness: detail?.completeness ?? null, missing: (detail?.missing ?? detail?.missingQuestions ?? []).length },
    shortlist: { version: sl.version, warnings: sl.warnings, total: sl.results.length, eligible: sl.results.filter((r: any) => r.eligibility === "eligible").length, needsVerification: sl.results.filter((r: any) => r.eligibility === "needs_verification").length, ineligible: sl.results.filter((r: any) => r.eligibility === "ineligible").length, options: shortlist },
    finance: fin, comparison: cmp?.error ?? { ranking: cmp?.ranking ?? cmp?.rows?.map((r: any) => ({ name: r.name, npv: r.npv })) ?? null, warnings: cmp?.warnings ?? null },
    documents: docs,
  };
}

function checkOffice(file: string): unknown {
  try {
    const listing = execFileSync("unzip", ["-tq", file], { encoding: "utf8" }).trim();
    let detail = "";
    if (file.endsWith(".pptx")) detail = execFileSync("python3", ["-I", "-c", "import sys; from pptx import Presentation; p=Presentation(sys.argv[1]); print(len(p.slides),'slides;', ' | '.join((s.shapes.title.text if s.shapes.title is not None else '?') for s in p.slides)[:600])", file], { encoding: "utf8" }).trim();
    if (file.endsWith(".docx")) detail = execFileSync("python3", ["-I", "-c", "import sys; from docx import Document; d=Document(sys.argv[1]); print(len(d.paragraphs),'paragraphs;', len(d.tables),'tables;', ' | '.join(p.text for p in d.paragraphs if p.style.name.startswith('Heading'))[:600])", file], { encoding: "utf8" }).trim();
    return { unzip: listing, detail };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 400) };
  }
}

/* ------------------------------------------------------------------ 7. steward + 8. search */

async function stewardFlow(a: Args) {
  const { runStaleDetector, listConflicts, listStale } = await import("../src/modules/changes/steward");
  const r1 = await runStaleDetector(a.admin, a.ws);
  // freshness counts from record creation/import, so freshly imported records are not stale today: simulate the same
  // workspace 200 days later (org/person window 180 d), then run again today (records return to fresh)
  const future = new Date(Date.now() + 200 * 86_400_000);
  const rFuture = await runStaleDetector(a.admin, a.ws, { now: future });
  const futureByType = await sql(`select entity_type, count(*)::int n from mudar.record_freshness where workspace_id=$1 and status='stale' group by 1`, [a.ws]);
  const r2 = await runStaleDetector(a.admin, a.ws);
  const conflicts = await listConflicts(a.db, a.ws, { status: "open", limit: 500 });
  const stale = await listStale(a.db, a.ws, 500);
  const byType: Record<string, number> = {};
  for (const s of stale as any[]) byType[s.entity_type] = (byType[s.entity_type] ?? 0) + 1;
  return {
    run1: r1, runPlus200Days: rFuture, staleByTypePlus200Days: futureByType, run2: r2, staleByType: byType,
    conflicts: { open: conflicts.length, sample: (conflicts as any[]).slice(0, 20).map((c) => ({ entity: c.entity_type, label: c.label ?? c.entity_label ?? null, field: c.field, master: c.master_value, source: c.source_value, locator: c.source_locator, material: c.material, proposal: c.change_proposal_id ?? null })) },
  };
}

async function searchFlow(a: Args) {
  const { searchEntities } = await import("../src/modules/admin/search");
  const out: Record<string, unknown> = {};
  for (const q of ["Panchshil", "Kharadi", "Mastercard", "Eon Free Zone", "Syneos"]) {
    const hits = await searchEntities(a.db, a.ws, { q, limit: 15 } as any);
    const byType: Record<string, number> = {};
    for (const h of hits) byType[h.entity_type] = (byType[h.entity_type] ?? 0) + 1;
    out[q] = { n: hits.length, byType, top: hits.slice(0, 6).map((h) => ({ type: h.entity_type, title: h.title, subtitle: h.subtitle, score: h.score })) };
  }
  return out;
}

/* ------------------------------------------------------------------ entry */

export async function runWorkflows(a: Args) {
  const { localDate } = await import("../src/lib/util/time");
  const today = localDate(new Date(), "Asia/Kolkata");
  const res: Record<string, unknown> = { today };
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    try {
      res[name] = await fn();
      a.log(`workflow ${name} ok (${Date.now() - t0} ms)`);
    } catch (e) {
      res[name] = { error: (e as Error).message, stack: (e as Error).stack?.split("\n").slice(0, 6) };
      a.log(`workflow ${name} FAILED: ${(e as Error).message}`);
    }
    writeFileSync(path.join(a.out, "workflows.partial.json"), JSON.stringify(res, null, 2));
  };
  await step("radar", () => leaseRadar(a, today));
  await step("brief", () => briefFlow(a, today));
  await step("market", () => marketFlow(a));
  await step("deals", () => dealsFlow(a, today));
  await step("steward", () => stewardFlow(a));
  await step("search", () => searchFlow(a));
  void readFileSync;
  return res;
}

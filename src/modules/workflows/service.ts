import "server-only";
import type { Db } from "@/lib/supabase/server";
import type { callStructured } from "@/lib/ai/gateway";
import { classifyRisk, proposeChange, type PatchOp } from "@/lib/services/changes";
import { localDate, edate } from "@/lib/util/time";
import { resolveOrg, actOnSignal } from "@/modules/signals/service";
import { recalcOrg } from "@/modules/scoring/service";
import { discoverCompany } from "@/modules/contacts/service";
import { createOutreach, OutreachError } from "@/modules/outreach/service";
import { scenarioFor, type Scenario, type Channel } from "@/modules/outreach/rules";
import { runShortlist } from "@/modules/deals/matching/service";
import { compareRenewalRelocation, RVR_VERSION, type RvrInput } from "@/modules/toolkit/calc/renewal";
import { saveAnalysis } from "@/modules/toolkit/store";
import { Run, refId, type Ref, type StepResult } from "./runner";
import * as R from "./rules";
import { sweepEvents } from "./events";

/**
 * Module 9 — workflow orchestrator. Chains existing module services; it owns no business logic of its own beyond
 * the gating rules in rules.ts. Every chain is a workflow_run with one workflow_step per step (status + reason +
 * output refs). Nothing is ever sent (S3): outreach stops at a draft awaiting human approval. Requirement creation is
 * material (changes.ts) so it goes to the approval queue; the run waits and resumes after approval.
 * Called from jobs with a service-role client: every query filters workspace_id explicitly (S2).
 */
type Row = Record<string, any>;
type Ai = typeof callStructured;
export interface ChainOpts { ai?: Ai; today?: string }
const daysAgoIso = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

// ------------------------------------------------------------------ settings

export async function getSettings(db: Db, ws: string): Promise<R.WorkflowSettings> {
  const { data } = await db.from("workspace_setting").select("value").eq("workspace_id", ws).eq("key", "workflows").maybeSingle();
  return R.parseSettings(data?.value);
}
export async function setSettings(db: Db, ws: string, s: Partial<R.WorkflowSettings>) {
  const next = { ...(await getSettings(db, ws)), ...s };
  const { error } = await db.from("workspace_setting").upsert({ workspace_id: ws, key: "workflows", value: next }, { onConflict: "workspace_id,key" });
  if (error) throw new Error(error.message);
  return next;
}

export async function workspaceOwner(db: Db, ws: string): Promise<string | null> {
  const { data } = await db.from("membership").select("user_id, role").eq("workspace_id", ws).in("role", ["owner", "admin"]).order("role", { ascending: false }).limit(1).maybeSingle();
  return data?.user_id ?? null;
}

// ------------------------------------------------------------------ shared steps

async function decisionMakers(db: Db, ws: string, orgId: string): Promise<Row[]> {
  const { data: emp } = await db.from("employment").select("person_id, title").eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).is("archived_at", null).limit(200);
  const ids = [...new Set((emp ?? []).map((e) => e.person_id as string))];
  if (!ids.length) return [];
  const { data: ra } = await db.from("contact_role_assessment").select("person_id, role_class").eq("workspace_id", ws).eq("active", true).in("person_id", ids).in("role_class", R.DECISION_ROLES);
  const dm = new Set((ra ?? []).map((r) => r.person_id as string));
  if (!dm.size) return [];
  const { data: people } = await db.from("person").select("id, full_name, do_not_contact, contact_method(method_type, value, verify_status, suppressed)").eq("workspace_id", ws).in("id", [...dm]).is("archived_at", null);
  return people ?? [];
}

async function discoveryStep(db: Db, ws: string, actor: string, orgId: string, ai?: Ai): Promise<StepResult> {
  const dms = await decisionMakers(db, ws, orgId);
  if (dms.length >= R.MIN_DECISION_MAKERS) return { status: "skipped", reason: `${dms.length} current decision-makers with roles already on record (need fewer than ${R.MIN_DECISION_MAKERS} to research).` };
  const { data: recent } = await db.from("enrichment_job").select("id, status, created_at").eq("workspace_id", ws).eq("org_id", orgId).eq("kind", "company_discovery")
    .gte("created_at", daysAgoIso(R.DISCOVERY_COOLDOWN_DAYS)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (recent) return { status: "skipped", reason: `Contact research already ran on ${String(recent.created_at).slice(0, 10)} (once per ${R.DISCOVERY_COOLDOWN_DAYS} days).`, refs: [{ type: "enrichment_job", id: recent.id }] };
  const r = await discoverCompany(db, ws, orgId, { userId: actor, ai });
  const refs: Ref[] = [{ type: "enrichment_job", id: r.jobId }];
  if ("mocked" in r && r.mocked) return { status: "done", reason: `Only ${dms.length} decision-maker(s) on record; research job created but web search is off (no AI key) — nothing found.`, refs };
  if ("reused" in r && r.reused) return { status: "skipped", reason: "Contact research already ran today.", refs };
  return { status: "done", reason: `Only ${dms.length} decision-maker(s) on record; research found ${"found" in r ? r.found : 0} candidate(s) for review in Contacts.`, refs };
}

export async function scoreStep(db: Db, ws: string, orgId: string): Promise<StepResult> {
  await recalcOrg(db, ws, orgId, "workflow");
  const { data: lead } = await db.from("score_result").select("id, score, band").eq("workspace_id", ws).eq("model_key", "lead").eq("entity_id", orgId).eq("is_current", true).maybeSingle();
  return { status: "done", reason: lead ? `Scores recalculated. Lead priority ${lead.score} (${lead.band}).` : "Scores recalculated; no lead score (lead model off or not applicable).", refs: lead ? [{ type: "score_result", id: lead.id, label: `${lead.band}` }] : [] };
}

/** One outreach draft, only if every gate passes. Draft only — a person approves and sends. */
async function outreachStep(db: Db, ws: string, actor: string, orgId: string, o: { scenario: Scenario; signalId?: string | null; ai?: Ai }): Promise<StepResult> {
  const { data: lead } = await db.from("score_result").select("score, band").eq("workspace_id", ws).eq("model_key", "lead").eq("entity_id", orgId).eq("is_current", true).maybeSingle();
  if (!lead) return { status: "skipped", reason: "No current lead score for this company." };
  if (!R.isHighLead(lead.band)) return { status: "skipped", reason: `Lead priority is ${lead.band} (${lead.score}); drafts are prepared only for ${R.HIGH_LEAD_BANDS.join(" / ")}.` };
  const { data: recent } = await db.from("outreach_item").select("id, created_at").eq("workspace_id", ws).eq("org_id", orgId).gte("created_at", daysAgoIso(R.OUTREACH_QUIET_DAYS)).limit(1).maybeSingle();
  if (recent) return { status: "skipped", reason: `Outreach to this company already prepared on ${String(recent.created_at).slice(0, 10)} (quiet period ${R.OUTREACH_QUIET_DAYS} days).`, refs: [{ type: "outreach_item", id: recent.id }] };
  const dms = await decisionMakers(db, ws, orgId);
  if (!dms.length) return { status: "skipped", reason: "No decision-maker on record for this company." };
  const reachable = dms.filter((p) => !p.do_not_contact);
  if (!reachable.length) return { status: "skipped", reason: "Every decision-maker is marked do-not-contact." };
  const pickChannel = (p: Row): Channel | null => {
    const ok = ((p.contact_method ?? []) as Row[]).filter((m) => !m.suppressed && R.USABLE_CHANNEL.includes(m.verify_status));
    if (ok.some((m) => m.method_type === "email")) return "email";
    if (ok.some((m) => m.method_type === "phone")) return "whatsapp";
    if (ok.some((m) => m.method_type === "linkedin" || m.method_type === "profile")) return "linkedin";
    return null;
  };
  const target = reachable.map((p) => ({ p, ch: pickChannel(p) })).find((x) => x.ch);
  if (!target) return { status: "skipped", reason: "No decision-maker has a verified or likely-valid channel that is not suppressed." };
  try {
    const r = await createOutreach(db, ws, actor, { personId: target.p.id, channels: [target.ch!], scenario: o.scenario, signalId: o.signalId ?? null, ai: o.ai });
    return { status: "done", reason: `One ${target.ch} draft prepared for ${target.p.full_name} (${o.scenario.replace(/_/g, " ")}) — awaiting your approval; nothing was sent.`, refs: r.ids.map((id) => ({ type: "outreach_item", id, label: target.p.full_name })) };
  } catch (e) {
    if (e instanceof OutreachError) return { status: "skipped", reason: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------ chain 1: signal → action

const SIG_STEPS = [["company", "Match company"], ["contacts", "Find decision-makers"], ["scores", "Recalculate scores"], ["outreach", "Prepare outreach draft"]] as const;

export async function runSignalChain(db: Db, ws: string, signalId: string, opts: ChainOpts = {}) {
  const { data: sig } = await db.from("signal").select("id, org_id, entity_name_raw, title, category, kind, verification, confidence, status, owner_user_id, assigned_user_id").eq("workspace_id", ws).eq("id", signalId).maybeSingle();
  if (!sig) return null;
  const strength = R.signalStrength(sig);
  const actor = sig.assigned_user_id ?? sig.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "signal_chain", subjectType: "signal", subjectId: sig.id, orgId: sig.org_id, dedupeKey: R.signalDedupeKey(sig.id, strength.strong), actor });
  if (!run) return null;

  const a = await run.step("company", SIG_STEPS[0][1], async () => {
    if (sig.org_id) return { status: "done", reason: "Signal already linked to a company.", refs: [{ type: "organisation", id: sig.org_id }] };
    if (!sig.entity_name_raw) return { status: "skipped", reason: "Signal names no company." };
    const res = await resolveOrg(db, ws, sig.entity_name_raw);
    if (!res.orgId) return { status: "skipped", reason: `No exact company match for "${sig.entity_name_raw}" (${res.method}${res.candidates.length ? `; candidates: ${res.candidates.map((c) => c.name).join(", ")}` : ""}) — link it on the signal.` };
    await actOnSignal(db, ws, actor, sig.id, "correct_company", { org_id: res.orgId });
    return { status: "done", reason: `Linked to company by ${res.method} name match.`, refs: [{ type: "organisation", id: res.orgId }] };
  });
  const orgId = refId(a, "organisation");
  if (!orgId) {
    for (const [k, l] of SIG_STEPS.slice(1)) await run.skip(k, l, "No company matched.");
    return run.finish("skipped", a.reason);
  }
  if (!sig.org_id) await db.from("workflow_run").update({ org_id: orgId }).eq("workspace_id", ws).eq("id", run.id);
  const b = await run.step("contacts", SIG_STEPS[1][1], () => discoveryStep(db, ws, actor, orgId, opts.ai));
  const c = await run.step("scores", SIG_STEPS[2][1], () => scoreStep(db, ws, orgId));
  const d = await run.step("outreach", SIG_STEPS[3][1], async () => {
    if (!strength.strong) return { status: "skipped", reason: strength.reason };
    if (c.status === "failed") return { status: "skipped", reason: "Scores could not be recalculated." };
    return outreachStep(db, ws, actor, orgId, { scenario: scenarioFor(sig), signalId: sig.id, ai: opts.ai });
  });
  const failed = [a, b, c, d].some((s) => s.status === "failed");
  return run.finish(failed ? "failed" : "done", d.status === "done" ? d.reason : `No draft: ${d.reason}`);
}

// ------------------------------------------------------------------ chain 2: lease → renewal / relocation

const LEASE_STEPS = [["requirement", "Renewal/relocation requirement"], ["shortlist", "Match alternatives"], ["analysis", "Renewal vs relocation"], ["task", "Task for owner"], ["outreach", "Prepare outreach draft"]] as const;

async function adjacentMarkets(db: Db, ws: string, mmId: string | null): Promise<string[]> {
  if (!mmId) return [];
  const { data: mm } = await db.from("geography").select("id, parent_id, level").eq("workspace_id", ws).eq("id", mmId).maybeSingle();
  if (!mm) return [];
  if (!mm.parent_id) return [mm.id];
  const { data: sib } = await db.from("geography").select("id").eq("workspace_id", ws).eq("parent_id", mm.parent_id).eq("level", mm.level).is("archived_at", null).limit(20);
  return [mm.id, ...(sib ?? []).map((s) => s.id as string).filter((id) => id !== mm.id)];
}

async function requirementStep(db: Db, ws: string, actor: string, lease: Row, org: Row): Promise<StepResult> {
  const title = R.requirementTitle(org.display_name);
  const { data: existing } = await db.from("requirement").select("id, status").eq("workspace_id", ws).eq("org_id", org.id).eq("title", title).neq("status", "closed").is("archived_at", null).limit(1).maybeSingle();
  if (existing) return { status: "done", reason: "Existing renewal/relocation requirement reused.", refs: [{ type: "requirement", id: existing.id }] };
  const markets = await adjacentMarkets(db, ws, lease.asset?.micro_market_id ?? null);
  const known = (v: unknown) => v !== null && v !== undefined;
  const patch: PatchOp[] = [
    { op: "add", path: "/org_id", value: org.id }, { op: "add", path: "/title", value: title }, { op: "add", path: "/objective", value: "renewal" },
    { op: "add", path: "/transaction_kinds", value: ["renewal", "relocation"] },
    { op: "add", path: "/status", value: "estimated" },
    ...(known(lease.area_sf) ? [{ op: "add" as const, path: "/area_target_sf", value: Number(lease.area_sf) }] : []),
    ...(known(lease.area_basis) ? [{ op: "add" as const, path: "/area_basis", value: lease.area_basis }] : []),
    ...(markets.length ? [{ op: "add" as const, path: "/preferred_geography_ids", value: markets }] : []),
    { op: "add", path: "/constraints", value: {
      field_status: { ...(known(lease.area_sf) ? { area_target_sf: "reported" } : {}), ...(markets.length ? { preferred_geography_ids: "reported" } : {}) },
      values: { current_lease_id: lease.id, current_asset_id: lease.asset_id ?? null, current_building: lease.asset?.name ?? null, current_lease_expiry: lease.contractual_expiry ?? null },
    } },
  ];
  const risk = classifyRisk("requirement", "create", patch);
  if (risk === "routine_internal") throw new Error("Requirement creation is expected to be material; refusing to write directly.");
  const p = await proposeChange(db, ws, {
    targetType: "requirement", operation: "create", patch, proposedByKind: "job", actorUserId: actor, ownerUserId: actor,
    reason: `Lease for ${org.display_name}${lease.asset?.name ? ` at ${lease.asset.name}` : ""} enters its renewal window (expiry ${lease.contractual_expiry ?? "unknown"}). Prefilled from the lease; seats, budget and dates are unknown.`,
    idempotencyKey: `workflows:lease:${lease.id}:requirement`,
  });
  if (p.state === "applied" && p.target_id) return { status: "done", reason: "Requirement created from the lease.", refs: [{ type: "requirement", id: p.target_id }, { type: "change_proposal", id: p.id }] };
  if (["rejected", "expired", "reversed"].includes(p.state)) return { status: "skipped", reason: `Requirement proposal was ${p.state}.`, refs: [{ type: "change_proposal", id: p.id }] };
  return { status: "waiting_approval", reason: `Requirement proposed (${risk.replace(/_/g, " ")}) — approve it in Approvals and the chain continues.`, refs: [{ type: "change_proposal", id: p.id }] };
}

async function analysisStep(db: Db, ws: string, actor: string, lease: Row, org: Row, reqId: string, shortlist: StepResult): Promise<StepResult> {
  const current = R.monthlyRent(lease.rent_per_sf, lease.area_sf);
  if (!current) return { status: "skipped", reason: `Current rent unknown (${lease.rent_per_sf == null ? "rent per sq ft" : "area"} missing on the lease) — no comparison.` };
  const avIds = (shortlist.refs ?? []).filter((r) => r.type === "availability").map((r) => r.id);
  const { data: avs } = avIds.length ? await db.from("availability").select("id, asking_rent_min, asking_rent_max, rent_basis, space:space_id(asset:asset_id(name))").eq("workspace_id", ws).in("id", avIds) : { data: [] as Row[] };
  const byId = new Map((avs ?? []).map((a: Row) => [a.id, a]));
  const alt = avIds.map((id) => byId.get(id)).find((a) => a && a.asking_rent_min != null && a.rent_basis !== "seat" && a.space?.asset?.name !== lease.asset?.name);
  if (!alt) return { status: "skipped", reason: "No alternative with an asking rent per sq ft in the shortlist." };
  const newRent = R.monthlyRent(alt.asking_rent_min, lease.area_sf)!;
  const assumptions = [
    `Renewal rent = current rent (${lease.rent_per_sf}/sq ft × ${lease.area_sf} sq ft); no proposed renewal rent on record.`,
    `Relocation rent = lower asking rent at ${alt.space?.asset?.name ?? "alternative"} (${alt.asking_rent_min}/sq ft${alt.rent_basis ? `, ${alt.rent_basis}` : ""}) × same area as today.`,
    lease.rent_basis && alt.rent_basis && lease.rent_basis !== alt.rent_basis ? `Rent bases differ (lease ${lease.rent_basis}, alternative ${alt.rent_basis}) — not normalised.` : "Rent bases assumed comparable.",
    "Comparison period 60 months and 0% discount rate (undiscounted) — workflow defaults, change in the toolkit.",
    "All other costs (CAM, fit-out, moving, deposits, rent-free, escalation) unknown — listed as missing, not zero.",
  ];
  const inputs: RvrInput = {
    comparisonMonths: 60, discountRatePct: 0,
    renewal: { currentRentMonthly: current, proposedRentMonthly: current, extensionMonths: null, rentFreeMonths: null, camMonthly: null, depositChange: null, refurbishment: null, maintenanceMonthly: null, otherMonthly: null, otherOneOff: null },
    relocation: { newRentMonthly: newRent, rentFreeMonths: null, camMonthly: null, deposit: null, fitout: null, moving: null, restorationOld: null, overlapMonths: null, brokerage: null, itRelocation: null, downtimeCost: null, employeeTransition: null, otherMonthly: null, otherOneOff: null },
  };
  const outputs = compareRenewalRelocation(inputs);
  const saved = await saveAnalysis(db, ws, actor, {
    kind: "renewal_vs_relocation", title: `Renewal vs relocation — ${org.display_name}`, orgId: org.id, requirementId: reqId,
    inputs: { ...inputs, workflow_assumptions: assumptions }, outputs, formulaVersion: RVR_VERSION, missing: outputs.missing,
    note: `Prepared automatically by the lease workflow. ${assumptions.join(" ")}`,
  });
  return { status: "done", reason: `${outputs.verdict} ${outputs.missing.length} input(s) still unknown.`, refs: [{ type: "deal_analysis", id: saved.id }] };
}

export async function runLeaseChain(db: Db, ws: string, leaseId: string, opts: ChainOpts = {}) {
  const today = opts.today ?? localDate();
  const { data: lease } = await db.from("lease").select("id, tenant_org_id, asset_id, area_sf, area_basis, rent_per_sf, rent_basis, contractual_expiry, owner_user_id, archived_at, asset:asset_id(name, micro_market_id)")
    .eq("workspace_id", ws).eq("id", leaseId).maybeSingle();
  if (!lease || lease.archived_at || !lease.tenant_org_id) return null;
  const { data: evs } = await db.from("lease_event").select("lease_id, event_type, event_date").eq("workspace_id", ws).eq("lease_id", leaseId).is("archived_at", null);
  const w = R.leaseWindow(lease, evs ?? [], today);
  if (!w) return null;
  const { data: org } = await db.from("organisation").select("id, display_name, owner_user_id").eq("workspace_id", ws).eq("id", lease.tenant_org_id).is("archived_at", null).maybeSingle();
  if (!org) return null; // tenant is not a tracked client/prospect in this workspace
  const actor = lease.owner_user_id ?? org.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "lease_chain", subjectType: "lease", subjectId: lease.id, orgId: org.id, dedupeKey: R.leaseDedupeKey(lease.id, w), actor });
  if (!run) return null;

  const a = await run.step("requirement", LEASE_STEPS[0][1], () => requirementStep(db, ws, actor, lease, org));
  const reqId = refId(a, "requirement");
  if (a.status === "waiting_approval") return run.finish("waiting_approval", `${w.label}: ${a.reason}`);
  if (!reqId) {
    for (const [k, l] of LEASE_STEPS.slice(1)) await run.skip(k, l, "No requirement.");
    return run.finish(a.status === "failed" ? "failed" : "skipped", a.reason);
  }
  const ctx = { db, workspaceId: ws, userId: actor };
  const b = await run.step("shortlist", LEASE_STEPS[1][1], async () => {
    const s = await runShortlist(ctx, reqId, { trigger: "workflow", note: `Lease window: ${w.label}` });
    const usable = s.results.filter((r) => r.eligibility !== "ineligible" && r.availabilityId);
    return { status: "done", reason: `Shortlist v${s.version}: ${usable.length} candidate(s) of ${s.results.length}.${s.warnings.length ? ` ${s.warnings[0]}` : ""}`,
      refs: [{ type: "shortlist_version", id: s.shortlistVersionId }, ...usable.slice(0, 10).map((r) => ({ type: "availability", id: r.availabilityId!, label: r.label }))] };
  });
  const c = await run.step("analysis", LEASE_STEPS[2][1], () => b.status === "done" ? analysisStep(db, ws, actor, lease, org, reqId, b) : Promise.resolve({ status: "skipped" as const, reason: "No shortlist." }));
  const d = await run.step("task", LEASE_STEPS[3][1], async () => {
    const key = `workflows:${R.leaseDedupeKey(lease.id, w)}:discuss`;
    const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (ex) return { status: "done", reason: "Task already exists.", refs: [{ type: "task", id: ex.id }] };
    const analysisId = refId(c, "deal_analysis");
    const related = [{ type: "organisation", id: org.id }, { type: "lease", id: lease.id }, ...(analysisId ? [{ type: "deal_analysis", id: analysisId }] : [])];
    const { data: t, error } = await db.from("task").insert({
      workspace_id: ws, title: `Discuss renewal vs relocation with ${org.display_name}`, status: "open", priority: 2,
      description: `${w.label}. Requirement prepared from the lease${analysisId ? "; renewal vs relocation comparison saved in the toolkit (assumptions listed)" : ""}. Unknowns stay unknown — confirm them with the client.`,
      due_at: new Date(`${today}T12:00:00Z`).toISOString(), assigned_user_id: actor, owner_user_id: actor, source: "workflow",
      linked_entity_type: "requirement", linked_entity_id: reqId, related_entities: related, idempotency_key: key,
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { status: "done", reason: `Task assigned (${w.label}).`, refs: [{ type: "task", id: t.id }] };
  });
  const e = await run.step("outreach", LEASE_STEPS[4][1], () => outreachStep(db, ws, actor, org.id, { scenario: "lease_renewal", ai: opts.ai }));
  const failed = [b, c, d, e].some((s) => s.status === "failed");
  return run.finish(failed ? "failed" : "done", `${w.label}: requirement, ${b.status === "done" ? "shortlist" : "no shortlist"}, ${c.status === "done" ? "comparison" : "no comparison"}, task${e.status === "done" ? ", draft" : ""}.`);
}

// ------------------------------------------------------------------ sweep (job) and reads

/**
 * Finds new triggers and resumes runs waiting on approval. Robust by construction: no DB trigger is needed, missed
 * ticks are caught up (lookback), and the unique dedupe_key makes concurrent or repeated sweeps harmless.
 */
export async function sweep(db: Db, ws: string, opts: ChainOpts & { limit?: number; lookbackDays?: number } = {}) {
  const s = await getSettings(db, ws);
  const limit = opts.limit ?? 25; const out: Record<string, number> = { signals: 0, leases: 0, resumed: 0 };
  const has = async (keys: string[]) => {
    if (!keys.length) return new Set<string>();
    const { data } = await db.from("workflow_run").select("dedupe_key, status").eq("workspace_id", ws).in("dedupe_key", keys);
    return new Set((data ?? []).filter((r) => r.status !== "waiting_approval").map((r) => r.dedupe_key as string));
  };
  if (s.signal_chain) {
    const { data: sigs } = await db.from("signal").select("id, verification, confidence").eq("workspace_id", ws).not("status", "in", "(rejected,dismissed)").is("archived_at", null)
      .gte("updated_at", daysAgoIso(opts.lookbackDays ?? 14)).order("updated_at", { ascending: false }).limit(300);
    const keyed = (sigs ?? []).map((x) => ({ id: x.id as string, key: R.signalDedupeKey(x.id, R.signalStrength(x).strong) }));
    const done = await has(keyed.map((k) => k.key));
    for (const k of keyed.filter((k) => !done.has(k.key)).slice(0, limit)) if (await runSignalChain(db, ws, k.id, opts)) out.signals++;
  }
  if (s.lease_chain) {
    const today = opts.today ?? localDate();
    const [{ data: byExpiry }, { data: byEvent }] = await Promise.all([
      db.from("lease").select("id").eq("workspace_id", ws).not("tenant_org_id", "is", null).is("archived_at", null).gte("contractual_expiry", today).lte("contractual_expiry", edate(today, 12)).limit(500),
      db.from("lease_event").select("lease_id").eq("workspace_id", ws).in("event_type", ["lockin_end", "notice_deadline"]).is("archived_at", null).gte("event_date", today).lte("event_date", edate(today, 6)).limit(500),
    ]);
    const ids = [...new Set([...(byExpiry ?? []).map((l) => l.id as string), ...(byEvent ?? []).map((e) => e.lease_id as string)])];
    const { data: prior } = ids.length ? await db.from("workflow_run").select("subject_id, status").eq("workspace_id", ws).eq("kind", "lease_chain").in("subject_id", ids) : { data: [] as Row[] };
    const seen = new Set((prior ?? []).filter((r) => r.status !== "waiting_approval").map((r) => r.subject_id as string));
    // Leases with a finished run may have entered a new window; runLeaseChain re-checks the exact key cheaply.
    const order = [...ids.filter((i) => !seen.has(i)), ...ids.filter((i) => seen.has(i))].slice(0, limit * 4);
    let n = 0;
    for (const id of order) { if (n >= limit) break; if (await runLeaseChain(db, ws, id, opts)) { out.leases++; n++; } }
  }
  Object.assign(out, await sweepEvents(db, ws, s, opts));
  const { data: waiting } = await db.from("workflow_run").select("kind, subject_id").eq("workspace_id", ws).eq("status", "waiting_approval").limit(limit);
  for (const r of waiting ?? []) {
    if (r.kind === "lease_chain" && !s.lease_chain) continue;
    const res = r.kind === "lease_chain" ? await runLeaseChain(db, ws, r.subject_id, opts) : null;
    if (res) out.resumed++;
  }
  return out;
}

export async function listRuns(db: Db, ws: string, opts: { limit?: number; kind?: R.WorkflowKind } = {}) {
  let q = db.from("workflow_run").select("id, kind, subject_type, subject_id, org_id, status, summary, started_at, finished_at, attempts, org:org_id(display_name), workflow_step(seq, step_key, label, status, reason, output_refs)")
    .eq("workspace_id", ws).order("started_at", { ascending: false }).limit(opts.limit ?? 50);
  if (opts.kind) q = q.eq("kind", opts.kind);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: Row) => ({ ...r, workflow_step: [...(r.workflow_step ?? [])].sort((a: Row, b: Row) => a.seq - b.seq) }));
}

export async function runStats(db: Db, ws: string) {
  const { data } = await db.from("workflow_run").select("status").eq("workspace_id", ws).gte("started_at", daysAgoIso(30)).limit(2000);
  const c: Record<string, number> = {};
  for (const r of data ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
  return c;
}

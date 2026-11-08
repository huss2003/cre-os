"use server";
/**
 * Server Actions for the deals pages. Each action runs as the signed-in user (RLS), then redirects back with a
 * ?msg= or ?err= flash. Forms work without client JavaScript (mobile-friendly).
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { toDealsCtx } from "./api";
import { DealsError, type DealsCtx } from "./ctx";
import { FIELD_BY_KEY } from "./requirements/contract";
import { addStakeholder, confirmRequirement, createRequirement, resolveGeographies, updateRequirementFields, type FieldChange } from "./requirements/service";
import { runShortlist, setOptionStatus } from "./matching/service";
import { createQuote, reviseQuote } from "./quotes/service";
import { createOpportunity, logObjection, moveStage, recordFeeMilestone, seedClosingChecklist, setOutcome, updateFeeMilestone, updateLabels, updateMilestone } from "./pipeline/service";
import { markExported, proposeCrmExport, recordExternalSnapshot } from "./crm/export";
import { approveScenario, evaluateScenario, inputFromQuote } from "./finance/service";
import { approveDocument, generateDocument, refreshStatus, releaseDocument, type Purpose } from "./documents/service";
import type { CostItem, CostState, FinanceInput } from "./finance/types";

const s = (f: FormData, k: string) => { const v = f.get(k); return v === null ? "" : String(v).trim(); };
const n = (f: FormData, k: string) => { const v = s(f, k); if (v === "") return null; const x = Number(v.replace(/,/g, "")); return Number.isFinite(x) ? x : null; };
const opt = (f: FormData, k: string) => s(f, k) || null;

function errText(e: unknown): string {
  if (e instanceof DealsError) {
    const d = e.details as { reasons?: string[]; blockers?: string[]; issues?: { message: string }[] } | undefined;
    const extra = d?.reasons ?? d?.blockers ?? d?.issues?.map((i) => i.message) ?? [];
    return [e.message, ...extra].join(" · ").slice(0, 600);
  }
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message).slice(0, 400);
  return "Something went wrong";
}
const withParam = (path: string, k: string, v: string) => `${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

async function run(back: string, minRole: "editor" | "admin", fn: (ctx: DealsCtx) => Promise<string | { to?: string; msg?: string } | void>, okMsg = "Saved") {
  let dest = back, msg = okMsg, err: string | null = null;
  try {
    const ctx = toDealsCtx(await requireContext(minRole));
    const r = await fn(ctx);
    if (typeof r === "string") dest = r;
    else if (r) { dest = r.to ?? back; msg = r.msg ?? okMsg; }
  } catch (e) {
    err = errText(e);
  }
  revalidatePath(back.split("?")[0]);
  redirect(err ? withParam(back, "err", err) : withParam(dest, "msg", msg));
}

// ---------------------------------------------------------------- requirements
const NEW_FIELDS = ["objective", "decision_date", "occupation_date", "area_basis", "budget_basis", "fitout_standard", "tenure_months", "mandate_status"];

export async function createRequirementAction(f: FormData) {
  await run("/requirements/new", "editor", async (ctx) => {
    const changes: FieldChange[] = [];
    for (const k of NEW_FIELDS) if (s(f, k)) changes.push({ key: k, value: s(f, k) });
    if (s(f, "area_min") || s(f, "area_target") || s(f, "area_max")) changes.push({ key: "area", value: [s(f, "area_min"), s(f, "area_target"), s(f, "area_max")] });
    if (s(f, "budget_min") || s(f, "budget_max")) changes.push({ key: "budget", value: [s(f, "budget_min"), s(f, "budget_max")] });
    if (s(f, "seats_target")) changes.push({ key: "seats", value: ["", s(f, "seats_target"), ""] });
    const r = await createRequirement(ctx, { title: s(f, "title"), orgId: opt(f, "org_id"), orgName: opt(f, "org_name"), changes });
    return `/requirements/${r.id}`;
  }, "Requirement created — answer the open questions next");
}

/** Edit a saved requirement: only fields that changed are written; client-confirmed fields become change proposals. */
export async function editRequirementAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}/edit`, "editor", async (ctx) => {
    const { data: cur, error } = await ctx.db.from("requirement").select("*").eq("id", id).maybeSingle();
    if (error || !cur) throw new DealsError(404, "Requirement not found");
    const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
    const num = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));
    const title = s(f, "title");
    if (title && title !== cur.title) {
      const u = await ctx.db.from("requirement").update({ title }).eq("id", id).eq("row_version", cur.row_version).select("row_version").single();
      if (u.error) throw new DealsError(409, "Someone else changed this requirement. Reload and try again.");
      cur.row_version = u.data.row_version;
    }
    const changes: FieldChange[] = [];
    for (const k of NEW_FIELDS) if (s(f, k) !== str(cur[k]).slice(0, k.endsWith("_date") ? 10 : undefined)) changes.push({ key: k, value: s(f, k) });
    const area = [s(f, "area_min"), s(f, "area_target"), s(f, "area_max")];
    if (area.join("|") !== [num(cur.area_min_sf), num(cur.area_target_sf), num(cur.area_max_sf)].join("|")) changes.push({ key: "area", value: area });
    const budget = [s(f, "budget_min"), s(f, "budget_max")];
    if (budget.join("|") !== [num(cur.budget_min), num(cur.budget_max)].join("|")) changes.push({ key: "budget", value: budget });
    if (s(f, "seats_target") !== num(cur.seats_target)) changes.push({ key: "seats", value: [num(cur.seats_min), s(f, "seats_target"), num(cur.seats_max)] });
    if (!changes.length) return { to: `/requirements/${id}`, msg: title !== cur.title ? "Title updated" : "Nothing changed" };
    const r = await updateRequirementFields(ctx, id, Number(cur.row_version), changes, s(f, "reason") || "Edited on requirement page", null);
    return { to: `/requirements/${id}`, msg: r.proposals.length ? `Saved. ${r.proposals.length} client-confirmed field(s) sent to Approvals.` : "Requirement updated" };
  }, "Requirement updated");
}

export async function updateRequirementFieldAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    const key = s(f, "key");
    const def = FIELD_BY_KEY.get(key);
    if (!def) throw new DealsError(400, "choose a field");
    const status = (opt(f, "status") ?? undefined) as FieldChange["status"];
    const change: FieldChange = { key, status };
    if (s(f, "value_mode") !== "status_only") {
      change.value = def.kind === "range" ? [s(f, "v0"), s(f, "v1"), s(f, "v2")].slice(0, def.columns?.length ?? 3)
        : def.kind === "geo_list" ? await resolveGeographies(ctx, s(f, "value")) : s(f, "value");
    }
    const r = await updateRequirementFields(ctx, id, Number(s(f, "row_version")), [change], s(f, "reason"), s(f, "nonce") || null);
    if (r.proposals.length) return { msg: `"${def.label}" is client-confirmed: a change proposal was created and needs approval (see Approvals)` };
    if (r.specNotes.length) return { msg: `Field updated. Could not derive a structured spec: ${r.specNotes.join("; ")} — set it under Matching configuration.` };
  }, "Field updated");
}

export async function confirmRequirementAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => { await confirmRequirement(ctx, id, Number(s(f, "row_version")), { evidence: s(f, "evidence") }); }, "Requirement marked client-confirmed");
}

export async function addStakeholderAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    await addStakeholder(ctx, id, { personId: opt(f, "person_id"), personName: opt(f, "person_name"), role: s(f, "role"), influenceBasis: opt(f, "influence_basis"), accessStatus: opt(f, "access_status") });
  }, "Stakeholder added");
}

export async function runShortlistAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    const r = await runShortlist(ctx, id, { note: opt(f, "note") });
    return { msg: `Shortlist v${r.version}: ${r.results.filter((x) => x.eligibility === "eligible").length} eligible, ${r.results.filter((x) => x.eligibility === "needs_verification").length} need verification. ${r.warnings.join(" ")}` };
  });
}

export async function setOptionStatusAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => { await setOptionStatus(ctx, s(f, "option_id"), s(f, "status") as never); }, "Option updated");
}

function quoteTerms(f: FormData) {
  const t: Record<string, unknown> = {};
  for (const k of ["rent", "cam_per_sf", "parking_per_slot", "escalation_pct", "escalation_every_months", "rent_free_months", "deposit_months", "capex_support", "lockin_months", "tenure_months"]) {
    const v = n(f, k); if (v !== null) t[k] = v;
  }
  if (s(f, "rent_basis")) t.rent_basis = s(f, "rent_basis");
  if (s(f, "cam_included") === "on") t.cam_included = true;
  if (s(f, "gst")) t.gst = s(f, "gst");
  if (s(f, "inclusions")) t.inclusions = s(f, "inclusions");
  return t;
}

export async function createQuoteAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    await createQuote(ctx, { requirementId: id, spaceId: opt(f, "space_id"), terms: quoteTerms(f), validUntil: opt(f, "valid_until"), evidence: opt(f, "evidence"), approvedFloor: n(f, "approved_floor"), approvedCeiling: n(f, "approved_ceiling") });
  }, "Quote v1 recorded");
}

export async function reviseQuoteAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    const q = await reviseQuote(ctx, s(f, "quote_id"), { terms: quoteTerms(f), validUntil: opt(f, "valid_until") ?? undefined, evidence: opt(f, "evidence") });
    return { msg: `Quote v${q.version} recorded; previous version superseded — dependent approvals and documents were invalidated` };
  });
}

export async function quickScenarioFromQuoteAction(f: FormData) {
  const id = s(f, "id");
  await run(`/requirements/${id}`, "editor", async (ctx) => {
    const q = (await ctx.db.from("quote").select("id, version, valid_until, terms_json, space_id").eq("id", s(f, "quote_id")).single()).data as { id: string; version: number; valid_until: string | null; terms_json: Record<string, unknown>; space_id: string | null } | null;
    if (!q) throw new DealsError(404, "quote not found");
    const space = q.space_id ? ((await ctx.db.from("space").select("chargeable_sf, carpet_sf, seats").eq("id", q.space_id).single()).data ?? {}) : {};
    const horizon = n(f, "horizon") ?? 60;
    const input = inputFromQuote({
      name: s(f, "name") || `Quote v${q.version}`, baseDate: s(f, "base_date"), horizonMonths: horizon, annualDiscountRatePct: n(f, "discount") ?? 0,
      quote: q as never, space: space as never, fitoutCost: s(f, "fitout_state") === "none" ? 0 : n(f, "fitout"), gstRatePct: n(f, "gst_rate"),
      afterTenure: (opt(f, "after_tenure") as FinanceInput["afterTenure"]) ?? null,
      parkingSlots: s(f, "parking_state") === "none" ? 0 : n(f, "parking_slots"), opexMonthly: s(f, "opex_state") === "none" ? 0 : n(f, "opex_monthly"),
    });
    const r = await evaluateScenario(ctx, { input, requirementId: id, save: true });
    return `/finance/${r.scenarioId}`;
  }, "Scenario calculated");
}

// ---------------------------------------------------------------- opportunities
export async function createOpportunityAction(f: FormData) {
  const back = s(f, "back") || "/deals";
  await run(back, "editor", async (ctx) => {
    const o = await createOpportunity(ctx, {
      name: s(f, "name"), requirementId: opt(f, "requirement_id"), orgId: opt(f, "org_id"), stage: opt(f, "stage") ?? undefined,
      temperature: opt(f, "temperature"), mandateStatus: opt(f, "mandate_status"), expectedFee: n(f, "expected_fee"),
      creditShare: n(f, "credit_share_pct") === null ? null : n(f, "credit_share_pct")! / 100, expectedClose: opt(f, "expected_close"), crmExternalId: opt(f, "crm_external_id"),
    });
    return `/deals/${(o as { id: string }).id}`;
  }, "Opportunity created");
}

export async function moveStageAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await moveStage(ctx, id, Number(s(f, "row_version")), s(f, "stage"), opt(f, "evidence")); }, "Stage updated");
}
export async function setOutcomeAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await setOutcome(ctx, id, Number(s(f, "row_version")), s(f, "outcome"), opt(f, "reason")); }, "Outcome updated");
}
export async function updateLabelsAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => {
    const has = (k: string) => f.has(k);
    await updateLabels(ctx, id, Number(s(f, "row_version")), {
      ...(has("temperature") ? { temperature: opt(f, "temperature") } : {}), ...(has("mandate_status") ? { mandateStatus: opt(f, "mandate_status") } : {}),
      ...(has("next_action") ? { nextAction: opt(f, "next_action") } : {}), ...(has("next_action_due") ? { nextActionDue: opt(f, "next_action_due") } : {}),
      ...(has("expected_close") ? { expectedClose: opt(f, "expected_close") } : {}),
    });
  }, "Labels updated");
}
export async function seedChecklistAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await seedClosingChecklist(ctx, id); }, "Closing checklist ready");
}
export async function updateMilestoneAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await updateMilestone(ctx, s(f, "milestone_id"), { status: s(f, "status"), proofText: opt(f, "proof_text") }); }, "Checklist item updated");
}
export async function feeAction(f: FormData) {
  const id = s(f, "id");
  const back = s(f, "back") || `/deals/${id}`;
  await run(back, "editor", async (ctx) => {
    const pct = n(f, "credit_share_pct");
    const row = {
      gross_fee: n(f, "gross_fee"), credit_share: pct === null ? null : pct / 100, milestone: opt(f, "milestone"),
      invoiced_amount: n(f, "invoiced_amount"), invoiced_on: opt(f, "invoiced_on"), recognised_amount: n(f, "recognised_amount"), recognised_on: opt(f, "recognised_on"),
      collected_amount: n(f, "collected_amount"), collected_on: opt(f, "collected_on"), evidence: opt(f, "evidence"),
    };
    if (s(f, "milestone_id")) {
      const patch = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
      await updateFeeMilestone(ctx, s(f, "milestone_id"), patch);
    } else await recordFeeMilestone(ctx, id, row);
  }, "Fee record saved");
}
export async function objectionAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await logObjection(ctx, id, { category: s(f, "category") || "other", objection: s(f, "objection"), response: opt(f, "response") }); }, "Objection logged");
}
export async function crmProposeAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await proposeCrmExport(ctx, id); }, "CRM export proposal prepared");
}
export async function crmExternalAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => {
    const ext: Record<string, unknown> = {};
    for (const k of ["stage", "outcome", "expected_fee", "expected_close", "name"]) if (s(f, `ext_${k}`)) ext[k] = k === "expected_fee" ? n(f, `ext_${k}`) : s(f, `ext_${k}`);
    const r = await recordExternalSnapshot(ctx, s(f, "export_id"), ext, opt(f, "crm_external_id")) as { status: string };
    return { msg: r.status === "conflict" ? "CRM has competing updates — review the conflicts" : "CRM values recorded" };
  });
}
export async function crmExportedAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => { await markExported(ctx, s(f, "export_id"), { resolution: (opt(f, "resolution") as never) ?? null }); }, "Marked as entered in the official CRM");
}

// ---------------------------------------------------------------- finance
/**
 * Each optional cost has a three-state selector `<item>_state`: "unknown" (default — a visible gap, never zero),
 * "none" (explicitly included elsewhere / not applicable) or "amount" (use the amount fields). An amount typed while
 * the selector is left on "unknown" counts as known.
 */
async function costStateFromForm(f: FormData, item: CostItem, hasAmount: boolean): Promise<CostState> {
  const sel = s(f, `${item}_state`);
  if (sel === "none") return "none";
  return hasAmount ? "known" : "unknown";
}

async function financeInputFromForm(f: FormData): Promise<FinanceInput> {
  const escPct = n(f, "esc_pct"), escEvery = n(f, "esc_every");
  const esc = escPct !== null && escEvery ? { pct: escPct, everyMonths: escEvery } : null;
  const camAmount = n(f, "cam_rate") !== null || n(f, "cam_fixed") !== null;
  const camMode = !camAmount ? "none" : n(f, "cam_rate") !== null && n(f, "cam_fixed") !== null ? "mixed" : n(f, "cam_rate") !== null ? "per_sf" : "fixed";
  const parkingAmount = !!n(f, "parking_slots") && n(f, "parking_rate") !== null;
  const depositAmount = !!n(f, "deposit_months");
  const fitoutAmount = !!n(f, "fitout");
  const reinstAmount = !!n(f, "reinstatement");
  const opexAmount = !!n(f, "opex_monthly");
  const costStates: Partial<Record<CostItem, CostState>> = {
    rent: n(f, "rent") === null ? (s(f, "rent_state") === "none" ? "none" : "unknown") : "known",
    cam: await costStateFromForm(f, "cam", camAmount), parking: await costStateFromForm(f, "parking", parkingAmount),
    deposit: await costStateFromForm(f, "deposit", depositAmount), fitout: await costStateFromForm(f, "fitout", fitoutAmount),
    reinstatement: await costStateFromForm(f, "reinstatement", reinstAmount), opex: await costStateFromForm(f, "opex", opexAmount),
  };
  const input: FinanceInput = {
    name: s(f, "name") || "Scenario", kind: (s(f, "kind") || "conventional") as FinanceInput["kind"], baseDate: s(f, "base_date"),
    horizonMonths: n(f, "horizon") ?? 60, annualDiscountRatePct: n(f, "discount") ?? (null as never),
    area: { chargeableSf: n(f, "chargeable_sf"), carpetSf: n(f, "carpet_sf"), plannedSeats: n(f, "seats") },
    tenureMonths: n(f, "tenure"), afterTenure: (opt(f, "after_tenure") as FinanceInput["afterTenure"]) ?? null,
    rent: n(f, "rent") === null ? null : { basis: (s(f, "rent_basis") || "chargeable") as "chargeable", rate: n(f, "rent")!, escalation: esc, rentFreeMonths: n(f, "rent_free") ?? 0, startPeriod: n(f, "start_period") ?? 1 },
    cam: camMode === "none" ? null : { mode: camMode as "fixed", fixedMonthly: n(f, "cam_fixed") ?? undefined, ratePerSf: n(f, "cam_rate") ?? undefined, escalation: esc },
    parking: parkingAmount ? { slots: n(f, "parking_slots")!, ratePerSlot: n(f, "parking_rate")!, escalation: esc } : null,
    deposit: depositAmount ? { months: n(f, "deposit_months")! } : null,
    capex: fitoutAmount || reinstAmount || n(f, "capex_support")
      ? { fitoutCost: n(f, "fitout") ?? 0, landlordContribution: n(f, "capex_support") ?? 0, reinstatement: reinstAmount ? { amount: n(f, "reinstatement")!, period: n(f, "tenure") ?? n(f, "horizon") ?? 60 } : null }
      : null,
    recurring: opexAmount ? [{ label: "Other operating costs", monthly: n(f, "opex_monthly")!, category: "opex" }] : [],
    costStates,
    assumptionSources: s(f, "discount_source") ? { discount_rate: s(f, "discount_source") } : undefined,
    move: n(f, "parallel_rent") ? { parallelRentMonthly: n(f, "parallel_rent")!, parallelMonths: n(f, "parallel_months") ?? 0, moveCost: n(f, "move_cost") ?? undefined } : null,
    taxes: s(f, "gst") ? { treatment: s(f, "gst") as "excluded", gstRatePct: n(f, "gst_rate") } : null,
  };
  if (n(f, "fin_principal")) {
    input.financing = { partnerName: s(f, "fin_partner") || "Financier", partnerId: opt(f, "fin_partner_id"), principal: n(f, "fin_principal")!, annualInterestRate: n(f, "fin_rate") ?? 0, termMonths: n(f, "fin_term") ?? 36, upfrontFee: n(f, "fin_fee") ?? undefined };
  }
  return input;
}

export async function evaluateScenarioAction(f: FormData) {
  await run("/finance", "editor", async (ctx) => {
    const r = await evaluateScenario(ctx, { input: await financeInputFromForm(f), requirementId: opt(f, "requirement_id"), save: true });
    return `/finance/${r.scenarioId}`;
  }, "Scenario calculated");
}
export async function approveScenarioAction(f: FormData) {
  const id = s(f, "id");
  await run(`/finance/${id}`, "admin", async (ctx) => { await approveScenario(ctx, id, { acknowledgeGaps: s(f, "acknowledge_gaps") === "on", note: opt(f, "note") }); }, "Scenario approved");
}

// ---------------------------------------------------------------- documents
export async function generateDocumentAction(f: FormData) {
  await run("/documents", "editor", async (ctx) => {
    const r = await generateDocument(ctx, { purpose: s(f, "purpose") as Purpose, requirementId: s(f, "requirement_id"), scenarioIds: f.getAll("scenario_ids").map(String).filter(Boolean), preparedFor: opt(f, "prepared_for") });
    return { msg: `Draft generated${r.warnings.length ? ` — ${r.warnings.join(" ")}` : ""}` };
  });
}
export async function approveDocumentAction(f: FormData) {
  await run("/documents", "admin", async (ctx) => { await approveDocument(ctx, s(f, "id")); }, "Document approved (bound to its file hash)");
}
export async function releaseDocumentAction(f: FormData) {
  await run("/documents", "admin", async (ctx) => {
    const r = await releaseDocument(ctx, s(f, "id"), { recipient: s(f, "recipient") });
    return { msg: `Released — download and share it yourself. ${r.warnings.length ? `Warnings: ${r.warnings.join("; ")}` : ""}` };
  });
}
export async function refreshDocumentAction(f: FormData) {
  await run("/documents", "editor", async (ctx) => {
    const r = await refreshStatus(ctx, s(f, "id"));
    return { msg: r.reasons.length ? `Stale: ${r.reasons.join("; ")}` : "Inputs unchanged — document is current" };
  });
}

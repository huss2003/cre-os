/** Opportunity pipeline, closing coordinator and fee records (RLS-scoped). Stage history is written by a DB trigger. */
import { type DealsCtx, DealsError, dbError, must, owned, today } from "../ctx";
import { feeProtectionIssues, feeSummary, type FeeMilestoneRow } from "../fees/fees";
import { CLOSING_TEMPLATE, MANDATES, STAGES, TEMPERATURES, checkOutcome, checkTransition } from "./stages";

export interface CreateOpportunityInput {
  name: string; orgId?: string | null; requirementId?: string | null; stage?: string;
  temperature?: string | null; mandateStatus?: string | null; expectedFee?: number | null; creditShare?: number | null;
  expectedClose?: string | null; nextAction?: string | null; nextActionDue?: string | null; crmExternalId?: string | null;
}

export async function createOpportunity(ctx: DealsCtx, i: CreateOpportunityInput) {
  if (!i.name?.trim()) throw new DealsError(400, "name is required");
  let orgId = i.orgId ?? null;
  let cls = "corporate_confidential";
  if (i.requirementId) {
    const req = must(await ctx.db.from("requirement").select("id, org_id, classification").eq("id", i.requirementId).maybeSingle(), "requirement") as { org_id: string; classification: string };
    orgId = orgId ?? req.org_id;
    cls = req.classification;
    if (orgId !== req.org_id) throw new DealsError(400, "opportunity company must match the requirement's company");
  }
  if (!orgId) throw new DealsError(400, "company (orgId) or requirement is required");
  const stage = i.stage ?? "research";
  if (!(STAGES as readonly string[]).includes(stage)) throw new DealsError(400, `unknown stage ${stage}`);
  if (STAGES.indexOf(stage as never) >= STAGES.indexOf("requirement_confirmed")) throw new DealsError(400, "new opportunities start at qualified discussion or earlier; move stages with evidence");
  if (i.temperature && !(TEMPERATURES as readonly string[]).includes(i.temperature)) throw new DealsError(400, "temperature must be cold/warm/hot");
  if (i.mandateStatus && !(MANDATES as readonly string[]).includes(i.mandateStatus)) throw new DealsError(400, "unknown mandate status");
  return must(await ctx.db.from("opportunity").insert({
    ...owned(ctx, cls), name: i.name.trim(), org_id: orgId, requirement_id: i.requirementId ?? null, stage,
    temperature: i.temperature ?? null, mandate_status: i.mandateStatus ?? "unknown", expected_fee: i.expectedFee ?? null,
    credit_share: i.creditShare ?? null, expected_close: i.expectedClose ?? null, next_action: i.nextAction ?? null,
    next_action_due: i.nextActionDue ?? null, crm_external_id: i.crmExternalId ?? null, account_owner_user_id: ctx.userId,
  }).select("*").single(), "opportunity");
}

async function loadOpp(ctx: DealsCtx, id: string) {
  return must(await ctx.db.from("opportunity").select("*").eq("id", id).maybeSingle(), "opportunity") as Record<string, unknown> & { stage: string; outcome: string | null; requirement_id: string | null; row_version: number };
}

export async function moveStage(ctx: DealsCtx, id: string, expectedVersion: number, to: string, evidence?: string | null) {
  const opp = await loadOpp(ctx, id);
  if (Number(opp.row_version) !== Number(expectedVersion)) throw new DealsError(409, "stale_version: the opportunity changed, reload and retry");
  let reqStatus: string | null = null;
  if (opp.requirement_id) reqStatus = ((await ctx.db.from("requirement").select("status").eq("id", opp.requirement_id).maybeSingle()).data as { status: string } | null)?.status ?? null;
  const ms = await ctx.db.from("deal_milestone").select("title, required_for_stage, status").eq("opportunity_id", id).not("required_for_stage", "is", null);
  const fees = (await ctx.db.from("fee_milestone").select("invoiced_amount, recognised_amount, collected_amount").eq("opportunity_id", id)).data ?? [];
  const chk = checkTransition(opp.stage, to, {
    outcome: opp.outcome, requirementStatus: reqStatus, evidence,
    openBlockingMilestones: ((ms.data ?? []) as { title: string; required_for_stage: string | null; status: string }[]).filter((m) => !["done", "waived", "not_applicable"].includes(m.status)),
    fee: { invoiced: fees.some((f) => f.invoiced_amount !== null), recognised: fees.some((f) => f.recognised_amount !== null), collected: fees.some((f) => f.collected_amount !== null) },
  });
  if (!chk.ok) throw new DealsError(422, "stage change blocked", { reasons: chk.reasons });
  const r = await ctx.db.rpc("deals_move_stage", { p_id: id, p_expected_version: expectedVersion, p_stage: to, p_evidence: evidence ?? null });
  if (r.error) throw dbError(r.error, "opportunity");
  return r.data;
}

export async function setOutcome(ctx: DealsCtx, id: string, expectedVersion: number, outcome: string, reason?: string | null) {
  const opp = await loadOpp(ctx, id);
  if (Number(opp.row_version) !== Number(expectedVersion)) throw new DealsError(409, "stale_version: the opportunity changed, reload and retry");
  const chk = checkOutcome(opp.stage, outcome, reason);
  if (!chk.ok) throw new DealsError(422, "outcome blocked", { reasons: chk.reasons });
  const r = await ctx.db.rpc("deals_set_outcome", { p_id: id, p_expected_version: expectedVersion, p_outcome: outcome, p_reason: reason ?? null });
  if (r.error) throw dbError(r.error, "opportunity");
  return r.data;
}

export async function updateLabels(ctx: DealsCtx, id: string, expectedVersion: number, p: { temperature?: string | null; mandateStatus?: string | null; nextAction?: string | null; nextActionDue?: string | null; expectedClose?: string | null; risks?: string | null }) {
  const patch: Record<string, unknown> = {};
  if (p.temperature !== undefined) { if (p.temperature && !(TEMPERATURES as readonly string[]).includes(p.temperature)) throw new DealsError(400, "bad temperature"); patch.temperature = p.temperature; }
  if (p.mandateStatus !== undefined) { if (p.mandateStatus && !(MANDATES as readonly string[]).includes(p.mandateStatus)) throw new DealsError(400, "bad mandate"); patch.mandate_status = p.mandateStatus; }
  if (p.nextAction !== undefined) patch.next_action = p.nextAction;
  if (p.nextActionDue !== undefined) patch.next_action_due = p.nextActionDue;
  if (p.expectedClose !== undefined) patch.expected_close = p.expectedClose;
  if (p.risks !== undefined) patch.risks = p.risks;
  const r = await ctx.db.rpc("deals_update_opportunity", { p_id: id, p_expected_version: expectedVersion, p_patch: patch });
  if (r.error) throw dbError(r.error, "opportunity");
  return r.data;
}

/** Seed the closing checklist (idempotent: one row per template key). */
export async function seedClosingChecklist(ctx: DealsCtx, opportunityId: string) {
  const opp = await loadOpp(ctx, opportunityId);
  const have = new Set((((await ctx.db.from("deal_milestone").select("template_key").eq("opportunity_id", opportunityId)).data ?? []) as { template_key: string | null }[]).map((r) => r.template_key));
  const rows = CLOSING_TEMPLATE.filter((t) => !have.has(t.key)).map((t, i) => ({
    ...owned(ctx, String(opp.classification ?? "corporate_confidential")), opportunity_id: opportunityId, template_key: t.key, kind: t.kind,
    category: t.category, title: t.title, required_for_stage: t.required_for_stage, proof_required: t.proof_required, sort_order: i,
  }));
  if (rows.length) {
    const r = await ctx.db.from("deal_milestone").insert(rows);
    if (r.error && r.error.code !== "23505") throw dbError(r.error, "deal_milestone");
  }
  return (await ctx.db.from("deal_milestone").select("*").eq("opportunity_id", opportunityId).order("sort_order")).data ?? [];
}

export async function updateMilestone(ctx: DealsCtx, milestoneId: string, p: { status: string; proofText?: string | null; dueDate?: string | null }) {
  const m = must(await ctx.db.from("deal_milestone").select("*").eq("id", milestoneId).maybeSingle(), "milestone") as { proof_required: boolean; proof_text: string | null };
  if (p.status === "done" && m.proof_required && !(p.proofText ?? m.proof_text ?? "").trim()) throw new DealsError(422, "this item needs proof (document name, email reference, signed copy)");
  const patch: Record<string, unknown> = { status: p.status };
  if (p.proofText !== undefined) patch.proof_text = p.proofText;
  if (p.dueDate !== undefined) patch.due_date = p.dueDate;
  if (p.status === "done") { patch.completed_at = new Date().toISOString(); patch.completed_by = ctx.userId; }
  const r = await ctx.db.from("deal_milestone").update(patch).eq("id", milestoneId).select("*").single();
  if (r.error) throw dbError(r.error, "milestone");
  return r.data;
}

export async function recordFeeMilestone(ctx: DealsCtx, opportunityId: string, f: FeeMilestoneRow) {
  const opp = await loadOpp(ctx, opportunityId);
  const r = await ctx.db.from("fee_milestone").insert({
    ...owned(ctx, String(opp.classification ?? "corporate_confidential")), opportunity_id: opportunityId,
    gross_fee: f.gross_fee ?? null, credit_share: f.credit_share ?? null, milestone: f.milestone ?? null, exclusions: f.exclusions ?? null,
    invoiced_amount: f.invoiced_amount ?? null, invoiced_on: f.invoiced_on ?? null, recognised_amount: f.recognised_amount ?? null,
    recognised_on: f.recognised_on ?? null, collected_amount: f.collected_amount ?? null, collected_on: f.collected_on ?? null,
    currency: f.currency ?? "INR", tax_basis: f.tax_basis ?? null, evidence: f.evidence ?? null,
  }).select("*").single();
  if (r.error) throw dbError(r.error, "fee_milestone");
  return r.data;
}

/** Update a fee milestone with the next money event (invoice / recognition / collection). Earlier amounts are kept. */
export async function updateFeeMilestone(ctx: DealsCtx, id: string, f: Partial<FeeMilestoneRow>) {
  const patch: Record<string, unknown> = {};
  for (const k of ["gross_fee", "credit_share", "invoiced_amount", "invoiced_on", "recognised_amount", "recognised_on", "collected_amount", "collected_on", "evidence", "milestone", "tax_basis", "exclusions"] as const)
    if (f[k] !== undefined) patch[k] = f[k];
  const r = await ctx.db.rpc("deals_update_fee", { p_id: id, p_patch: patch });
  if (r.error) throw dbError(r.error, "fee_milestone");
  return r.data;
}

export async function listBoard(ctx: DealsCtx, opts: { includeClosed?: boolean } = {}) {
  let q = ctx.db.from("opportunity").select("id, name, stage, outcome, temperature, mandate_status, expected_fee, credit_share, expected_close, next_action, next_action_due, stage_entered_at, row_version, requirement_id, organisation:org_id(display_name)")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("stage_entered_at", { ascending: true }).limit(500);
  if (!opts.includeClosed) q = q.in("outcome", ["open", "won"]);
  const r = await q;
  if (r.error) throw dbError(r.error, "opportunities");
  return r.data ?? [];
}

export async function getOpportunityDetail(ctx: DealsCtx, id: string) {
  const opp = must(await ctx.db.from("opportunity").select("*, organisation:org_id(id, display_name), requirement:requirement_id(id, title, status)").eq("id", id).maybeSingle(), "opportunity") as Record<string, unknown> & { stage: string };
  const [hist, ms, fees, crm, obj] = await Promise.all([
    ctx.db.from("opportunity_stage_history").select("from_stage, to_stage, changed_at, evidence").eq("opportunity_id", id).order("changed_at", { ascending: false }),
    ctx.db.from("deal_milestone").select("*").eq("opportunity_id", id).order("sort_order"),
    ctx.db.from("fee_milestone").select("*").eq("opportunity_id", id).order("created_at"),
    ctx.db.from("crm_export").select("*").eq("entity_type", "opportunity").eq("entity_id", id).order("created_at", { ascending: false }).limit(10),
    ctx.db.from("objection_log").select("*").eq("opportunity_id", id).order("raised_on", { ascending: false }),
  ]);
  const feeRows = (fees.data ?? []) as FeeMilestoneRow[];
  return {
    opportunity: opp, history: hist.data ?? [], milestones: ms.data ?? [], fees: feeRows,
    feeSummary: feeSummary(feeRows, opp.credit_share as number | null),
    feeIssues: feeProtectionIssues(opp as never, feeRows, today()),
    crmExports: crm.data ?? [], objections: obj.data ?? [],
  };
}

export async function logObjection(ctx: DealsCtx, opportunityId: string, o: { category?: string; objection: string; response?: string | null }) {
  const opp = await loadOpp(ctx, opportunityId);
  if (!o.objection?.trim()) throw new DealsError(400, "objection text is required");
  const r = await ctx.db.from("objection_log").insert({
    ...owned(ctx, String(opp.classification ?? "corporate_confidential")), opportunity_id: opportunityId, requirement_id: opp.requirement_id,
    category: o.category ?? "other", objection: o.objection.trim(), response: o.response ?? null,
  }).select("*").single();
  if (r.error) throw dbError(r.error, "objection");
  return r.data;
}

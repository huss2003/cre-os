/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { saveEntity, setArchived, EDITABLE } from "@/modules/admin/entities";
import { classifyRisk, proposeChange } from "@/lib/services/changes";
import { buildPatch, assertRequirementRanges } from "@/modules/deals/requirements/service";
import { FIELD_BY_KEY, fieldValue, type RequirementRow } from "@/modules/deals/requirements/contract";
import { createOpportunity, moveStage } from "@/modules/deals/pipeline/service";
import { STAGES } from "@/modules/deals/pipeline/stages";
import { approve as approveOutreach, openForSend } from "@/modules/outreach/service";
import { approveDraft, openDraftForSend, getDraft } from "@/lib/services/drafts";
import type { ApprovalPlan, EntityRef, ToolContext } from "../types";
import { HREF, NOT_FOUND, db, defineTool, failed, getOne, isUuid, logDenied, namesById, ref, ws, type Row } from "./shared";

/**
 * Category C tools: the engine calls plan() to show an approval card (exact before/after diff read from the current
 * record) and calls run() only after the user approves. run() executes through the owning module's service or
 * proposeChange(); material fields still go to Review (S4) — the assistant approval never bypasses that.
 */
class NotVisible extends Error { constructor() { super(NOT_FOUND); } }

async function mustGet(t: ToolContext, tool: string, table: string, id: string, select = "*"): Promise<Row> {
  const r = isUuid(id) ? await getOne(t, table, id, select) : null;
  if (!r) { await logDenied(t, tool, { entity: table, id }); throw new NotVisible(); }
  return r;
}
const dealsCtx = (t: ToolContext) => ({ db: db(t), workspaceId: ws(t), userId: t.ctx.userId, role: t.ctx.role });
const notVisible = (e: unknown) => e instanceof NotVisible ? { ok: false, error: NOT_FOUND, summary: "Record not found or you don't have access." } : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------------------------------------------- company
const ORG_FIELDS = ["display_name", "legal_name", "domain", "cin", "gstin", "sector", "hq_country", "headcount_min", "headcount_max", "is_gcc", "account_owner_note", "contact_restrictions"] as const;
const orgChanges = z.object({
  display_name: z.string().max(200).optional(), legal_name: z.string().max(300).nullable().optional(), domain: z.string().max(200).nullable().optional(),
  cin: z.string().max(40).nullable().optional(), gstin: z.string().max(40).nullable().optional(), sector: z.string().max(100).nullable().optional(),
  hq_country: z.string().max(80).nullable().optional(), headcount_min: z.number().int().nullable().optional(), headcount_max: z.number().int().nullable().optional(),
  is_gcc: z.boolean().nullable().optional(), account_owner_note: z.string().max(4000).nullable().optional(), contact_restrictions: z.string().max(2000).nullable().optional(),
}).describe("Only the fields to change; null = clear (unknown)");

const updateCompanyRecord = defineTool({
  id: "update_company_record", module: "database", category: "C", minRole: "member",
  description: "Change fields on a company record (name, sector, domain, headcount, GCC flag, account note, contact restrictions…). Needs the user's approval. Routine fields are saved; material fields (legal name, CIN, GSTIN, domain) become a change proposal in Review.",
  input: z.object({ companyId: z.string(), changes: orgChanges, reason: z.string().min(3).max(500).describe("Why — e.g. 'Client said in call on 12 Nov'") }),
  async plan(i, t): Promise<ApprovalPlan> {
    const o = await mustGet(t, "update_company_record", "organisation", i.companyId);
    const diff = ORG_FIELDS.filter((k) => k in i.changes && !same(o[k], (i.changes as Row)[k])).map((k) => ({ field: k, before: o[k] ?? null, after: (i.changes as Row)[k] ?? null }));
    const material = diff.filter((d) => classifyRisk("organisation", "update", [{ op: "replace", path: `/${d.field}`, value: d.after }]) !== "routine_internal").map((d) => d.field);
    return {
      title: `Update company ${o.display_name}`, affected: [ref("company", o.id, o.display_name, HREF.company(o.id))], diff,
      explanation: `${i.reason}.${material.length ? ` ${material.join(", ")} ${material.length === 1 ? "is a" : "are"} material field(s): after approval here they go to Review as a change proposal.` : ""}${diff.length ? "" : " Nothing would change."}`,
    };
  },
  async run(i, t) {
    try {
      const o = await mustGet(t, "update_company_record", "organisation", i.companyId, "id, row_version, display_name");
      const input = Object.fromEntries(Object.entries(i.changes).filter(([k]) => EDITABLE.organisation.includes(k)).map(([k, v]) => [k, v === null ? "" : v]));
      const r = await saveEntity(db(t), ws(t), "organisation", o.id, Number(o.row_version), input, `Assistant: ${i.reason}`);
      return { ok: true, summary: `${r.applied.length} field(s) saved${r.proposed.length ? `, ${r.proposed.length} sent to Review` : ""}`, data: { applied: r.applied, proposed: r.proposed, proposalId: r.proposalId }, entities: [ref("company", o.id, o.display_name, HREF.company(o.id))], blocks: [{ kind: "status", done: r.applied.map((f) => `Saved ${f}`), pending: r.proposed.map((f) => `${f} awaiting approval in Review`), blocked: [] }] };
    } catch (e) { return notVisible(e) ?? failed("Company update failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- requirement
const REQ_KEYS = [...FIELD_BY_KEY.keys()];
/** Invalid changes (unknown key, bad range shape) — rejected before an approval is ever shown. */
export function requirementChangeProblems(changes: { key: string; value?: unknown }[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const f = FIELD_BY_KEY.get(c.key);
    if (!f) { out.push(`"${c.key}" is not a requirement field. Valid keys: ${REQ_KEYS.join(", ")} (area and seats are [min, target, max]; budget is [min, max]).`); continue; }
    if (f.kind === "range") {
      const n = (f.columns ?? []).length;
      if (!Array.isArray(c.value) || c.value.length !== n || c.value.some((x) => x !== null && !Number.isFinite(Number(x)))) out.push(`${c.key} must be an array of ${n} numbers or null ([${(f.columns ?? []).join(", ")}]).`);
    }
  }
  return out;
}

const updateRequirementRecord = defineTool({
  id: "update_requirement_record", module: "database", category: "C", minRole: "member",
  description: `Change requirement fields with their status (client_confirmed / reported / estimated). Needs approval; on approval the change is filed as a change proposal (old value preserved, source = this assistant conversation) for Review. Keys (Deals contract): ${REQ_KEYS.join(", ")}. Ranges: area = [min_sf, target_sf, max_sf], seats = [min, target, max], budget = [min, max]; e.g. {key:"area", value:[22000,30000,33000]}. Unknown keys are rejected.`,
  input: z.object({
    requirementId: z.string(),
    changes: z.array(z.object({ key: z.string().describe(`Requirement field key: ${REQ_KEYS.join(", ")}`), value: z.unknown(), status: z.enum(["client_confirmed", "reported", "estimated", "unknown"]).optional() })).min(1).max(15)
      .superRefine((cs, ctx) => { for (const p of requirementChangeProblems(cs)) ctx.addIssue({ code: "custom", message: p }); }),
    reason: z.string().min(3).max(500),
  }),
  async plan(i, t) {
    const r = await mustGet(t, "update_requirement_record", "requirement", i.requirementId);
    const diff = i.changes.map((c) => ({ field: `${FIELD_BY_KEY.get(c.key)!.label}${c.status ? ` (${c.status})` : ""}`, before: fieldValue(r as RequirementRow, c.key) ?? null, after: c.value ?? null }));
    return { title: `Update requirement ${r.title}`, affected: [ref("requirement", r.id, r.title, HREF.requirement(r.id))], diff, explanation: `${i.reason}. After approval this is filed as a change proposal in Review (/approvals); the current value is kept until it is applied.` };
  },
  async run(i, t) {
    try {
      const problems = requirementChangeProblems(i.changes);
      if (problems.length) return { ok: false, error: "invalid_input", summary: problems.join(" ") };
      const r = await mustGet(t, "update_requirement_record", "requirement", i.requirementId);
      const changes = i.changes.map((c) => ({ key: c.key, value: c.value, status: c.status ?? "client_confirmed" }));
      const { columns, constraints } = buildPatch(r as RequirementRow, changes as never);
      assertRequirementRanges({ ...r, ...columns });
      const patch = [...Object.entries(columns).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })), { op: "replace" as const, path: "/constraints", value: constraints }];
      const source = `assistant conversation ${t.conversationId ?? "(none)"}, run ${t.runId}`;
      const cp = (await proposeChange(db(t), ws(t), {
        targetType: "requirement", targetId: r.id, operation: "update", expectedVersion: Number(r.row_version), patch,
        reason: `Assistant: ${i.reason} [source: ${source}]`, proposedByKind: "user", ownerUserId: t.ctx.userId,
        classification: String(r.classification ?? "corporate_confidential"), idempotencyKey: `assistant:req:${r.id}:${t.runId}:${changes.map((c) => c.key).join(",")}`,
      })) as Row;
      const fields = changes.map((c) => FIELD_BY_KEY.get(c.key)!.label);
      const applied = cp.state === "applied";
      return {
        ok: true, summary: applied ? `${fields.join(", ")} updated (routine change applied)` : `Change proposal filed for Review: ${fields.join(", ")} — the current value stays until it is approved there`,
        data: { proposalId: cp.id, state: cp.state, risk: cp.risk, fields: changes.map((c) => c.key), source, href: "/approvals" },
        entities: [ref("requirement", r.id, r.title, HREF.requirement(r.id))],
        blocks: [{ kind: "status", done: applied ? fields.map((f) => `Saved ${f}`) : [], pending: applied ? [] : fields.map((f) => `${f} awaiting approval in Review`), blocked: [] }],
      };
    } catch (e) { return notVisible(e) ?? failed("Requirement update failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- opportunity stage
const changeOpportunityStage = defineTool({
  id: "change_opportunity_stage", module: "database", category: "C", minRole: "member",
  description: "Move a deal to another pipeline stage with evidence (what happened). Needs approval. The Deals service enforces stage rules (e.g. confirmed requirement, closing items, fee records) and records stage history.",
  input: z.object({ opportunityId: z.string(), toStage: z.enum(STAGES), evidence: z.string().min(3).max(1000).describe("What happened that justifies the move") }),
  async plan(i, t) {
    const o = await mustGet(t, "change_opportunity_stage", "opportunity", i.opportunityId);
    return { title: `Move ${o.name} to ${i.toStage}`, affected: [ref("opportunity", o.id, o.name, HREF.opportunity(o.id))], diff: [{ field: "stage", before: o.stage, after: i.toStage }], explanation: `Evidence: ${i.evidence}. Stage rules are checked when executed; a blocked move is reported, not forced.` };
  },
  async run(i, t) {
    try {
      const o = await mustGet(t, "change_opportunity_stage", "opportunity", i.opportunityId, "id, name, row_version, stage");
      await moveStage(dealsCtx(t), o.id, Number(o.row_version), i.toStage, i.evidence);
      return { ok: true, summary: `${o.name}: ${o.stage} → ${i.toStage}`, data: { from: o.stage, to: i.toStage }, entities: [ref("opportunity", o.id, o.name, HREF.opportunity(o.id))] };
    } catch (e) {
      const nv = notVisible(e); if (nv) return nv;
      const reasons = (e as { details?: { reasons?: string[] } }).details?.reasons;
      return { ok: false, error: "stage_change_blocked", summary: `Stage change not made: ${reasons?.join("; ") ?? (e as Error).message}`, missing: reasons };
    }
  },
});

// ---------------------------------------------------------------------------------------------------- create opportunity
const createOpportunityTool = defineTool({
  id: "create_opportunity", module: "database", category: "C", minRole: "member",
  description: "Create a new deal/opportunity for a company or requirement (starts at qualified_discussion or earlier). Needs approval.",
  input: z.object({
    name: z.string().min(2).max(200), companyId: z.string().optional(), requirementId: z.string().optional(),
    stage: z.enum(["research", "approach_attempted", "engaged", "qualified_discussion"]).optional(),
    temperature: z.enum(["cold", "warm", "hot"]).optional(), nextAction: z.string().max(300).optional(),
    nextActionDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), expectedClose: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).refine((v) => v.companyId || v.requirementId, "companyId or requirementId required"),
  async plan(i, t) {
    const affected: EntityRef[] = [];
    if (i.companyId) { const o = await mustGet(t, "create_opportunity", "organisation", i.companyId, "id, display_name"); affected.push(ref("company", o.id, o.display_name, HREF.company(o.id))); }
    if (i.requirementId) { const r = await mustGet(t, "create_opportunity", "requirement", i.requirementId, "id, title"); affected.push(ref("requirement", r.id, r.title, HREF.requirement(r.id))); }
    const diff = [["name", i.name], ["stage", i.stage ?? "research"], ["temperature", i.temperature], ["next_action", i.nextAction], ["next_action_due", i.nextActionDue], ["expected_close", i.expectedClose]].filter(([, v]) => v !== undefined).map(([f, v]) => ({ field: String(f), before: null, after: v }));
    return { title: `Create opportunity "${i.name}"`, affected, diff, explanation: "A new deal record will be created and assigned to you." };
  },
  async run(i, t) {
    try {
      if (i.companyId) await mustGet(t, "create_opportunity", "organisation", i.companyId, "id");
      if (i.requirementId) await mustGet(t, "create_opportunity", "requirement", i.requirementId, "id");
      const o = (await createOpportunity(dealsCtx(t), { name: i.name, orgId: i.companyId ?? null, requirementId: i.requirementId ?? null, stage: i.stage, temperature: i.temperature ?? null, nextAction: i.nextAction ?? null, nextActionDue: i.nextActionDue ?? null, expectedClose: i.expectedClose ?? null })) as Row;
      return { ok: true, summary: `Created opportunity ${o.name}`, data: { opportunityId: o.id, href: HREF.opportunity(o.id) }, entities: [ref("opportunity", o.id, o.name, HREF.opportunity(o.id))] };
    } catch (e) { return notVisible(e) ?? failed("Could not create opportunity", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- archive
const ARCHIVE_TABLE = { company: "organisation", person: "person", building: "asset", requirement: "requirement", opportunity: "opportunity" } as const;
const LABEL_COL: Record<string, string> = { organisation: "display_name", person: "full_name", asset: "name", requirement: "title", opportunity: "name" };
const REF_TYPE = { company: "company", person: "person", building: "asset", requirement: "requirement", opportunity: "opportunity" } as const;
const HREF_OF: Record<string, (id: string) => string> = { company: HREF.company, person: HREF.person, building: HREF.asset, requirement: HREF.requirement, opportunity: HREF.opportunity };

const archiveRecord = defineTool({
  id: "archive_record", module: "database", category: "C", minRole: "member",
  description: "Archive (never delete) a company, person, building, requirement or opportunity. Needs approval here, and archiving is a material change, so it is then filed as a change proposal for Review. History is kept.",
  input: z.object({ entityType: z.enum(["company", "person", "building", "requirement", "opportunity"]), id: z.string(), reason: z.string().min(3).max(500) }),
  async plan(i, t) {
    const table = ARCHIVE_TABLE[i.entityType];
    const r = await mustGet(t, "archive_record", table, i.id, `id, archived_at, ${LABEL_COL[table]}`);
    return { title: `Archive ${i.entityType} ${r[LABEL_COL[table]]}`, affected: [ref(REF_TYPE[i.entityType], r.id, r[LABEL_COL[table]], HREF_OF[i.entityType](r.id))], diff: [{ field: "archived", before: r.archived_at ? "archived" : "active", after: "archived (after Review approval)" }], explanation: `${i.reason}. The record is archived, not deleted; it is filed as a change proposal for Review.` };
  },
  async run(i, t) {
    try {
      const table = ARCHIVE_TABLE[i.entityType];
      const r = await mustGet(t, "archive_record", table, i.id, `id, row_version, classification, archived_at, ${LABEL_COL[table]}`);
      let proposalId: string | null;
      if (table === "organisation" || table === "person" || table === "asset") proposalId = (await setArchived(db(t), ws(t), table, r.id, Number(r.row_version), true, `Assistant: ${i.reason}`)).proposalId;
      else proposalId = ((await proposeChange(db(t), ws(t), { targetType: table, targetId: r.id, operation: "archive", expectedVersion: Number(r.row_version), patch: [], reason: `Assistant: ${i.reason}`, proposedByKind: "user", classification: r.classification, idempotencyKey: `assistant:archive:${table}:${r.id}:${t.runId}` })) as Row).id;
      return { ok: true, summary: proposalId ? `Archive proposal filed for Review` : "Already archived", data: { proposalId }, entities: [ref(REF_TYPE[i.entityType], r.id, r[LABEL_COL[table]], HREF_OF[i.entityType](r.id))], blocks: [{ kind: "status", done: [], pending: proposalId ? ["Archive awaiting approval in Review (/approvals)"] : [], blocked: [] }] };
    } catch (e) { return notVisible(e) ?? failed("Archive failed", e); }
  },
});

// ---------------------------------------------------------------------------------------------------- prepare send
const prepareSend = defineTool({
  id: "prepare_send", module: "outreach", category: "C", minRole: "member",
  description: "Record the user's intent to send a prepared draft: approves the exact text + recipient and opens it for sending, returning a link to the user's OWN mail/WhatsApp/LinkedIn. CRE OS never sends anything; the user sends and then marks it sent. Needs approval.",
  input: z.object({ outreachId: z.string().optional().describe("Outreach item id (from generate_outreach_draft)"), draftId: z.string().optional().describe("Draft id (from /drafts)") }).refine((v) => v.outreachId || v.draftId, "outreachId or draftId required"),
  async plan(i, t) {
    const { draft, item } = await loadSendable(t, i);
    const names = await namesById(t, "person", [draft.recipient_person_id]);
    return {
      title: `Open ${draft.channel} to ${draft.recipient_display ?? names.get(draft.recipient_person_id) ?? "recipient"} for sending`,
      affected: [item ? ref("outreach", item.id, `${draft.channel} draft`, HREF.outreach(item.id)) : ref("outreach", draft.id, `${draft.channel} draft`, HREF.drafts())],
      diff: [{ field: "state", before: draft.state, after: "approved → opened for send (you send it yourself)" }, { field: "recipient", before: null, after: draft.recipient_address ?? draft.recipient_display }, { field: "subject", before: null, after: draft.subject }, { field: "text", before: null, after: String(draft.body ?? "").slice(0, 400) }],
      explanation: "Approving binds to this exact text and recipient; suppression is re-checked. Nothing is sent by CRE OS.",
    };
  },
  async run(i, t) {
    try {
      const { draft, item } = await loadSendable(t, i);
      let link: { href: string | null; copyText: string };
      if (item) {
        if (item.status !== "approved") await approveOutreach(db(t), ws(t), t.ctx.userId, item.id, draft.content_hash);
        link = await openForSend(db(t), ws(t), t.ctx.userId, item.id, draft.content_hash);
      } else {
        if (!["approved", "opened_for_send"].includes(draft.state)) await approveDraft(db(t), ws(t), draft.id, t.ctx.userId, { reviewedHash: draft.content_hash, note: "Approved via assistant" });
        link = await openDraftForSend(db(t), ws(t), draft.id, t.ctx.userId);
      }
      return {
        ok: true, summary: "Ready to send from your own app — CRE OS has not sent anything", data: { href: link.href, note: "After sending, mark it sent in Outreach/Drafts." },
        blocks: [...(link.href ? [{ kind: "download" as const, label: `Open in ${draft.channel}`, href: link.href }] : []), { kind: "status", done: ["Approved and opened for sending"], pending: ["You send it, then press 'I sent it'"], blocked: [] }],
      };
    } catch (e) { return notVisible(e) ?? failed("Could not prepare the send", e); }
  },
});

async function loadSendable(t: ToolContext, i: { outreachId?: string; draftId?: string }) {
  let item: Row | null = null; let draftId = i.draftId ?? null;
  if (i.outreachId) { item = await mustGet(t, "prepare_send", "outreach_item", i.outreachId, "id, status, draft_id"); draftId = item.draft_id; }
  if (!draftId) throw new Error("This outreach item has no message draft (call scripts cannot be sent).");
  await mustGet(t, "prepare_send", "draft", draftId, "id");
  const draft = (await getDraft(db(t), ws(t), draftId)) as unknown as Row;
  return { draft, item };
}

export const changeTools = [updateCompanyRecord, updateRequirementRecord, changeOpportunityStage, createOpportunityTool, archiveRecord, prepareSend];

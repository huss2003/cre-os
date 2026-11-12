import { sha256 } from "@/lib/util/crypto";
import { createTask } from "@/lib/services/tasks";
import { createDraft } from "@/lib/services/drafts";
import { localDate } from "@/lib/util/time";
import { TxError, q, txDbError, type TxCtx } from "./ctx";
import { record, TX_EVENTS } from "./events";
import { formatINR } from "@/lib/util/labels";
import {
  AGREED_STATUSES, COMMERCIAL_TERMS, DEFAULT_TEMPLATES, TERM_LABEL, TX_TYPES, canonical, cleanTerms, depositHeadline, depositStages, isOpenIssue, isOverdue,
  milestoneMatrix, waitingOn, type Terms,
} from "./model";
import { comparePackages, offerVersionDiffs, type StoredOffer } from "./negotiation";
import { diffAgreements, mentionsCommercialTerms, reconcile } from "./documents";
import { handOffExecutedLease } from "./lease-handoff";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB rows are untyped here
type Row = any;
const today = () => localDate(new Date());

// ================================================================================================ §2 / §3 transaction + plan
export interface NewTransaction {
  name: string; txType: string; requirementId?: string | null; opportunityId?: string | null; clientOrgId?: string | null; spaceIds?: string[];
  propertyLabels?: string[]; contactPersonIds?: string[]; ownerUserId?: string | null; priority?: string; expectedCompletion?: string | null; templateId?: string | null;
}

export async function stagesFor(ctx: TxCtx, txType: string, templateId?: string | null): Promise<{ key: string; title: string }[]> {
  if (templateId) {
    const t = await q(ctx.db.from("tx_stage_template").select("stages").eq("workspace_id", ctx.workspaceId).eq("id", templateId).maybeSingle(), "template");
    if (!t) throw new TxError(404, "template not found");
    return t.stages;
  }
  const t = await q(ctx.db.from("tx_stage_template").select("stages").eq("workspace_id", ctx.workspaceId).eq("tx_type", txType).eq("is_default", true).is("archived_at", null).limit(1).maybeSingle(), "template");
  if (t) return t.stages;
  const d = DEFAULT_TEMPLATES[txType];
  if (!d) throw new TxError(400, `no workflow template for transaction type "${txType}" — save one first`);
  return d;
}

/** Configurable template (§3.2): same architecture, custom stages; any type name allowed (§3.1 "additional types"). */
export async function saveTemplate(ctx: TxCtx, t: { txType: string; name: string; stages: string[]; isDefault?: boolean }) {
  const stages = t.stages.map((s) => s.trim()).filter(Boolean).map((title, i) => ({ key: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}` || `stage_${i + 1}`, title }));
  if (!stages.length) throw new TxError(400, "a template needs at least one stage");
  if (new Set(stages.map((s) => s.key)).size !== stages.length) throw new TxError(400, "stage names must be unique");
  if (t.isDefault) await ctx.db.from("tx_stage_template").update({ is_default: false }).eq("workspace_id", ctx.workspaceId).eq("tx_type", t.txType);
  return q(ctx.db.from("tx_stage_template").insert({ workspace_id: ctx.workspaceId, tx_type: t.txType, name: t.name, stages, is_default: !!t.isDefault }).select().single(), "template");
}

export async function createTransaction(ctx: TxCtx, t: NewTransaction) {
  if (!t.name?.trim()) throw new TxError(400, "name is required");
  if (!t.txType?.trim()) throw new TxError(400, "transaction type is required");
  const stages = await stagesFor(ctx, t.txType, t.templateId);
  let clientOrg = t.clientOrgId ?? null;
  if (t.requirementId) {
    const r = await q(ctx.db.from("requirement").select("id, org_id, status").eq("workspace_id", ctx.workspaceId).eq("id", t.requirementId).maybeSingle(), "requirement");
    if (!r) throw new TxError(404, "requirement not found");
    clientOrg = clientOrg ?? r.org_id;
  }
  if (t.opportunityId) {
    const o = await q(ctx.db.from("opportunity").select("id, org_id, requirement_id").eq("workspace_id", ctx.workspaceId).eq("id", t.opportunityId).maybeSingle(), "opportunity");
    if (!o) throw new TxError(404, "opportunity not found");
    clientOrg = clientOrg ?? o.org_id;
  }
  const code = `TX-${today().replace(/-/g, "").slice(2)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const tx = await q(ctx.db.from("tx_transaction").insert({
    workspace_id: ctx.workspaceId, code, name: t.name.trim(), tx_type: t.txType, priority: t.priority ?? "normal",
    requirement_id: t.requirementId ?? null, opportunity_id: t.opportunityId ?? null, client_org_id: clientOrg, space_ids: t.spaceIds ?? [],
    property_labels: t.propertyLabels ?? [], contact_person_ids: t.contactPersonIds ?? [], tx_owner_user_id: t.ownerUserId ?? ctx.userId,
    template_id: t.templateId ?? null, current_stage: stages[0].key, expected_completion: t.expectedCompletion ?? null,
  }).select().single(), "transaction");
  await q(ctx.db.from("tx_stage").insert(stages.map((s, i) => ({ workspace_id: ctx.workspaceId, transaction_id: tx.id, key: s.key, title: s.title, sort_order: i, status: i === 0 ? "in_progress" : "pending" }))), "stages");
  await record(ctx, tx.id, { kind: "created", summary: `Transaction ${code} created (${t.txType}) with ${stages.length}-stage plan`, subjectType: "tx_transaction", subjectId: tx.id });
  if (t.requirementId) await importClientRequirements(ctx, tx.id, t.requirementId);
  return tx as Row;
}

export async function getTransaction(ctx: TxCtx, id: string) {
  const tx = await q(ctx.db.from("tx_transaction").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "transaction");
  if (!tx) throw new TxError(404, "transaction not found");
  return tx as Row;
}

/** B4: "TX-261112-LBG00 — Name" + link for other modules (lease page). Null when not visible/unknown. */
export async function txLabel(ctx: TxCtx, id: string | null | undefined): Promise<{ id: string; code: string; name: string; label: string; href: string } | null> {
  if (!id) return null;
  const t = (await ctx.db.from("tx_transaction").select("id, code, name").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle()).data as { id: string; code: string; name: string } | null;
  return t ? { ...t, label: `${t.code} — ${t.name}`, href: `/transactions/${t.id}` } : null;
}

export async function listTransactions(ctx: TxCtx, opts: { status?: string; opportunityId?: string } = {}) {
  let s = ctx.db.from("tx_transaction").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("updated_at", { ascending: false }).limit(200);
  if (opts.status) s = s.eq("status", opts.status);
  if (opts.opportunityId) s = s.eq("opportunity_id", opts.opportunityId);
  return q<Row[]>(s, "transactions");
}

export async function advanceStage(ctx: TxCtx, txId: string, stageKey: string, status: "in_progress" | "done" | "skipped") {
  const st = await q(ctx.db.from("tx_stage").update({ status, completed_at: status === "done" ? new Date().toISOString() : null }).eq("workspace_id", ctx.workspaceId)
    .eq("transaction_id", txId).eq("key", stageKey).select().maybeSingle(), "stage");
  if (!st) throw new TxError(404, "stage not found");
  const stages = await q<Row[]>(ctx.db.from("tx_stage").select("key, status, sort_order").eq("transaction_id", txId).order("sort_order"), "stages");
  const next = stages.find((s) => s.status === "in_progress") ?? stages.find((s) => s.status === "pending");
  await q(ctx.db.from("tx_transaction").update({ current_stage: next?.key ?? stageKey }).eq("id", txId).eq("workspace_id", ctx.workspaceId), "transaction");
  await record(ctx, txId, { kind: "stage", summary: `Stage "${st.title}" → ${status}`, subjectType: "tx_stage", subjectId: st.id,
    event: TX_EVENTS.stageChanged, dedupe: `tx.stage:${st.id}:${status}:${st.row_version ?? st.completed_at ?? ""}`, payload: { stage: st.key, status } });
  return st;
}

// ================================================================================================ §6 positions
/** Client requirement positions come only from client-confirmed requirement fields (estimates are not instructions). */
export async function importClientRequirements(ctx: TxCtx, txId: string, requirementId: string) {
  const r = await q(ctx.db.from("requirement").select("*").eq("workspace_id", ctx.workspaceId).eq("id", requirementId).maybeSingle(), "requirement");
  if (!r) return [];
  const statuses: Record<string, string> = r.constraints?.field_status ?? {};
  const map: [string, string, unknown][] = [["budgetMax", "budget_max", r.budget_max], ["areaTarget", "area_target_sf", r.area_target_sf], ["occupationDate", "occupation_date", r.occupation_date], ["seatsTarget", "seats_target", r.seats_target]];
  const rows = map.filter(([, f, v]) => v !== null && v !== undefined && (statuses[f] ?? ((r.status === "confirmed" || r.status === "client_confirmed") ? "client_confirmed" : "")) === "client_confirmed")
    .map(([k, f, v]) => ({ workspace_id: ctx.workspaceId, transaction_id: txId, position_kind: "client_requirement", term_key: k, value: String(v), source: `requirement ${requirementId} field ${f} (client confirmed)` }));
  if (!rows.length) return [];
  return q<Row[]>(ctx.db.from("tx_position").insert(rows).select(), "positions");
}

export async function addPosition(ctx: TxCtx, txId: string, p: { kind: "client_requirement" | "adviser_recommendation" | "counterparty_proposal"; termKey: string; value: string | null; source: string; note?: string; offerId?: string }) {
  if (!p.source?.trim()) throw new TxError(400, "every position needs a source");
  const row = await q(ctx.db.from("tx_position").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, position_kind: p.kind, term_key: p.termKey, value: p.value, source: p.source, note: p.note ?? null, offer_id: p.offerId ?? null }).select().single(), "position");
  await record(ctx, txId, { kind: "position", summary: `${p.kind.replace(/_/g, " ")}: ${TERM_LABEL[p.termKey] ?? p.termKey} = ${p.value ?? "unknown"}`, subjectType: "tx_position", subjectId: row.id });
  return row;
}

/** Latest value per term for each of the three positions — kept in separate columns, never merged. */
export async function positionsView(ctx: TxCtx, txId: string) {
  const rows = await q<Row[]>(ctx.db.from("tx_position").select("*").eq("transaction_id", txId).is("archived_at", null).order("created_at"), "positions");
  const points = await q<Row[]>(ctx.db.from("tx_commercial_point").select("*").eq("transaction_id", txId).is("superseded_at", null).is("archived_at", null), "points");
  const terms = [...new Set([...rows.map((r) => r.term_key), ...points.map((p) => p.term_key)])];
  const latest = (kind: string, k: string) => [...rows].reverse().find((r) => r.position_kind === kind && r.term_key === k) ?? null;
  return terms.map((k) => {
    const agreed = points.find((p) => p.term_key === k && AGREED_STATUSES.includes(p.status));
    return { term: k, label: TERM_LABEL[k] ?? k, client: latest("client_requirement", k), adviser: latest("adviser_recommendation", k), counterparty: latest("counterparty_proposal", k), agreed: agreed ?? null };
  });
}

// ================================================================================================ §4 offers
export interface NewOffer {
  kind?: "offer" | "counteroffer" | "revised" | "final" | "agreed"; parentOfferId?: string | null; offeringParty: string; receivingParty: string; spaceId?: string | null;
  propertyLabel?: string | null; quoteId?: string | null; offerDate: string; validUntil?: string | null; terms: Terms; reason?: string | null; sourceDocument?: string | null;
}

export const offerHash = (terms: Terms, meta: { offeringParty: string; offerDate: string; validUntil?: string | null; parent?: string | null }) =>
  sha256(canonical({ terms: cleanTerms(terms), ...meta }));

/** Append-only: every offer/counteroffer is a new version; the parent's response becomes "countered". */
export async function createOffer(ctx: TxCtx, txId: string, o: NewOffer) {
  await getTransaction(ctx, txId);
  const terms = cleanTerms(o.terms);
  if (!Object.keys(terms).length) throw new TxError(400, "an offer needs at least one term");
  const prev = await q<Row[]>(ctx.db.from("tx_offer").select("id, version_no, response_status").eq("transaction_id", txId).order("version_no", { ascending: false }).limit(1), "offers");
  const version = (prev[0]?.version_no ?? 0) + 1;
  let kind = o.kind ?? (o.parentOfferId ? "counteroffer" : "offer");
  if (o.parentOfferId) {
    const parent = await q(ctx.db.from("tx_offer").select("id, transaction_id").eq("id", o.parentOfferId).maybeSingle(), "parent offer");
    if (!parent || parent.transaction_id !== txId) throw new TxError(400, "parent offer belongs to another transaction");
    if (kind === "counteroffer" && !o.reason?.trim()) throw new TxError(400, "a counteroffer needs the reason for the change");
  } else if (kind === "counteroffer") kind = "offer";
  const hash = offerHash(terms, { offeringParty: o.offeringParty, offerDate: o.offerDate, validUntil: o.validUntil ?? null, parent: o.parentOfferId ?? null });
  const row = await q(ctx.db.from("tx_offer").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, version_no: version, parent_offer_id: o.parentOfferId ?? null, kind, offering_party: o.offeringParty,
    receiving_party: o.receivingParty, space_id: o.spaceId ?? null, property_label: o.propertyLabel ?? null, quote_id: o.quoteId ?? null, offer_date: o.offerDate,
    valid_until: o.validUntil ?? null, terms, reason: o.reason ?? null, source_document: o.sourceDocument ?? null, content_hash: hash,
  }).select().single(), "offer");
  if (o.parentOfferId) await q(ctx.db.from("tx_offer").update({ response_status: "countered", responded_at: new Date().toISOString(), response_note: `countered by v${version}` }).eq("id", o.parentOfferId).eq("response_status", "pending"), "parent");
  const counterparty = ["landlord", "developer", "operator"].includes(o.offeringParty);
  if (counterparty) {
    await q(ctx.db.from("tx_position").insert(Object.entries(terms).map(([k, v]) => ({ workspace_id: ctx.workspaceId, transaction_id: txId, position_kind: "counterparty_proposal", term_key: k, value: String(v), source: `offer v${version} (${o.offeringParty})`, offer_id: row.id }))), "positions");
  } else if (o.offeringParty === "adviser") {
    await q(ctx.db.from("tx_position").insert(Object.entries(terms).map(([k, v]) => ({ workspace_id: ctx.workspaceId, transaction_id: txId, position_kind: "adviser_recommendation", term_key: k, value: String(v), source: `suggested counteroffer v${version}`, offer_id: row.id }))), "positions");
  }
  await syncPointsFromOffer(ctx, txId, row);
  const isCounter = kind === "counteroffer";
  await record(ctx, txId, {
    kind: isCounter ? "counteroffer" : "offer", summary: `${isCounter ? "Counteroffer" : "Offer"} v${version} from ${o.offeringParty}${o.reason ? ` — ${o.reason}` : ""}`,
    subjectType: "tx_offer", subjectId: row.id, event: isCounter ? TX_EVENTS.counterofferCreated : counterparty ? TX_EVENTS.offerReceived : TX_EVENTS.counterofferCreated,
    dedupe: `tx.offer:${row.id}`, payload: { version, offering_party: o.offeringParty },
  });
  return row as Row;
}

export async function respondToOffer(ctx: TxCtx, offerId: string, status: "accepted" | "rejected" | "withdrawn" | "expired", note: string) {
  if (!note?.trim()) throw new TxError(400, "record who responded and where (evidence)");
  const o = await q(ctx.db.from("tx_offer").update({ response_status: status, responded_at: new Date().toISOString(), response_note: note }).eq("workspace_id", ctx.workspaceId).eq("id", offerId).select().maybeSingle(), "offer");
  if (!o) throw new TxError(404, "offer not found");
  await record(ctx, o.transaction_id, { kind: "offer_response", summary: `Offer v${o.version_no} ${status}: ${note}`, subjectType: "tx_offer", subjectId: offerId });
  return o;
}

export async function listOffers(ctx: TxCtx, txId: string) {
  return q<Row[]>(ctx.db.from("tx_offer").select("*").eq("transaction_id", txId).order("version_no"), "offers");
}

/** §4.3 compare any selection of versions (toolkit diffs). */
export async function compareOfferVersions(ctx: TxCtx, txId: string, offerIds?: string[]) {
  const all = await listOffers(ctx, txId);
  const pick = offerIds?.length ? all.filter((o) => offerIds.includes(o.id)) : all;
  return offerVersionDiffs(pick as StoredOffer[]);
}

/** §5.2 compare two complete concession packages through the toolkit. */
export async function compareOfferPackages(ctx: TxCtx, txId: string, offerA: string, offerB: string, assumptions: Terms = {}) {
  const all = await listOffers(ctx, txId);
  const a = all.find((o) => o.id === offerA); const b = all.find((o) => o.id === offerB);
  if (!a || !b) throw new TxError(404, "offer not found in this transaction");
  return comparePackages(a as StoredOffer, b as StoredOffer, assumptions);
}

// ================================================================================================ §10.3 commercial points
async function syncPointsFromOffer(ctx: TxCtx, txId: string, offer: Row) {
  const points = await q<Row[]>(ctx.db.from("tx_commercial_point").select("*").eq("transaction_id", txId).is("superseded_at", null).is("archived_at", null), "points");
  for (const k of COMMERCIAL_TERMS) {
    const v = offer.terms[k]; if (v === undefined) continue;
    const open = points.find((p) => p.term_key === k && !AGREED_STATUSES.includes(p.status) && p.status !== "rejected");
    const agreed = points.find((p) => p.term_key === k && AGREED_STATUSES.includes(p.status));
    if (agreed && String(agreed.value) === String(v)) continue;
    if (open) {
      if (String(open.value) !== String(v)) {
        // a new proposal supersedes the open point (history kept), it never edits an agreed one
        await q(ctx.db.from("tx_commercial_point").update({ superseded_at: new Date().toISOString() }).eq("id", open.id), "point");
        await q(ctx.db.from("tx_commercial_point").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, term_key: k, label: TERM_LABEL[k] ?? k, value: String(v), status: "under_negotiation", source_offer_id: offer.id, supersedes_id: open.id }), "point");
      }
    } else {
      await q(ctx.db.from("tx_commercial_point").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, term_key: k, label: TERM_LABEL[k] ?? k, value: String(v), status: agreed ? "under_negotiation" : "proposed", source_offer_id: offer.id, supersedes_id: null }), "point");
    }
  }
}

export async function listPoints(ctx: TxCtx, txId: string, opts: { includeHistory?: boolean } = {}) {
  let s = ctx.db.from("tx_commercial_point").select("*").eq("transaction_id", txId).is("archived_at", null).order("term_key").order("created_at");
  if (!opts.includeHistory) s = s.is("superseded_at", null);
  return q<Row[]>(s, "points");
}

/** Status change with evidence. Agreeing a new value supersedes an earlier agreed point (never overwritten). */
export async function setPointStatus(ctx: TxCtx, pointId: string, status: string, opts: { evidence?: string; documentId?: string } = {}) {
  const p = await q(ctx.db.from("tx_commercial_point").select("*").eq("workspace_id", ctx.workspaceId).eq("id", pointId).maybeSingle(), "point");
  if (!p) throw new TxError(404, "point not found");
  if (p.superseded_at) throw new TxError(409, "this point was superseded — act on the current one");
  const patch: Row = { status };
  if (status === "agreed") patch.agreed_evidence = opts.evidence ?? null;
  if (status === "documented") patch.documented_in = opts.documentId ?? null;
  if (status === "verified_executed") {
    if (!opts.documentId) throw new TxError(400, "verification needs the executed agreement version");
    const d = await q(ctx.db.from("tx_document").select("doc_kind, status, body").eq("id", opts.documentId).maybeSingle(), "document");
    if (!d || (d.doc_kind !== "executed_agreement" && d.status !== "executed")) throw new TxError(400, "verification is only against an executed agreement");
    const rec = reconcile(d.body, [{ term_key: p.term_key, label: p.label, value: p.value }]);
    if (rec[0] && rec[0].status !== "match") throw new TxError(409, `executed agreement does not match the agreed ${p.label} (${rec[0].document ?? "not found"} vs ${p.value})`);
    patch.verified_in = opts.documentId;
  }
  if (status === "agreed") {
    const prior = await q<Row[]>(ctx.db.from("tx_commercial_point").select("id").eq("transaction_id", p.transaction_id).eq("term_key", p.term_key).is("superseded_at", null).neq("id", p.id).in("status", AGREED_STATUSES), "points");
    for (const x of prior) await q(ctx.db.from("tx_commercial_point").update({ superseded_at: new Date().toISOString() }).eq("id", x.id), "point");
  }
  const { data, error } = await ctx.db.from("tx_commercial_point").update(patch).eq("id", pointId).select().single();
  if (error) throw txDbError(error, "point");
  const material = AGREED_STATUSES.includes(status) || AGREED_STATUSES.includes(p.status);
  await record(ctx, p.transaction_id, {
    kind: "commercial_point", summary: `${p.label}: ${p.status} → ${status} (${p.value ?? "unknown"})${opts.evidence ? ` — ${opts.evidence}` : ""}`, subjectType: "tx_commercial_point", subjectId: pointId,
    event: material && p.is_material ? TX_EVENTS.materialTermChanged : undefined, dedupe: `tx.point:${pointId}:${status}:${data.row_version}`,
  });
  return data as Row;
}

export async function positionHash(ctx: TxCtx, txId: string): Promise<string> {
  const { data, error } = await ctx.db.schema("mudar_app").rpc("tx_position_hash", { p_tx: txId });
  if (error) throw txDbError(error, "position hash");
  return data as string;
}

// ================================================================================================ §7 issues
export interface NewIssue {
  title: string; description?: string; category: string; responsibleParty?: string; stakeholderId?: string | null; ownerUserId: string; priority?: string;
  dueDate?: string | null; noDueReason?: string | null; decisionRequired?: string; nextAction: string; blocking?: boolean; dependsOn?: string[]; supportingDocs?: string[]; status?: string;
}

export async function createIssue(ctx: TxCtx, txId: string, i: NewIssue) {
  if (!i.ownerUserId) throw new TxError(400, "every issue needs an internal owner");
  if (!i.nextAction?.trim()) throw new TxError(400, "every unresolved issue needs a next action");
  if (!i.dueDate && !i.noDueReason?.trim()) throw new TxError(400, "give a due date or record why no due date applies");
  const row = await q(ctx.db.from("tx_issue").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, title: i.title, description: i.description ?? null, category: i.category, responsible_party: i.responsibleParty ?? null,
    stakeholder_id: i.stakeholderId ?? null, internal_owner_user_id: i.ownerUserId, priority: i.priority ?? "normal", due_date: i.dueDate ?? null, no_due_reason: i.noDueReason ?? null,
    decision_required: i.decisionRequired ?? null, next_action: i.nextAction, blocking: !!i.blocking, depends_on: i.dependsOn ?? [], supporting_docs: i.supportingDocs ?? [], status: i.status ?? "open",
  }).select().single(), "issue");
  const task = await createTask(ctx.db, ctx.workspaceId, {
    title: `[${row.category}] ${i.nextAction}`, description: `Transaction issue: ${i.title}`, dueAt: i.dueDate ? `${i.dueDate}T12:30:00Z` : null, assignedUserId: i.ownerUserId,
    linkedEntityType: "tx_issue", linkedEntityId: row.id, source: "workflow", idempotencyKey: `tx.issue:${row.id}`, priority: i.blocking ? 80 : 50,
  });
  await q(ctx.db.from("tx_issue").update({ task_id: task.id }).eq("id", row.id), "issue");
  await record(ctx, txId, { kind: "issue", summary: `Issue raised: ${i.title}${i.blocking ? " (blocking)" : ""}`, subjectType: "tx_issue", subjectId: row.id });
  return { ...row, task_id: task.id } as Row;
}

export async function updateIssue(ctx: TxCtx, issueId: string, patch: { status?: string; nextAction?: string; dueDate?: string | null; noDueReason?: string | null; stakeholderId?: string | null; ownerUserId?: string; resolution?: string; blocking?: boolean; dependsOn?: string[] }) {
  const cur = await q(ctx.db.from("tx_issue").select("*").eq("workspace_id", ctx.workspaceId).eq("id", issueId).maybeSingle(), "issue");
  if (!cur) throw new TxError(404, "issue not found");
  const p: Row = {};
  if (patch.status !== undefined) p.status = patch.status;
  if (patch.nextAction !== undefined) p.next_action = patch.nextAction;
  if (patch.dueDate !== undefined) p.due_date = patch.dueDate;
  if (patch.noDueReason !== undefined) p.no_due_reason = patch.noDueReason;
  if (patch.stakeholderId !== undefined) p.stakeholder_id = patch.stakeholderId;
  if (patch.ownerUserId !== undefined) p.internal_owner_user_id = patch.ownerUserId;
  if (patch.resolution !== undefined) p.resolution = patch.resolution;
  if (patch.blocking !== undefined) p.blocking = patch.blocking;
  if (patch.dependsOn !== undefined) p.depends_on = patch.dependsOn;
  if (p.status && ["resolved", "closed"].includes(p.status)) p.resolved_at = new Date().toISOString();
  const { data, error } = await ctx.db.from("tx_issue").update(p).eq("id", issueId).eq("row_version", cur.row_version).select().maybeSingle();
  if (error) throw txDbError(error, "issue");
  if (!data) throw new TxError(409, "issue changed — reload");
  if (data.task_id && p.status && ["resolved", "closed"].includes(p.status)) await ctx.db.from("task").update({ status: "done", completion_evidence: patch.resolution ?? "issue resolved", completed_at: new Date().toISOString() }).eq("id", data.task_id);
  await record(ctx, cur.transaction_id, { kind: "issue_update", summary: `Issue "${cur.title}": ${Object.keys(p).join(", ")} updated${p.status ? ` (status ${cur.status} → ${p.status})` : ""}`, subjectType: "tx_issue", subjectId: issueId, payload: { before: { status: cur.status, next_action: cur.next_action, due_date: cur.due_date }, after: p } });
  return data as Row;
}

export async function issuesView(ctx: TxCtx, txId: string, asOf = today()) {
  const all = await q<Row[]>(ctx.db.from("tx_issue").select("*").eq("transaction_id", txId).is("archived_at", null).order("due_date", { nullsFirst: false }), "issues");
  const open = all.filter(isOpenIssue);
  return {
    open, overdue: open.filter((i) => isOverdue(i as any, asOf)), blocking: open.filter((i) => i.blocking),
    dependent: open.map((i) => ({ issue: i, waitingOn: waitingOn(i as any, all as any) })).filter((x) => x.waitingOn.length), resolved: all.filter((i) => !isOpenIssue(i)),
  };
}

// ================================================================================================ §8 inspections, clarifications, documents
export async function recordInspection(ctx: TxCtx, txId: string, i: { spaceId?: string | null; propertyLabel?: string; date: string; type: string; participants?: string[]; findings?: string; observations?: string; outstandingConcerns?: string; photos?: string[]; reportRef?: string; responsibleParty?: string; status?: string }) {
  const row = await q(ctx.db.from("tx_inspection").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, space_id: i.spaceId ?? null, property_label: i.propertyLabel ?? null, inspection_date: i.date, inspection_type: i.type,
    participants: i.participants ?? [], findings: i.findings ?? null, observations: i.observations ?? null, outstanding_concerns: i.outstandingConcerns ?? null,
    photos: (i.photos ?? []).map((p) => ({ ref: p })), report_ref: i.reportRef ?? null, responsible_party: i.responsibleParty ?? null, status: i.status ?? (i.outstandingConcerns ? "open" : "resolved"),
  }).select().single(), "inspection");
  await record(ctx, txId, { kind: "inspection", summary: `Inspection (${i.type}) on ${i.date}${i.outstandingConcerns ? ` — concerns: ${i.outstandingConcerns}` : ""}`, subjectType: "tx_inspection", subjectId: row.id });
  return row;
}

export async function requestClarification(ctx: TxCtx, txId: string, c: { topic: string; question: string; requiredValue?: string; requiredNumeric?: number | null; responsibleParty?: string }) {
  const row = await q(ctx.db.from("tx_clarification").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, topic: c.topic, question: c.question, required_value: c.requiredValue ?? null, required_numeric: c.requiredNumeric ?? null, responsible_party: c.responsibleParty ?? null }).select().single(), "clarification");
  await record(ctx, txId, { kind: "clarification", summary: `Clarification requested (${c.topic}): ${c.question}`, subjectType: "tx_clarification", subjectId: row.id });
  return row;
}

/** Compare the response with the client requirement: below a numeric minimum → discrepancy; text needs human acceptance. */
export function clarificationOutcome(c: { required_numeric: number | string | null; response_numeric: number | string | null; required_value: string | null; response: string | null }): "accepted" | "discrepancy" | "responded" {
  if (c.required_numeric !== null && c.required_numeric !== undefined) {
    if (c.response_numeric === null || c.response_numeric === undefined) return "responded";
    return Number(c.response_numeric) >= Number(c.required_numeric) ? "accepted" : "discrepancy";
  }
  return "responded";
}

export async function respondClarification(ctx: TxCtx, id: string, r: { response: string; responseNumeric?: number | null; attachments?: string[] }) {
  const cur = await q(ctx.db.from("tx_clarification").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "clarification");
  if (!cur) throw new TxError(404, "clarification not found");
  const status = clarificationOutcome({ ...cur, response: r.response, response_numeric: r.responseNumeric ?? null });
  const row = await q(ctx.db.from("tx_clarification").update({ response: r.response, response_numeric: r.responseNumeric ?? null, responded_at: new Date().toISOString(), attachments: r.attachments ?? cur.attachments, status }).eq("id", id).select().single(), "clarification");
  await record(ctx, cur.transaction_id, { kind: "clarification_response", summary: `${cur.topic}: response "${r.response}" → ${status}`, subjectType: "tx_clarification", subjectId: id });
  return row;
}

export async function requestDocument(ctx: TxCtx, txId: string, d: { docType: string; title: string; responsibleParty?: string; dueDate?: string | null }) {
  const row = await q(ctx.db.from("tx_doc_request").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, doc_type: d.docType, title: d.title, responsible_party: d.responsibleParty ?? null, due_date: d.dueDate ?? null }).select().single(), "document request");
  await record(ctx, txId, { kind: "doc_request", summary: `Document requested: ${d.title}`, subjectType: "tx_doc_request", subjectId: row.id });
  return row;
}

/** Uploading/receiving never verifies (§8.3). */
export async function markDocumentReceived(ctx: TxCtx, id: string, fileRef: string, receivedOn = today()) {
  const row = await q(ctx.db.from("tx_doc_request").update({ status: "received", received_on: receivedOn, file_ref: fileRef }).eq("workspace_id", ctx.workspaceId).eq("id", id).select().single(), "document request");
  await record(ctx, row.transaction_id, { kind: "doc_received", summary: `Document received (not verified): ${row.title}`, subjectType: "tx_doc_request", subjectId: id });
  return row;
}

export async function verifyDocument(ctx: TxCtx, id: string, note: string) {
  const cur = await q(ctx.db.from("tx_doc_request").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "document request");
  if (!cur) throw new TxError(404, "document request not found");
  if (!cur.received_on) throw new TxError(409, "a document must be received before it can be verified");
  const row = await q(ctx.db.from("tx_doc_request").update({ status: "verified", verified_by: ctx.userId, verified_at: new Date().toISOString(), verification_note: note }).eq("id", id).select().single(), "document request");
  await record(ctx, cur.transaction_id, { kind: "doc_verified", summary: `Document verified: ${cur.title} — ${note}`, subjectType: "tx_doc_request", subjectId: id });
  return row;
}

// ================================================================================================ §9 stakeholders
export async function addStakeholder(ctx: TxCtx, txId: string, s: { name: string; category: string; organisation?: string; designation?: string; role?: string; contact?: string; responsibilities?: string; decisionAuthority?: string; isInternal?: boolean; personId?: string | null; userId?: string | null }) {
  const row = await q(ctx.db.from("tx_stakeholder").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, name: s.name, category: s.category, organisation: s.organisation ?? null, designation: s.designation ?? null, role: s.role ?? null,
    contact: s.contact ?? null, responsibilities: s.responsibilities ?? null, decision_authority: s.decisionAuthority ?? "none", is_internal: s.isInternal ?? s.category === "internal_team",
    person_id: s.personId ?? null, user_id: s.userId ?? null,
  }).select().single(), "stakeholder");
  await record(ctx, txId, { kind: "stakeholder", summary: `Stakeholder added: ${s.name} (${s.category})`, subjectType: "tx_stakeholder", subjectId: row.id });
  return row;
}

/** Pending action for a stakeholder = an internal task linked to that stakeholder (external parties are never messaged automatically). */
export async function assignStakeholderTask(ctx: TxCtx, txId: string, stakeholderId: string, t: { title: string; dueDate?: string | null; ownerUserId?: string }) {
  const s = await q(ctx.db.from("tx_stakeholder").select("id, name, transaction_id").eq("id", stakeholderId).maybeSingle(), "stakeholder");
  if (!s || s.transaction_id !== txId) throw new TxError(404, "stakeholder not found on this transaction");
  const task = await createTask(ctx.db, ctx.workspaceId, { title: `${s.name}: ${t.title}`, dueAt: t.dueDate ? `${t.dueDate}T12:30:00Z` : null, assignedUserId: t.ownerUserId ?? ctx.userId, linkedEntityType: "tx_stakeholder", linkedEntityId: stakeholderId, source: "workflow" });
  await record(ctx, txId, { kind: "stakeholder_task", summary: `Pending action for ${s.name}: ${t.title}`, subjectType: "tx_stakeholder", subjectId: stakeholderId });
  return task;
}

export async function stakeholdersView(ctx: TxCtx, txId: string, asOf = today()) {
  const [st, issues, approvals] = await Promise.all([
    q<Row[]>(ctx.db.from("tx_stakeholder").select("*").eq("transaction_id", txId).is("archived_at", null).order("created_at"), "stakeholders"),
    q<Row[]>(ctx.db.from("tx_issue").select("*").eq("transaction_id", txId).is("archived_at", null), "issues"),
    q<Row[]>(ctx.db.from("tx_approval").select("*").eq("transaction_id", txId).is("invalidated_at", null).in("status", ["pending", "under_review", "changes_requested"]), "approvals"),
  ]);
  const ids = st.map((s) => s.id);
  const tasks = ids.length ? await q<Row[]>(ctx.db.from("task").select("id, title, due_at, status, linked_entity_id").eq("workspace_id", ctx.workspaceId).eq("linked_entity_type", "tx_stakeholder").in("linked_entity_id", ids).eq("status", "open"), "tasks") : [];
  return st.map((s) => {
    const sIssues = issues.filter((i) => i.stakeholder_id === s.id && isOpenIssue(i));
    const sApprovals = approvals.filter((a) => a.reviewer_stakeholder_id === s.id || (s.user_id && a.reviewer_user_id === s.user_id));
    const blocking = sIssues.some((i) => i.blocking || isOverdue(i as any, asOf)) || sApprovals.some((a) => a.deadline && a.deadline < asOf);
    return <Row>{ ...s, pendingTasks: tasks.filter((t) => t.linked_entity_id === s.id), openIssues: sIssues, pendingApprovals: sApprovals, isDecisionMaker: ["approver", "signatory"].includes(s.decision_authority), blocking };
  });
}

// ================================================================================================ §10 / §11 documents
export async function addDocumentVersion(ctx: TxCtx, txId: string, d: { docKind: "loi" | "term_sheet" | "agreement" | "executed_agreement" | "handover" | "other"; family?: string; title: string; body: string; fileRef?: string; status?: string; source?: string }) {
  const family = d.family ?? (d.docKind === "executed_agreement" ? "agreement" : d.docKind);
  const prev = await q<Row[]>(ctx.db.from("tx_document").select("*").eq("transaction_id", txId).eq("family", family).order("version_no", { ascending: false }).limit(1), "documents");
  const p = prev[0];
  const hash = sha256(d.body);
  if (p && p.sha256 === hash) throw new TxError(409, "this version is identical to the previous one");
  const agreed = (await listPoints(ctx, txId)).filter((x) => AGREED_STATUSES.includes(x.status));
  const diff = p ? diffAgreements(p.body, d.body) : null;
  const rec = reconcile(d.body, agreed);
  const row = await q(ctx.db.from("tx_document").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, doc_kind: d.docKind, family, version_no: (p?.version_no ?? 0) + 1, previous_id: p?.id ?? null, title: d.title, body: d.body, sha256: hash,
    file_ref: d.fileRef ?? null, status: d.status ?? (d.docKind === "executed_agreement" ? "executed" : "draft"), diff_report: diff, reconciliation: rec, source: d.source ?? "upload",
  }).select().single(), "document");
  // approvals of the previous version were invalidated by the DB trigger → open reassessments on the new version
  if (p) {
    const old = await q<Row[]>(ctx.db.from("tx_approval").select("*").eq("subject_type", "document").eq("subject_id", p.id).not("invalidated_at", "is", null).is("archived_at", null), "approvals");
    for (const a of old.filter((x) => ["pending", "under_review", "approved", "changes_requested"].includes(x.status))) {
      await q(ctx.db.from("tx_approval").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, category: a.category, subject_type: "document", subject_id: row.id, subject_hash: hash, version_label: `${row.title} v${row.version_no}`, reviewer_user_id: a.reviewer_user_id, reviewer_stakeholder_id: a.reviewer_stakeholder_id, deadline: a.deadline, reassessment_of: a.id, status: "pending", owner_user_id: a.reviewer_user_id ?? ctx.userId }), "reassessment");
    }
  }
  const mismatches = rec.filter((r) => r.status === "mismatch");
  await record(ctx, txId, {
    kind: "document_version", summary: `${d.docKind} "${d.title}" v${row.version_no}${diff ? ` — ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.modified} modified` : ""}${mismatches.length ? `; ${mismatches.length} mismatch(es) vs agreed terms` : ""}`,
    subjectType: "tx_document", subjectId: row.id, event: p ? TX_EVENTS.documentVersionChanged : undefined, dedupe: `tx.doc:${row.id}`, payload: { mismatches: mismatches.map((m) => m.key) },
  });
  if (mismatches.length) await record(ctx, txId, { kind: "material_change", summary: `Agreement differs from agreed terms: ${mismatches.map((m) => `${m.label} ${m.agreed}→${m.document}`).join(", ")}`, subjectType: "tx_document", subjectId: row.id, event: TX_EVENTS.materialTermChanged, dedupe: `tx.doc.mismatch:${row.id}` });
  return row as Row;
}

export async function setDocumentStatus(ctx: TxCtx, docId: string, status: string, signingStatus?: string) {
  const cur = await q(ctx.db.from("tx_document").select("*").eq("workspace_id", ctx.workspaceId).eq("id", docId).maybeSingle(), "document");
  if (!cur) throw new TxError(404, "document not found");
  if (cur.status === "superseded") throw new TxError(409, "superseded version — act on the latest");
  if (status === "signed" || signingStatus === "signed") {
    const live = await liveApproval(ctx, cur.transaction_id, "document", docId, cur.sha256, ["client_commercial", "legal"]);
    if (!live.ok) throw new TxError(409, `cannot record as signed: ${live.missing.join(", ")} approval of this exact version is missing`);
  }
  const row = await q(ctx.db.from("tx_document").update({ status, ...(signingStatus ? { signing_status: signingStatus } : {}) }).eq("id", docId).select().single(), "document");
  await record(ctx, cur.transaction_id, { kind: "document_status", summary: `${cur.doc_kind} v${cur.version_no}: ${cur.status} → ${status}${signingStatus ? ` (${signingStatus})` : ""}`, subjectType: "tx_document", subjectId: docId });
  return row;
}

export async function documentComparison(ctx: TxCtx, docId: string, againstId?: string) {
  const d = await q(ctx.db.from("tx_document").select("*").eq("workspace_id", ctx.workspaceId).eq("id", docId).maybeSingle(), "document");
  if (!d) throw new TxError(404, "document not found");
  const otherId = againstId ?? d.previous_id;
  const o = otherId ? await q(ctx.db.from("tx_document").select("*").eq("id", otherId).maybeSingle(), "document") : null;
  const agreed = (await listPoints(ctx, d.transaction_id)).filter((x) => AGREED_STATUSES.includes(x.status));
  return { document: d, against: o, diff: o ? diffAgreements(o.body, d.body) : null, reconciliation: reconcile(d.body, agreed) };
}

// ================================================================================================ §12 approvals
async function currentHash(ctx: TxCtx, txId: string, subjectType: string, subjectId: string): Promise<{ hash: string; label: string }> {
  if (subjectType === "offer") {
    const o = await q(ctx.db.from("tx_offer").select("content_hash, version_no, kind").eq("id", subjectId).maybeSingle(), "offer");
    if (!o) throw new TxError(404, "offer not found");
    return { hash: o.content_hash, label: `${o.kind} v${o.version_no}` };
  }
  if (subjectType === "document") {
    const d = await q(ctx.db.from("tx_document").select("sha256, version_no, title, status").eq("id", subjectId).maybeSingle(), "document");
    if (!d) throw new TxError(404, "document not found");
    if (d.status === "superseded") throw new TxError(409, "superseded version — request approval of the latest");
    return { hash: d.sha256, label: `${d.title} v${d.version_no}` };
  }
  if (subjectType === "commercial_position") {
    if (subjectId !== txId) throw new TxError(400, "commercial position subject is the transaction itself");
    const pts = (await listPoints(ctx, txId)).filter((x) => AGREED_STATUSES.includes(x.status));
    if (!pts.length) throw new TxError(409, "no agreed commercial points to approve yet");
    return { hash: await positionHash(ctx, txId), label: `commercial position (${pts.length} points)` };
  }
  if (subjectType === "deposit") {
    const d = await q(ctx.db.from("tx_deposit").select("*").eq("id", subjectId).maybeSingle(), "deposit");
    if (!d) throw new TxError(404, "deposit not found");
    return { hash: sha256(canonical({ type: d.deposit_type, amount: d.amount, due: d.due_date, refundable: d.refundable, cond: d.refund_conditions })), label: `${d.deposit_type} ₹${d.amount ?? "unknown"}` };
  }
  return { hash: sha256(`${subjectType}:${subjectId}`), label: subjectType };
}

export async function requestApproval(ctx: TxCtx, txId: string, a: { category: string; subjectType: string; subjectId: string; reviewerUserId?: string | null; reviewerStakeholderId?: string | null; deadline?: string | null; supporting?: string[] }) {
  const { hash, label } = await currentHash(ctx, txId, a.subjectType, a.subjectId);
  const row = await q(ctx.db.from("tx_approval").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, category: a.category, subject_type: a.subjectType, subject_id: a.subjectId, subject_hash: hash, version_label: label,
    reviewer_user_id: a.reviewerUserId ?? null, reviewer_stakeholder_id: a.reviewerStakeholderId ?? null, deadline: a.deadline ?? null, supporting: a.supporting ?? [],
    owner_user_id: a.reviewerUserId ?? ctx.userId, // the reviewer owns (sees and decides) the approval
  }).select().single(), "approval");
  if (a.reviewerUserId) await createTask(ctx.db, ctx.workspaceId, { title: `Review (${a.category.replace(/_/g, " ")}): ${label}`, dueAt: a.deadline ? `${a.deadline}T12:30:00Z` : null, assignedUserId: a.reviewerUserId, linkedEntityType: "tx_approval", linkedEntityId: row.id, source: "workflow", idempotencyKey: `tx.approval:${row.id}` });
  await record(ctx, txId, { kind: "approval_requested", summary: `${a.category} approval requested for ${label}`, subjectType: "tx_approval", subjectId: row.id, event: TX_EVENTS.approvalPending, dedupe: `tx.approval:${row.id}` });
  return row as Row;
}

/** Human decision by the assigned reviewer on the exact version they saw (reviewedHash). AI never calls this. */
export async function decideApproval(ctx: TxCtx, approvalId: string, d: { decision: "approved" | "rejected" | "changes_requested" | "under_review" | "withdrawn"; reviewedHash: string; comments?: string }) {
  const a = await q(ctx.db.from("tx_approval").select("*").eq("workspace_id", ctx.workspaceId).eq("id", approvalId).maybeSingle(), "approval");
  if (!a) throw new TxError(404, "approval not found");
  if (a.invalidated_at) throw new TxError(409, `approval invalidated (${a.invalidated_reason}) — review the latest version`);
  if (d.reviewedHash !== a.subject_hash) throw new TxError(409, "you reviewed a different version than the one this approval is bound to");
  const isDecision = ["approved", "rejected", "changes_requested"].includes(d.decision);
  const { data, error } = await ctx.db.from("tx_approval").update({
    status: d.decision, comments: d.comments ?? a.comments, ...(isDecision ? { decided_by: ctx.userId, decided_by_kind: "user", decision_on: new Date().toISOString() } : {}),
  }).eq("id", approvalId).eq("row_version", a.row_version).select().maybeSingle();
  if (error) throw txDbError(error, "approval");
  if (!data) throw new TxError(409, "approval changed — reload");
  await ctx.db.from("task").update({ status: "done", completion_evidence: `approval ${d.decision}`, completed_at: new Date().toISOString() }).eq("workspace_id", ctx.workspaceId).eq("idempotency_key", `tx.approval:${approvalId}`).eq("status", "open");
  await record(ctx, a.transaction_id, { kind: "approval_decision", summary: `${a.category} approval of ${a.version_label}: ${d.decision}${d.comments ? ` — ${d.comments}` : ""}`, subjectType: "tx_approval", subjectId: approvalId });
  return data as Row;
}

/** Counterparty/client decisions received outside the system are recorded with evidence (never for legal/internal). */
export async function recordExternalDecision(ctx: TxCtx, approvalId: string, d: { decision: "approved" | "rejected" | "changes_requested"; evidence: string }) {
  const a = await q(ctx.db.from("tx_approval").select("*").eq("workspace_id", ctx.workspaceId).eq("id", approvalId).maybeSingle(), "approval");
  if (!a) throw new TxError(404, "approval not found");
  const { data, error } = await ctx.db.from("tx_approval").update({ status: d.decision, comments: d.evidence, decided_by: ctx.userId, decided_by_kind: "external_recorded", decision_on: new Date().toISOString() }).eq("id", approvalId).select().single();
  if (error) throw txDbError(error, "approval");
  await record(ctx, a.transaction_id, { kind: "approval_decision", summary: `${a.category} decision recorded from counterparty/client: ${d.decision} — ${d.evidence}`, subjectType: "tx_approval", subjectId: approvalId });
  return data as Row;
}

/** Live = approved, not invalidated, and bound to the subject's current hash. */
export async function liveApproval(ctx: TxCtx, txId: string, subjectType: string, subjectId: string, hash: string, categories: string[]) {
  const rows = await q<Row[]>(ctx.db.from("tx_approval").select("category, status, subject_hash, invalidated_at").eq("transaction_id", txId).eq("subject_type", subjectType).eq("subject_id", subjectId).eq("status", "approved").is("invalidated_at", null), "approvals");
  const missing = categories.filter((c) => !rows.some((r) => r.category === c && r.subject_hash === hash));
  return { ok: missing.length === 0, missing };
}

export async function listApprovals(ctx: TxCtx, txId: string) {
  return q<Row[]>(ctx.db.from("tx_approval").select("*").eq("transaction_id", txId).is("archived_at", null).order("created_at"), "approvals");
}

// ================================================================================================ §12.4 communications
/**
 * Draft an external message (S3: drafts only, manual send). A message that communicates commercial terms needs a live
 * client-commercial approval of the current commercial position, and every figure it states must be an approved value.
 */
export async function draftCommunication(ctx: TxCtx, txId: string, m: { channel?: "email" | "whatsapp"; recipientDisplay?: string; recipientAddress?: string; recipientPersonId?: string | null; subject?: string; body: string }) {
  const tx = await getTransaction(ctx, txId);
  if (mentionsCommercialTerms(`${m.subject ?? ""}\n${m.body}`)) {
    const pts = (await listPoints(ctx, txId)).filter((x) => AGREED_STATUSES.includes(x.status));
    if (!pts.length) throw new TxError(409, "unapproved commercial commitment: no agreed commercial position exists — the message cannot state commercial terms");
    const h = await positionHash(ctx, txId);
    const live = await liveApproval(ctx, txId, "commercial_position", txId, h, ["client_commercial"]);
    if (!live.ok) throw new TxError(409, "unapproved commercial commitment: the current commercial position has no live client commercial approval");
    const figures = [...`${m.subject ?? ""} ${m.body}`.matchAll(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(?:%|months?|\/\s*sf|per\s*sf|sf\b)/gi)]
      .map((x) => (x[1] ?? x[2]).replace(/,/g, "")).filter((x) => x.length);
    const approvedValues = new Set(pts.map((p) => String(Number(p.value))));
    const stray = figures.filter((f) => !approvedValues.has(String(Number(f))));
    if (stray.length) throw new TxError(409, `unapproved commercial commitment: figure(s) ${[...new Set(stray)].join(", ")} are not in the approved commercial position`);
  }
  const draft = await createDraft(ctx.db, ctx.workspaceId, {
    channel: m.channel ?? "email", recipientDisplay: m.recipientDisplay ?? null, recipientAddress: m.recipientAddress ?? null, recipientPersonId: m.recipientPersonId ?? null,
    subject: m.subject ?? null, body: m.body, opportunityId: tx.opportunity_id ?? null, orgId: tx.client_org_id ?? null, purpose: `transaction:${txId}`, createdByKind: "user", ownerUserId: ctx.userId,
  } as any);
  await record(ctx, txId, { kind: "communication_draft", summary: `Message drafted for human review and manual send: ${m.subject ?? m.body.slice(0, 60)}`, subjectType: "draft", subjectId: draft.id });
  return draft;
}

// ================================================================================================ §13 deposits
export async function recordDeposit(ctx: TxCtx, txId: string, d: { depositType: string; amount?: number | null; responsibleParty?: string; proposedOn?: string | null; dueDate?: string | null; refundable?: boolean | null; refundConditions?: string }) {
  const row = await q(ctx.db.from("tx_deposit").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, deposit_type: d.depositType, amount: d.amount ?? null, responsible_party: d.responsibleParty ?? null, proposed_on: d.proposedOn ?? today(), due_date: d.dueDate ?? null, refundable: d.refundable ?? null, refund_conditions: d.refundConditions ?? null }).select().single(), "deposit");
  await record(ctx, txId, { kind: "deposit", summary: `Deposit proposed: ${d.depositType} ${formatINR(d.amount)}`, subjectType: "tx_deposit", subjectId: row.id });
  return row;
}

export async function updateDepositStage(ctx: TxCtx, id: string, stage: "approved" | "due" | "paid" | "acknowledged" | "refunded", v: { date: string; evidence?: string; receiptRef?: string; approvalId?: string }) {
  const cur = await q(ctx.db.from("tx_deposit").select("*").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle(), "deposit");
  if (!cur) throw new TxError(404, "deposit not found");
  const p: Row = {};
  if (stage === "approved") { p.approved_on = v.date; p.approval_id = v.approvalId ?? null; }
  if (stage === "due") p.due_date = v.date;
  if (stage === "paid") { if (!v.evidence?.trim()) throw new TxError(400, "payment needs supporting evidence"); p.paid_on = v.date; p.payment_evidence = v.evidence; }
  if (stage === "acknowledged") { p.acknowledged_on = v.date; p.receipt_ref = v.receiptRef ?? null; }
  if (stage === "refunded") { p.refunded_on = v.date; p.refund_evidence = v.evidence ?? null; }
  const { data, error } = await ctx.db.from("tx_deposit").update(p).eq("id", id).select().single();
  if (error) throw txDbError(error, "deposit");
  await record(ctx, cur.transaction_id, { kind: "deposit", summary: `Deposit ${cur.deposit_type}: ${stage} on ${v.date} — now "${depositHeadline(data, today())}"`, subjectType: "tx_deposit", subjectId: id });
  return data as Row;
}

export async function depositsView(ctx: TxCtx, txId: string, asOf = today()) {
  const rows = await q<Row[]>(ctx.db.from("tx_deposit").select("*").eq("transaction_id", txId).is("archived_at", null), "deposits");
  return rows.map((r) => ({ ...r, stages: depositStages(r as any, asOf), headline: depositHeadline(r as any, asOf) }) as Row);
}

// ================================================================================================ §13.2 / §14 milestones, fit-out, handover
export async function setMilestone(ctx: TxCtx, txId: string, kind: string, m: { expectedOn?: string | null; achievedOn?: string | null; evidence?: string; documentId?: string | null; conditions?: string; outstandingConditions?: string; details?: Row }) {
  if (m.achievedOn && !m.evidence?.trim()) throw new TxError(400, "an achieved milestone needs evidence");
  if (kind === "executed" && m.achievedOn) {
    if (!m.documentId) throw new TxError(400, "execution needs the executed agreement version");
    const d = await q(ctx.db.from("tx_document").select("doc_kind, status, transaction_id").eq("id", m.documentId).maybeSingle(), "document");
    if (!d || d.transaction_id !== txId || (d.doc_kind !== "executed_agreement" && d.status !== "executed")) throw new TxError(400, "execution needs an executed agreement of this transaction");
  }
  if (kind === "legally_approved" && m.achievedOn) {
    const ok = await q<Row[]>(ctx.db.from("tx_approval").select("id").eq("transaction_id", txId).eq("category", "legal").eq("status", "approved").is("invalidated_at", null).eq("decided_by_kind", "user"), "approvals");
    if (!ok.length) throw new TxError(409, "legal approval can only come from a legal reviewer's decision in the approvals list");
  }
  const existing = await q(ctx.db.from("tx_milestone").select("*").eq("transaction_id", txId).eq("kind", kind).maybeSingle(), "milestone");
  const row: Row = { workspace_id: ctx.workspaceId, transaction_id: txId, kind };
  if (m.expectedOn !== undefined) row.expected_on = m.expectedOn;
  if (m.achievedOn !== undefined) row.achieved_on = m.achievedOn;
  if (m.evidence !== undefined) row.evidence = m.evidence;
  if (m.documentId !== undefined) row.document_id = m.documentId;
  if (m.conditions !== undefined) row.conditions = m.conditions;
  if (m.outstandingConditions !== undefined) row.outstanding_conditions = m.outstandingConditions;
  if (m.details !== undefined) row.details = m.details;
  const saved = existing
    ? await q(ctx.db.from("tx_milestone").update(row).eq("id", existing.id).select().single(), "milestone")
    : await q(ctx.db.from("tx_milestone").insert(row).select().single(), "milestone");
  const achievedNow = !!m.achievedOn && !existing?.achieved_on;
  await record(ctx, txId, {
    kind: `milestone:${kind}`, summary: `${kind.replace(/_/g, " ")}: ${m.achievedOn ? `achieved ${m.achievedOn} (${m.evidence})` : `expected ${m.expectedOn ?? "—"}`}`, subjectType: "tx_milestone", subjectId: saved.id,
    event: kind === "executed" && achievedNow ? TX_EVENTS.executed : undefined, dedupe: `tx.executed:${txId}`,
  });
  if (kind === "executed" && achievedNow) await handOffExecutedLease(ctx, txId);
  return saved as Row;
}

export async function saveFitout(ctx: TxCtx, txId: string, f: Row) {
  const existing = await q(ctx.db.from("tx_fitout").select("id").eq("transaction_id", txId).is("archived_at", null).maybeSingle(), "fitout");
  const row = { workspace_id: ctx.workspaceId, transaction_id: txId, ...f };
  const saved = existing ? await q(ctx.db.from("tx_fitout").update(row).eq("id", existing.id).select().single(), "fitout") : await q(ctx.db.from("tx_fitout").insert(row).select().single(), "fitout");
  await record(ctx, txId, { kind: "fitout", summary: `Fit-out updated: progress ${saved.progress_pct ?? "unknown"}%${saved.delays ? `, delays: ${saved.delays}` : ""}`, subjectType: "tx_fitout", subjectId: saved.id });
  return saved;
}

export const HANDOVER_CHECKLIST = ["Keys / access cards received", "Meter readings recorded", "Fire NOC and safety systems demonstrated", "HVAC commissioned", "Power and DG backup tested", "As-built drawings received", "Snag list agreed", "Handover certificate signed"];

export async function generateHandoverChecklist(ctx: TxCtx, txId: string) {
  const have = await q<Row[]>(ctx.db.from("tx_handover_item").select("description").eq("transaction_id", txId).eq("item_kind", "checklist"), "handover");
  const rows = HANDOVER_CHECKLIST.filter((d) => !have.some((h) => h.description === d)).map((description) => ({ workspace_id: ctx.workspaceId, transaction_id: txId, item_kind: "checklist", description }));
  if (rows.length) await q(ctx.db.from("tx_handover_item").insert(rows), "handover");
  return q<Row[]>(ctx.db.from("tx_handover_item").select("*").eq("transaction_id", txId).order("created_at"), "handover");
}

export async function addHandoverItem(ctx: TxCtx, txId: string, h: { kind: "defect" | "incomplete_work" | "observation" | "checklist"; description: string; responsibleParty?: string; resolutionDeadline?: string | null; photos?: string[] }) {
  const row = await q(ctx.db.from("tx_handover_item").insert({ workspace_id: ctx.workspaceId, transaction_id: txId, item_kind: h.kind, description: h.description, responsible_party: h.responsibleParty ?? null, resolution_deadline: h.resolutionDeadline ?? null, photos: (h.photos ?? []).map((p) => ({ ref: p })) }).select().single(), "handover");
  await record(ctx, txId, { kind: "handover", summary: `Handover ${h.kind.replace("_", " ")}: ${h.description}`, subjectType: "tx_handover_item", subjectId: row.id });
  return row;
}

export async function closeHandoverItem(ctx: TxCtx, id: string, evidence: string, acknowledgedBy?: string, status: "done" | "waived" = "done") {
  const row = await q(ctx.db.from("tx_handover_item").update({ status, evidence, acknowledged_by: acknowledgedBy ?? null }).eq("workspace_id", ctx.workspaceId).eq("id", id).select().single(), "handover");
  await record(ctx, row.transaction_id, { kind: "handover", summary: `Handover item ${status}: ${row.description} — ${evidence}`, subjectType: "tx_handover_item", subjectId: id });
  return row;
}

// ================================================================================================ §16 completion
export async function closureBlockers(ctx: TxCtx, txId: string): Promise<string[]> {
  const { data, error } = await ctx.db.schema("mudar_app").rpc("tx_closure_blockers", { p_tx: txId });
  if (error) throw txDbError(error, "closure");
  return (data as string[]) ?? [];
}

export async function completeTransaction(ctx: TxCtx, txId: string) {
  const b = await closureBlockers(ctx, txId);
  if (b.length) throw new TxError(409, `cannot complete: ${b.join("; ")}`, b);
  const { data, error } = await ctx.db.from("tx_transaction").update({ status: "completed" }).eq("id", txId).eq("workspace_id", ctx.workspaceId).select().single();
  if (error) throw txDbError(error, "transaction");
  await record(ctx, txId, { kind: "completed", summary: "Transaction completed — all closure conditions resolved", subjectType: "tx_transaction", subjectId: txId });
  return data as Row;
}

export async function timeline(ctx: TxCtx, txId: string) {
  return q<Row[]>(ctx.db.from("tx_event").select("*").eq("transaction_id", txId).order("occurred_at").order("created_at"), "timeline");
}

export async function milestonesView(ctx: TxCtx, txId: string) {
  const rows = await q<Row[]>(ctx.db.from("tx_milestone").select("*").eq("transaction_id", txId), "milestones");
  return { matrix: milestoneMatrix(rows as any), rows };
}

/**
 * Archive a transaction (admin/owner, reason required). Its approvals are archived with it so Review, Today and the
 * menu badge stop listing them; the reason goes on the append-only timeline and the audit trigger records the rows.
 */
export async function archiveTransaction(ctx: TxCtx, txId: string, reason: string) {
  const why = reason.trim();
  if (!why) throw new TxError(400, "archiving needs a reason");
  const tx = await getTransaction(ctx, txId);
  if (tx.archived_at) return tx;
  await record(ctx, txId, { kind: "archived", summary: `Transaction archived: ${why}`, subjectType: "tx_transaction", subjectId: txId, payload: { reason: why } });
  const now = new Date().toISOString();
  await q(ctx.db.from("tx_approval").update({ archived_at: now }).eq("workspace_id", ctx.workspaceId).eq("transaction_id", txId).is("archived_at", null), "archive approvals");
  const row = await q<Row | null>(ctx.db.from("tx_transaction").update({ archived_at: now }).eq("workspace_id", ctx.workspaceId).eq("id", txId).is("archived_at", null).select().maybeSingle(), "archive transaction");
  if (!row) throw new TxError(409, "transaction changed or not permitted — reload and try again");
  return row;
}

export { TX_TYPES };

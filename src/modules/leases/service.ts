/**
 * Module 15 — Lease Lifecycle service layer. User actions take the caller's RLS client (`w.db`, from requireContext);
 * only `dispatchDueReminders` (jobs) takes the admin client and filters workspace_id explicitly (S2).
 * Nothing here sends anything outside the app (S3). Dates/terms from documents are proposals until a human confirms.
 */
import type { Db } from "@/lib/supabase/server";
import { getAiMode } from "@/lib/ai/policy";
import { compareRenewalRelocation, type RvrInput } from "@/modules/toolkit/calc/renewal";
import { notifyUser, cancelObsolete } from "@/modules/orchestrator/notify/service";
import { publishEvent } from "@/modules/orchestrator/events/publish";
import { effectiveAfter, noticeDeadline, periodFromClause, daysBetween, addDays, isIso } from "./dates";
import { escalationSchedule, escalationDiscrepancy, type EscalationClause } from "./escalation";
import { extractWithPolicy, type DateProposal } from "./extract";
import { checkTransition, isLeaseStatus, nextStatuses, type LeaseCategory, type LeaseStatus } from "./status";
import { DEFAULT_HANDOVER, DEFAULT_OFFSETS, costOverview, findConflicts, identifyOpportunities, planReminders, portfolio, type DateRow } from "./planning";

export interface W { db: Db; ws: string; userId: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const chunks = <T>(a: T[], n = 100): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
export class LeaseError extends Error { constructor(msg: string, public code = "invalid") { super(msg); } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const must = (r: { data: unknown; error: { message: string } | null }, what: string): any => {
  if (r.error) throw new LeaseError(`${what}: ${r.error.message}`, "db");
  if (r.data === null) throw new LeaseError(`${what}: not found`, "not_found");
  return r.data as Row;
};

export interface CommercialTerms {
  monthlyRent?: number | null; rentPerSf?: number | null; rentableArea?: number | null; chargeableArea?: number | null; carpetArea?: number | null;
  superBuiltUpArea?: number | null; areaBasis?: "chargeable" | "carpet" | "super_built_up" | "rentable" | null; camMonthly?: number | null;
  parkingMonthly?: number | null; otherMonthly?: number | null; securityDeposit?: number | null; rentFreeMonths?: number | null;
  paymentFrequency?: string | null; paymentDueDay?: number | null; escalation?: EscalationClause | null; taxes?: string | null;
  termMonths?: number | null; lockinMonths?: number | null; noticePeriod?: string | null; breakClause?: string | null; renewalOption?: string | null;
  holdover?: string | null; surrender?: string | null; other?: string | null;
}
export const TERM_LABEL: Record<keyof CommercialTerms, string> = {
  monthlyRent: "Monthly rent", rentPerSf: "Rent / sf", rentableArea: "Rentable area", chargeableArea: "Chargeable area", carpetArea: "Carpet area",
  superBuiltUpArea: "Super built-up area", areaBasis: "Area basis", camMonthly: "CAM / month", parkingMonthly: "Parking / month", otherMonthly: "Other recurring / month",
  securityDeposit: "Security deposit", rentFreeMonths: "Rent-free months", paymentFrequency: "Payment frequency", paymentDueDay: "Payment due day",
  escalation: "Escalation", taxes: "Taxes", termMonths: "Term (months)", lockinMonths: "Lock-in (months)", noticePeriod: "Notice period", breakClause: "Break clause",
  renewalOption: "Renewal option", holdover: "Holdover", surrender: "Surrender", other: "Other conditions",
};
/** Field-level diff between two term sets (unknown ≠ 0). */
export function diffTerms(a: CommercialTerms, b: CommercialTerms) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof CommercialTerms>;
  const out: { field: keyof CommercialTerms; label: string; before: unknown; after: unknown }[] = [];
  for (const k of keys) { const x = a[k] ?? null, y = b[k] ?? null; if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: k, label: TERM_LABEL[k] ?? k, before: x, after: y }); }
  return out;
}

// ------------------------------------------------------------------ lease records
export interface CreateLeaseInput {
  tenantOrgId?: string | null; tenantNameRaw?: string | null; landlordOrgId?: string | null; assetId?: string | null; spaceId?: string | null;
  reference?: string | null; category?: LeaseCategory; status?: LeaseStatus; floor?: string | null; unit?: string | null; microMarket?: string | null;
  commencement?: string | null; expiry?: string | null; terms?: CommercialTerms; transactionId?: string | null; assignedUserId?: string | null; contactPersonIds?: string[];
}
const PRE_EXEC: LeaseStatus[] = ["draft", "under_negotiation", "awaiting_approval", "awaiting_execution"];

export async function createLease(w: W, i: CreateLeaseInput): Promise<Row> {
  const status = i.status ?? "draft";
  if (!PRE_EXEC.includes(status)) throw new LeaseError("New leases start in a pre-execution status; executed/active need evidence (use the status action).");
  if (!i.tenantOrgId && !i.tenantNameRaw?.trim()) throw new LeaseError("Tenant is required.");
  const t = i.terms ?? {};
  const lease = must(await w.db.from("lease").insert({
    workspace_id: w.ws, owner_user_id: w.userId, tenant_org_id: i.tenantOrgId ?? null, tenant_name_raw: i.tenantNameRaw ?? null, landlord_org_id: i.landlordOrgId ?? null,
    asset_id: i.assetId ?? null, space_id: i.spaceId ?? null, reference: i.reference ?? null, category: i.category ?? "conventional_office", lifecycle_status: status,
    floor: i.floor ?? null, unit: i.unit ?? null, micro_market: i.microMarket ?? null, transaction_id: i.transactionId ?? null,
    assigned_user_id: i.assignedUserId ?? w.userId, contact_person_ids: i.contactPersonIds ?? [],
    start_date: i.commencement ?? null, start_precision: i.commencement ? "day" : "unknown", contractual_expiry: i.expiry ?? null,
    area_sf: t.chargeableArea ?? t.rentableArea ?? t.carpetArea ?? t.superBuiltUpArea ?? null, area_basis: t.areaBasis ?? null, rent_per_sf: t.rentPerSf ?? null,
    lockin_months_raw: t.lockinMonths ?? null, tenure_months_raw: t.termMonths ?? null, fact_status: "reported",
  }).select("*").single(), "create lease");
  await w.db.from("lease_status_history").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: lease.id, from_status: null, to_status: status, note: "Lease record created", changed_by: w.userId });
  if (Object.keys(t).length) {
    must(await w.db.from("lease_term_version").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: lease.id, version: 1, source: "original", status: "current", terms: t, note: "Entered by user", confirmed_by: w.userId, confirmed_at: new Date().toISOString() }).select("id").single(), "terms v1");
  }
  for (const [type, d] of [["commencement", i.commencement], ["expiry", i.expiry]] as const) {
    if (d) await addManualDate(w, lease.id, { dateType: type, date: d, note: "Entered when the lease was created" });
  }
  return lease;
}

export async function listLeases(w: W, f: { status?: string; q?: string; category?: string; assetId?: string; orgId?: string; landlordId?: string; microMarket?: string; assigned?: string } = {}) {
  let q = w.db.from("lease").select("*").eq("workspace_id", w.ws).is("archived_at", null).order("created_at", { ascending: false }).limit(500);
  if (f.status) q = q.eq("lifecycle_status", f.status);
  if (f.category) q = q.eq("category", f.category);
  if (f.assetId) q = q.eq("asset_id", f.assetId);
  if (f.orgId) q = q.eq("tenant_org_id", f.orgId);
  if (f.landlordId) q = q.eq("landlord_org_id", f.landlordId);
  if (f.microMarket) q = q.ilike("micro_market", `%${f.microMarket}%`);
  if (f.assigned) q = q.eq("assigned_user_id", f.assigned);
  const rows = (must(await q, "list leases") as Row[]);
  const names = await nameMaps(w, rows);
  const out: Row[] = rows.map((l) => withLabel({ ...l, tenant_name: names.org.get(l.tenant_org_id) ?? l.tenant_name_raw ?? null, landlord_name: names.org.get(l.landlord_org_id) ?? null, asset_name: names.asset.get(l.asset_id) ?? null }));
  const s = f.q?.trim().toLowerCase();
  return s ? out.filter((l) => `${l.tenant_name ?? ""} ${l.landlord_name ?? ""} ${l.asset_name ?? ""} ${l.reference ?? ""}`.toLowerCase().includes(s)) : out;
}

/** Display name for a lease: tenant → landlord → building (+ floor/unit) → reference. Never a bare "Lease" when anything is known. */
export function leaseLabel(l: { tenant_name?: string | null; landlord_name?: string | null; asset_name?: string | null; floor?: string | null; unit?: string | null; reference?: string | null }): string {
  if (l.tenant_name) return l.tenant_name;
  const where = [l.asset_name, l.floor ? `Floor ${l.floor}` : null, l.unit].filter(Boolean).join(" · ");
  if (l.landlord_name) return where ? `${l.landlord_name} — ${where}` : l.landlord_name;
  return where || l.reference || "Lease (no tenant or property)";
}
const withLabel = (l: Row): Row => ({ ...l, label: leaseLabel(l) });

async function nameMaps(w: W, rows: Row[]) {
  const orgIds = [...new Set(rows.flatMap((l) => [l.tenant_org_id, l.landlord_org_id]).filter(Boolean))];
  const assetIds = [...new Set(rows.map((l) => l.asset_id).filter(Boolean))];
  const org = new Map<string, string>(); const asset = new Map<string, string>();
  for (const ids of chunks(orgIds)) for (const o of (await w.db.from("organisation").select("id, display_name, legal_name").in("id", ids)).data ?? []) org.set(o.id, o.display_name ?? o.legal_name);
  for (const ids of chunks(assetIds)) for (const a of (await w.db.from("asset").select("id, name").in("id", ids)).data ?? []) asset.set(a.id, a.name);
  return { org, asset };
}

export async function getLease(w: W, id: string) {
  const lease = (await w.db.from("lease").select("*").eq("workspace_id", w.ws).eq("id", id).maybeSingle()).data as Row | null;
  if (!lease) return null;
  const leaseOut: Row = { ...lease };
  const sel = (t: string, order = "created_at") => w.db.from(t).select("*").eq("workspace_id", w.ws).eq("lease_id", id).order(order, { ascending: true });
  const [documents, dates, terms, obligations, history, renewals, terminations, handover, reminders, financial] = await Promise.all([
    sel("lease_document"), sel("lease_date"), sel("lease_term_version", "version"), sel("lease_obligation"), sel("lease_status_history", "changed_at"), sel("lease_renewal"),
    sel("lease_termination"), sel("lease_handover_item", "sort"), sel("lease_reminder", "remind_on"), sel("lease_financial_record"),
  ]);
  const names = await nameMaps(w, [lease]);
  const termRows = (terms.data ?? []) as Row[];
  const current = [...termRows].reverse().find((t) => t.status === "current") ?? null;
  const contacts = lease.contact_person_ids?.length ? (await w.db.from("person").select("id, full_name").in("id", lease.contact_person_ids)).data ?? [] : [];
  return {
    lease: Object.assign(leaseOut, withLabel({ ...leaseOut, tenant_name: names.org.get(lease.tenant_org_id) ?? lease.tenant_name_raw, landlord_name: names.org.get(lease.landlord_org_id) ?? null, asset_name: names.asset.get(lease.asset_id) ?? null })) as Row,
    documents: (documents.data ?? []) as Row[], dates: (dates.data ?? []) as Row[], terms: termRows, currentTerms: (current?.terms ?? {}) as CommercialTerms, currentTermVersion: current,
    obligations: (obligations.data ?? []) as Row[], history: (history.data ?? []) as Row[], renewals: (renewals.data ?? []) as Row[],
    terminations: (terminations.data ?? []) as Row[], handover: (handover.data ?? []) as Row[], reminders: (reminders.data ?? []) as Row[], financial: (financial.data ?? []) as Row[], contacts,
  };
}

/** Activity timeline from the audit trail (all lease_* tables are audited by make_business_table). */
export async function leaseAudit(w: W, leaseId: string) {
  const ids = [leaseId];
  for (const t of ["lease_date", "lease_document", "lease_term_version", "lease_obligation", "lease_renewal", "lease_termination", "lease_handover_item", "lease_status_history"]) {
    for (const r of (await w.db.from(t).select("id").eq("workspace_id", w.ws).eq("lease_id", leaseId)).data ?? []) ids.push(r.id);
  }
  const { data } = await w.db.from("audit_event").select("occurred_at, actor_user_id, actor_kind, action, entity_type, entity_id, before, after").eq("workspace_id", w.ws).in("entity_id", ids).order("occurred_at", { ascending: true }).limit(1000);
  return (data ?? []) as Row[];
}

// ------------------------------------------------------------------ status
export async function setStatus(w: W, leaseId: string, to: string, ev: { documentId?: string | null; executionDate?: string | null; noticeDate?: string | null; note?: string | null; today: string }) {
  if (!isLeaseStatus(to)) throw new LeaseError("Unknown status.");
  const d = await getLease(w, leaseId);
  if (!d) throw new LeaseError("Lease not found.", "not_found");
  const from = d.lease.lifecycle_status as LeaseStatus;
  const confirmed = (t: string) => d.dates.filter((x) => x.date_type === t && x.verification_status === "confirmed" && !x.superseded_by && !x.archived_at).map((x) => x.calculated_date as string)[0] ?? null;
  const doc = ev.documentId ? d.documents.find((x) => x.id === ev.documentId) ?? null : d.documents.filter((x) => ["executed", "signed"].includes(x.execution_state) && ["lease_agreement", "leave_and_licence", "renewal_agreement"].includes(x.doc_type)).slice(-1)[0] ?? null;
  const term = d.terminations.slice(-1)[0];
  const check = checkTransition(from, to, {
    today: ev.today, executedDocument: doc ? { id: doc.id, execution_state: doc.execution_state } : null, executionDate: ev.executionDate ?? d.lease.execution_date ?? confirmed("execution"),
    confirmedCommencementOrPossession: confirmed("commencement") ?? confirmed("possession"), confirmedExpiry: confirmed("expiry"),
    noticeDate: ev.noticeDate ?? term?.notice_date ?? null, noticeDocumentId: d.documents.find((x) => x.doc_type === "termination_notice" && x.id === ev.documentId)?.id ?? null, note: ev.note ?? null,
    agreedRenewalId: d.renewals.find((r) => r.stage === "agreed" || r.stage === "completed")?.id ?? null, confirmedTerminationDate: term?.confirmed_date ?? null,
    handoverComplete: d.handover.length > 0 && d.handover.every((h) => h.status !== "pending"),
  });
  if (!check.ok) throw new LeaseError(check.errors.join(" "), "evidence_required");
  const patch: Row = { lifecycle_status: to };
  if (to === "executed" && ev.executionDate) patch.execution_date = ev.executionDate;
  if (to === "renewal_under_discussion" || to === "renewal_agreed") patch.renewal_status = to;
  if (to === "termination_notice_served" || to === "terminated") patch.termination_status = to;
  must(await w.db.from("lease").update(patch).eq("workspace_id", w.ws).eq("id", leaseId).eq("row_version", d.lease.row_version).select("id").single(), "status update (conflict? reload)");
  await w.db.from("lease_status_history").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, from_status: from, to_status: to, changed_by: w.userId, note: ev.note ?? null,
    evidence: { document_id: doc?.id ?? null, execution_date: ev.executionDate ?? null, notice_date: ev.noticeDate ?? null } });
  if (["terminated", "surrendered", "closed", "expired"].includes(to)) await cancelLeaseReminders(w, leaseId, `lease ${to}`);
  const evType = to === "renewal_agreed" ? "lease.renewal_agreed" : to === "termination_notice_served" ? "lease.termination_notice_recorded" : null;
  if (evType) await safePublish(w, { type: evType, subjectType: "lease", subjectId: leaseId, payload: { tenant_org_id: d.lease.tenant_org_id }, dedupeKey: `${evType}:${leaseId}:${ev.today}` });
  return { from, to };
}

async function safePublish(w: W, e: Parameters<typeof publishEvent>[2]) {
  try { return await publishEvent(w.db, w.ws, e); } catch { return null; } // event bus failure never blocks the record write; it is visible in the orchestrator health view
}

// ------------------------------------------------------------------ terms & amendments
export async function addTermVersion(w: W, leaseId: string, i: { terms: CommercialTerms; source: "amendment" | "renewal" | "manual" | "transaction" | "extracted"; documentId?: string | null; effectiveFrom?: string | null; note?: string | null }) {
  const { data: last } = await w.db.from("lease_term_version").select("version").eq("workspace_id", w.ws).eq("lease_id", leaseId).order("version", { ascending: false }).limit(1).maybeSingle();
  // B4: blank fields carry over from the current version — an amendment only changes the fields it states.
  const cur = (await w.db.from("lease_term_version").select("terms").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("status", "current").maybeSingle()).data;
  const terms = cur?.terms ? { ...(cur.terms as CommercialTerms), ...i.terms } : i.terms;
  return must(await w.db.from("lease_term_version").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, version: (last?.version ?? 0) + 1, source: i.source, status: "proposed",
    terms, document_id: i.documentId ?? null, effective_from: i.effectiveFrom ?? null, note: i.note ?? null }).select("*").single(), "term version");
}
/** Human approval: proposed → current. Previous current → superseded (kept, never overwritten). */
export async function confirmTermVersion(w: W, versionId: string) {
  const v = must(await w.db.from("lease_term_version").select("*").eq("workspace_id", w.ws).eq("id", versionId).maybeSingle(), "term version") as Row;
  if (v.status !== "proposed") throw new LeaseError("Only proposed terms can be confirmed.");
  if (v.document_id) {
    const doc = (await w.db.from("lease_document").select("execution_state").eq("id", v.document_id).maybeSingle()).data;
    if (doc && !["executed", "signed", "amendment"].includes(doc.execution_state)) throw new LeaseError("Terms from a draft/unsigned document cannot become current terms.");
  }
  await w.db.from("lease_term_version").update({ status: "superseded" }).eq("workspace_id", w.ws).eq("lease_id", v.lease_id).eq("status", "current");
  return must(await w.db.from("lease_term_version").update({ status: "current", confirmed_by: w.userId, confirmed_at: new Date().toISOString() }).eq("workspace_id", w.ws).eq("id", versionId).select("*").single(), "confirm terms");
}
export async function rejectTermVersion(w: W, versionId: string) {
  return must(await w.db.from("lease_term_version").update({ status: "rejected" }).eq("workspace_id", w.ws).eq("id", versionId).eq("status", "proposed").select("*").single(), "reject terms");
}

// ------------------------------------------------------------------ documents + extraction
export type DocType = "loi" | "term_sheet" | "lease_agreement" | "leave_and_licence" | "mou" | "commercial_proposal" | "rent_quotation" | "lease_amendment" | "renewal_agreement" | "termination_notice" | "handover" | "possession" | "security_deposit" | "other";
export type ExecState = "draft" | "unsigned_proposal" | "signed" | "executed" | "superseded" | "amendment" | "supporting";
const CONTRACT_DOCS: DocType[] = ["lease_agreement", "leave_and_licence", "lease_amendment", "renewal_agreement"];

export async function addDocument(w: W, leaseId: string, i: { title: string; docType: DocType; executionState: ExecState; pages?: string[] | null; text?: string | null; sourceObjectId?: string | null; storagePath?: string | null; origin?: "extracted" | "transaction" }) {
  const pages = i.pages?.length ? i.pages : i.text ? i.text.split("\f") : [];
  const sha = pages.length ? await sha256(pages.join("\f")) : null;
  if (sha) {
    const dup = (await w.db.from("lease_document").select("*").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("content_sha", sha).is("archived_at", null).maybeSingle()).data;
    if (dup) return { document: dup as Row, dates: [] as Row[], duplicate: true, conflicts: [] as ReturnType<typeof findConflicts>, termVersion: null as Row | null, diff: [] as ReturnType<typeof diffTerms> };
  }
  const { data: prev } = await w.db.from("lease_document").select("id, version").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("doc_type", i.docType).is("archived_at", null).order("version", { ascending: false }).limit(1).maybeSingle();
  const doc = must(await w.db.from("lease_document").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, title: i.title, doc_type: i.docType, execution_state: i.executionState,
    version: (prev?.version ?? 0) + 1, supersedes_id: prev?.id ?? null, pages, content_sha: sha, source_object_id: i.sourceObjectId ?? null, storage_path: i.storagePath ?? null, uploaded_by: w.userId }).select("*").single(), "add document") as Row;
  // an executed replacement of the same agreement type supersedes the previous one (kept for history)
  if (prev && ["executed", "signed"].includes(i.executionState) && i.docType !== "lease_amendment") await w.db.from("lease_document").update({ execution_state: "superseded" }).eq("workspace_id", w.ws).eq("id", prev.id).in("execution_state", ["executed", "signed"]);

  if (!pages.some((p) => p.trim())) return { document: doc, dates: [], duplicate: false, conflicts: [], termVersion: null, diff: [] };
  const mode = await getAiMode(w.db, w.ws, "capture.lease_terms");
  const ex = await extractWithPolicy(w.ws, pages, mode);
  await w.db.from("lease_document").update({ extracted: { version: ex.version, terms: ex.terms, missing: ex.missing, clauses: ex.clauses.slice(0, 80) }, extraction_source: ex.source }).eq("workspace_id", w.ws).eq("id", doc.id);

  const executed = ["executed", "signed", "amendment"].includes(i.executionState) && CONTRACT_DOCS.includes(i.docType);
  // confirmed anchors override document anchors for dependent calculations
  const anchors = await confirmedAnchors(w, leaseId);
  const proposals = recalcWithAnchors(ex.dates, anchors);
  const rows: Row[] = [];
  let idx = 0;
  for (const p0 of proposals) {
    // an amendment's "with effect from" date is not the lease commencement
    const p = i.docType === "lease_amendment" && p0.date_type === "commencement" ? { ...p0, date_type: "other" as const, label: "Amendment effective date" } : p0;
    const status = executed ? p.verification_status : "needs_review";
    const reason = executed ? p.review_reason ?? null : [`From a ${i.executionState.replace("_", " ")} document — not a contractual date until an executed agreement confirms it.`, p.review_reason].filter(Boolean).join(" ");
    const r = await w.db.from("lease_date").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, date_type: p.date_type, label: p.label, calculated_date: p.calculated_date, alternatives: p.alternatives,
      method: p.method, convention: p.convention, clause_text: p.clause_text, document_id: doc.id, page: p.page, verification_status: status, review_reason: reason, origin: i.origin === "transaction" && p.origin === "extracted" ? "transaction" : p.origin,
      dedupe_key: `doc:${doc.id}:${p.date_type}:${idx++}` }).select("*").single();
    if (!r.error && r.data) rows.push(r.data);
  }
  for (const o of ex.obligations) {
    await w.db.from("lease_obligation").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, category: o.category, description: o.description, responsible: o.responsible, clause_text: o.description, document_id: doc.id, page: o.page, origin: "extracted", status: "open" });
  }
  // proposed term version from the document (never current until confirmed)
  const t = ex.terms;
  const terms: CommercialTerms = Object.fromEntries(Object.entries({ monthlyRent: t.monthlyRent, camMonthly: t.camMonthly, securityDeposit: t.securityDeposit, chargeableArea: t.areaSf, termMonths: t.termMonths, lockinMonths: t.lockinMonths, escalation: t.escalation }).filter(([, v]) => v != null));
  let termVersion: Row | null = null; let diff: ReturnType<typeof diffTerms> = [];
  if (Object.keys(terms).length) {
    const cur = (await w.db.from("lease_term_version").select("terms").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("status", "current").maybeSingle()).data;
    diff = cur ? diffTerms(cur.terms, { ...cur.terms, ...terms }) : [];
    const eff = i.docType === "lease_amendment" ? proposals.find((p) => p.date_type === "commencement")?.calculated_date ?? null : null;
    termVersion = await addTermVersion(w, leaseId, { effectiveFrom: eff, terms: cur ? { ...cur.terms, ...terms } : terms, source: i.docType === "lease_amendment" ? "amendment" : i.docType === "renewal_agreement" ? "renewal" : "extracted", documentId: doc.id, note: `Extracted from "${i.title}" (${ex.source})` });
  }
  const conflicts = await flagConflicts(w, leaseId);
  // B5: earlier deadlines that were "not calculable" pick up anchors this document provided
  if (executed) await recalcDependents(w, leaseId, { skipDocumentId: doc.id });
  return { document: doc, dates: rows, duplicate: false, conflicts, termVersion, diff };
}

async function sha256(s: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Anchors for dependent deadlines (B5): a human-confirmed date wins; otherwise the current (non-superseded, non-archived)
 * calculated/extracted date is used and its verification label travels with the dependent date's review reason.
 */
async function currentAnchors(w: W, leaseId: string) {
  const { data } = await w.db.from("lease_date").select("date_type, calculated_date, verification_status, created_at").eq("workspace_id", w.ws).eq("lease_id", leaseId)
    .in("date_type", ["commencement", "expiry", "lockin_end"]).is("superseded_by", null).is("archived_at", null).not("calculated_date", "is", null).order("created_at", { ascending: false });
  const rows = (data ?? []) as Row[];
  const pick = (t: string) => rows.find((r) => r.date_type === t && r.verification_status === "confirmed") ?? rows.find((r) => r.date_type === t && !["conflicting"].includes(r.verification_status)) ?? null;
  const c = pick("commencement"), e = pick("expiry"), l = pick("lockin_end");
  const notes = [c, e, l].filter((r): r is Row => !!r && r.verification_status !== "confirmed")
    .map((r) => ({ type: r.date_type as string, text: `Uses the ${r.date_type === "lockin_end" ? "lock-in end" : r.date_type} date ${r.calculated_date} (${r.verification_status}, not yet confirmed) — confirm it first.` }));
  return { commencement: c?.calculated_date ?? null, expiry: e?.calculated_date ?? null, lockinEnd: l?.calculated_date ?? null, notes, expiryConfirmed: e?.verification_status === "confirmed" };
}

async function confirmedAnchors(w: W, leaseId: string) {
  const { data } = await w.db.from("lease_date").select("date_type, calculated_date").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("verification_status", "confirmed").is("superseded_by", null).is("archived_at", null);
  const get = (t: string) => (data ?? []).find((r: Row) => r.date_type === t)?.calculated_date ?? null;
  return { commencement: get("commencement"), expiry: get("expiry"), lockinEnd: get("lockin_end") };
}

/** Re-run dependent calculations with human-confirmed anchors (confirmed beats document-stated). */
export function recalcWithAnchors(ps: DateProposal[], a: { commencement: string | null; expiry: string | null; lockinEnd: string | null }): DateProposal[] {
  const comm = a.commencement ?? ps.find((p) => p.date_type === "commencement")?.calculated_date ?? null;
  let expiry = a.expiry ?? ps.find((p) => p.date_type === "expiry")?.calculated_date ?? null;
  return ps.map((p) => {
    if (!p.clause_text || p.origin !== "calculated") return p;
    if (p.date_type === "lockin_end" || (p.date_type === "expiry" && !a.expiry)) {
      const r = periodFromClause(p.clause_text, comm);
      if (p.date_type === "expiry") expiry = r.date ?? expiry;
      return { ...p, calculated_date: r.date, alternatives: r.alternatives, method: r.method, convention: r.convention, verification_status: r.status, review_reason: p.date_type === "lockin_end" ? [r.reason, "Lock-in completion does not by itself permit termination — check notice and termination conditions."].filter(Boolean).join(" ") : r.reason ?? null };
    }
    if (p.date_type === "termination_notice_deadline" || p.date_type === "renewal_notice_deadline") {
      const r = noticeDeadline(p.clause_text, { expiry, commencement: comm, lockinEnd: a.lockinEnd });
      // B5: drop stale "not known" reasons once the deadline is calculable; keep a purpose-ambiguity flag (B2).
      const ambiguous = /renewal or for termination/.test(p.review_reason ?? "");
      const keep = (p.review_reason ?? "").split(/(?<=\.)\s+/).filter((x) => x && !/not known|cannot be calculated|Base date changed|Uses the \w/.test(x)).join(" ");
      return { ...p, calculated_date: r.date, alternatives: r.alternatives, method: r.method, convention: r.convention, verification_status: ambiguous ? "needs_review" : r.status, review_reason: [r.reason, keep].filter(Boolean).join(" ") || null };
    }
    return p;
  });
}

/** Same date type, different value, different documents → every row involved becomes `conflicting` (unless confirmed). */
export async function flagConflicts(w: W, leaseId: string) {
  const { data } = await w.db.from("lease_date").select("*").eq("workspace_id", w.ws).eq("lease_id", leaseId).is("archived_at", null).is("superseded_by", null);
  const conflicts = findConflicts((data ?? []) as DateRow[]);
  for (const c of conflicts) {
    await w.db.from("lease_date").update({ verification_status: "conflicting", review_reason: `Documents disagree: ${c.values.join(" vs ")}. Choose the correct date after checking the executed agreement.` })
      .eq("workspace_id", w.ws).in("id", c.ids).neq("verification_status", "confirmed");
  }
  return conflicts;
}

// ------------------------------------------------------------------ critical dates
export async function addManualDate(w: W, leaseId: string, i: { dateType: string; date: string; label?: string | null; clauseText?: string | null; note?: string | null }) {
  if (!isIso(i.date)) throw new LeaseError("Date must be YYYY-MM-DD.");
  return must(await w.db.from("lease_date").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, date_type: i.dateType, label: i.label ?? null, calculated_date: i.date,
    method: "entered by user", clause_text: i.clauseText ?? null, verification_status: "extracted", review_reason: i.note ?? "Entered manually — confirm against the executed agreement.", origin: "manual" }).select("*").single(), "add date");
}

/** Calculate a dependent date from a clause and store it as `calculated` / `needs_review` (never confirmed). */
export async function calculateDate(w: W, leaseId: string, i: { dateType: "lockin_end" | "termination_notice_deadline" | "renewal_notice_deadline" | "expiry" | "escalation" | "break_option"; clauseText: string; months?: number | null; documentId?: string | null; page?: number | null }) {
  const a = await confirmedAnchors(w, leaseId);
  const r = i.dateType === "lockin_end" || i.dateType === "expiry" ? periodFromClause(i.clauseText, a.commencement)
    : i.dateType === "escalation" || i.dateType === "break_option" ? (i.months && a.commencement ? effectiveAfter(a.commencement, i.months) : { date: null, status: "needs_review" as const, method: "needs a confirmed commencement and months", convention: {}, alternatives: [], reason: "Commencement not confirmed." })
    : noticeDeadline(i.clauseText, a);
  return must(await w.db.from("lease_date").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, date_type: i.dateType, calculated_date: r.date, alternatives: r.alternatives, method: r.method,
    convention: r.convention, clause_text: i.clauseText, document_id: i.documentId ?? null, page: i.page ?? null, verification_status: r.status, review_reason: r.reason ?? null, origin: "calculated" }).select("*").single(), "calculate date");
}

/**
 * HUMAN REVIEW: the only way a date becomes a "confirmed contractual deadline". Needs_review / conflicting dates
 * require the reviewer to choose the date explicitly. Previous confirmed date of the same type is superseded (kept).
 * Mirrors the confirmed date to mudar.lease_event (radar + signal engine), recalculates dependents and reminders.
 * Audited by the lease_date audit trigger (actor = the reviewer).
 */
export async function confirmDate(w: W, dateId: string, i: { date?: string | null; note?: string | null; today: string }) {
  const d = must(await w.db.from("lease_date").select("*").eq("workspace_id", w.ws).eq("id", dateId).maybeSingle(), "date") as Row;
  if (d.verification_status === "confirmed") throw new LeaseError("Already confirmed.");
  if (d.superseded_by || d.archived_at) throw new LeaseError("This date was superseded.");
  const chosen = i.date ?? d.calculated_date;
  if ((d.verification_status === "needs_review" || d.verification_status === "conflicting") && !i.date) throw new LeaseError("This date needs review: choose the correct date explicitly (see the alternatives and the source clause).", "choose_date");
  if (!chosen || !isIso(chosen)) throw new LeaseError("No date to confirm.");
  if (d.document_id) {
    const doc = (await w.db.from("lease_document").select("execution_state").eq("id", d.document_id).maybeSingle()).data;
    if (doc && ["draft", "unsigned_proposal"].includes(doc.execution_state) && !i.note) throw new LeaseError("Date comes from a draft/unsigned document — add a note explaining the evidence for confirming it.", "evidence_required");
  }
  const prior = ((await w.db.from("lease_date").select("id, lease_event_id, verification_status").eq("workspace_id", w.ws).eq("lease_id", d.lease_id).eq("date_type", d.date_type).is("superseded_by", null).is("archived_at", null).neq("id", dateId)).data ?? []) as Row[];
  const updated = must(await w.db.from("lease_date").update({ calculated_date: chosen, verification_status: "confirmed", confirmed_by: w.userId, confirmed_at: new Date().toISOString(),
    review_reason: [d.calculated_date !== chosen ? `Reviewer chose ${chosen} (calculated ${d.calculated_date ?? "—"}).` : null, i.note].filter(Boolean).join(" ") || null }).eq("workspace_id", w.ws).eq("id", dateId).eq("row_version", d.row_version).select("*").single(), "confirm date (conflict? reload)") as Row;
  // single-instance types: supersede the rest (escalation/other can have many legit rows)
  if (!["escalation", "other"].includes(d.date_type) && prior.length) {
    await w.db.from("lease_date").update({ superseded_by: dateId }).eq("workspace_id", w.ws).in("id", prior.map((p) => p.id));
    const evIds = prior.map((p) => p.lease_event_id).filter(Boolean);
    if (evIds.length) await w.db.from("lease_event").update({ archived_at: new Date().toISOString() }).eq("workspace_id", w.ws).in("id", evIds);
  }
  const evType = ({ expiry: "expiry", lockin_end: "lockin_end", termination_notice_deadline: "notice_deadline", renewal_notice_deadline: "option", break_option: "break", escalation: "escalation" } as Record<string, string>)[d.date_type];
  if (evType) {
    const ev = await w.db.from("lease_event").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: d.lease_id, event_type: evType, event_date: chosen, date_basis: "contractual", confirmed: true,
      formula_raw: d.method, review_reason: null, engine_version: "lease-lifecycle-1", calc_inputs: { lease_date_id: dateId, page: d.page, document_id: d.document_id } }).select("id").single();
    if (ev.data) await w.db.from("lease_date").update({ lease_event_id: ev.data.id }).eq("workspace_id", w.ws).eq("id", dateId);
  }
  // Human-confirmed expiry → canonical lease.contractual_expiry (DB fn checks confirmer = caller; audit keeps the old value).
  if (d.date_type === "expiry") {
    const m = await w.db.schema("mudar_app").rpc("lease_mirror_confirmed_expiry", { p_date_id: dateId });
    if (m.error) console.warn(`lease expiry mirror failed: ${m.error.message}`);
  }
  if (["commencement", "expiry", "lockin_end"].includes(d.date_type)) await recalcDependents(w, d.lease_id, { skipDateId: dateId });
  await syncReminders(w, d.lease_id, i.today);
  return updated;
}

export async function rejectDate(w: W, dateId: string, note: string) {
  return must(await w.db.from("lease_date").update({ archived_at: new Date().toISOString(), review_reason: `Rejected by reviewer: ${note}` }).eq("workspace_id", w.ws).eq("id", dateId).neq("verification_status", "confirmed").select("*").single(), "reject date");
}

/** After an anchor changes: unconfirmed calculated dates are recalculated in place (new row, old superseded); confirmed ones get a needs_review successor. */
export async function recalcDependents(w: W, leaseId: string, opts: { skipDocumentId?: string; skipDateId?: string } = {}) {
  const a = await currentAnchors(w, leaseId);
  const { data } = await w.db.from("lease_date").select("*").eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("origin", "calculated").is("superseded_by", null).is("archived_at", null)
    .in("date_type", ["lockin_end", "termination_notice_deadline", "renewal_notice_deadline", "expiry"]);
  const changed: Row[] = [];
  const all = (data ?? []) as Row[];
  for (const d of all) {
    if (!d.clause_text) continue;
    if (d.id === opts.skipDateId) continue; // the date a reviewer just confirmed is not "changed" by its own confirmation
    if (d.verification_status !== "confirmed" && all.some((x) => x.id === d.base_date_id && x.verification_status === "confirmed")) continue; // re-review successor: handled with its confirmed parent
    if (opts.skipDocumentId && d.document_id === opts.skipDocumentId) continue;
    if (d.date_type === "expiry" && a.expiryConfirmed) continue;
    if (d.date_type === "lockin_end" && !a.commencement) continue;
    const [p0] = recalcWithAnchors([{ ...d, origin: "calculated" } as DateProposal], d.date_type === "expiry" ? { ...a, expiry: null } : a);
    const p = { ...p0, review_reason: [p0.review_reason, ...(p0.calculated_date ? a.notes.filter((n) => (["lockin_end", "expiry"].includes(d.date_type) ? n.type === "commencement" : true)).map((n) => n.text) : [])].filter(Boolean).join(" ") || null };
    const wasConfirmed = d.verification_status === "confirmed";
    // confirmed: only a different DATE needs re-review (confirmation rewrites review_reason, so don't compare it)
    if (wasConfirmed ? p.calculated_date === d.calculated_date : p.calculated_date === d.calculated_date && (p.review_reason ?? null) === (d.review_reason ?? null)) continue;
    if (wasConfirmed) {
      // one open re-review successor per confirmed date: update it in place instead of stacking duplicates
      const open = all.find((x) => x.base_date_id === d.id && x.id !== d.id && x.verification_status !== "confirmed");
      if (open) {
        if (open.calculated_date !== p.calculated_date) {
          const u = await w.db.from("lease_date").update({ calculated_date: p.calculated_date, alternatives: p.alternatives, method: p.method, convention: p.convention,
            review_reason: `Base date changed; previously confirmed ${d.calculated_date}. ${p.review_reason ?? ""}`.trim() }).eq("workspace_id", w.ws).eq("id", open.id).select("*").single();
          if (u.data) changed.push(u.data);
        }
        continue;
      }
    }
    const ins = await w.db.from("lease_date").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, date_type: d.date_type, label: d.label, calculated_date: p.calculated_date, alternatives: p.alternatives,
      method: p.method, convention: p.convention, clause_text: d.clause_text, document_id: d.document_id, page: d.page, base_date_id: d.id, origin: "calculated",
      verification_status: wasConfirmed ? "needs_review" : p.verification_status, review_reason: wasConfirmed ? `Base date changed; previously confirmed ${d.calculated_date}. ${p.review_reason ?? ""}`.trim() : p.review_reason ?? null }).select("*").single();
    if (ins.data && !wasConfirmed) { await w.db.from("lease_date").update({ superseded_by: ins.data.id }).eq("workspace_id", w.ws).eq("id", d.id); }
    if (ins.data) changed.push(ins.data);
  }
  return changed;
}

export async function upcomingDates(w: W, f: { from: string; to: string; types?: string[]; leaseId?: string; orgId?: string; assetId?: string; status?: string; assigned?: string; includeUnverified?: boolean }) {
  let q = w.db.from("lease_date").select("*").eq("workspace_id", w.ws).is("archived_at", null).is("superseded_by", null).not("calculated_date", "is", null)
    .gte("calculated_date", f.from).lte("calculated_date", f.to).order("calculated_date", { ascending: true }).limit(1000);
  if (f.types?.length) q = q.in("date_type", f.types);
  if (f.leaseId) q = q.eq("lease_id", f.leaseId);
  if (!f.includeUnverified) q = q.eq("verification_status", "confirmed");
  const rows = (must(await q, "dates") as Row[]);
  const leases = await listLeases(w, { orgId: f.orgId, assetId: f.assetId, status: f.status, assigned: f.assigned });
  const byId = new Map(leases.map((l) => [l.id, l]));
  return rows.filter((r) => byId.has(r.lease_id)).map((r): Row => ({ ...r, lease: byId.get(r.lease_id)! }));
}

/** Overdue milestones: confirmed dates in the past whose follow-up is not recorded (open reminders / obligations). */
export async function overdue(w: W, today: string) {
  const { data: rem } = await w.db.from("lease_reminder").select("*").eq("workspace_id", w.ws).in("status", ["scheduled", "sent"]).lt("target_date", today);
  const { data: obl } = await w.db.from("lease_obligation").select("*").eq("workspace_id", w.ws).in("status", ["open", "in_progress"]).lt("deadline", today).is("archived_at", null);
  return { reminders: (rem ?? []) as Row[], obligations: (obl ?? []) as Row[] };
}

// ------------------------------------------------------------------ reminders (§14)
async function reminderOffsets(w: W): Promise<Record<string, number[]>> {
  const { data } = await w.db.from("workspace_setting").select("value").eq("workspace_id", w.ws).eq("key", "leases.reminder_offsets").maybeSingle();
  const v = data?.value as Record<string, unknown> | undefined;
  const out = { ...DEFAULT_OFFSETS };
  if (v && typeof v === "object") for (const [k, arr] of Object.entries(v)) if (Array.isArray(arr) && arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) out[k] = arr as number[];
  return out;
}

/** Plan from confirmed dates; insert missing (no duplicates), cancel obsolete. Idempotent. */
export async function syncReminders(w: W, leaseId: string, today: string, offsets?: Record<string, number[]>) {
  const lease = (await w.db.from("lease").select("lifecycle_status, assigned_user_id, owner_user_id").eq("workspace_id", w.ws).eq("id", leaseId).maybeSingle()).data;
  const ended = !lease || ["terminated", "surrendered", "closed", "expired"].includes(lease.lifecycle_status);
  const { data: dates } = await w.db.from("lease_date").select("*").eq("workspace_id", w.ws).eq("lease_id", leaseId);
  const plan = ended ? [] : planReminders((dates ?? []) as DateRow[], offsets ?? await reminderOffsets(w), today);
  const { data: existing } = await w.db.from("lease_reminder").select("id, dedupe_key, status").eq("workspace_id", w.ws).eq("lease_id", leaseId).neq("status", "cancelled");
  const have = new Set((existing ?? []).map((r: Row) => r.dedupe_key));
  const want = new Set(plan.map((p) => p.dedupe_key));
  let created = 0, cancelled = 0;
  for (const p of plan) {
    if (have.has(p.dedupe_key)) continue;
    const r = await w.db.from("lease_reminder").insert({ workspace_id: w.ws, owner_user_id: w.userId, ...p, assigned_user_id: lease?.assigned_user_id ?? lease?.owner_user_id ?? w.userId });
    if (!r.error) created++; else if (r.error.code !== "23505") throw new LeaseError(r.error.message, "db");
  }
  const obsolete = (existing ?? []).filter((r: Row) => r.status === "scheduled" && !want.has(r.dedupe_key));
  if (obsolete.length) {
    await w.db.from("lease_reminder").update({ status: "cancelled", cancelled_reason: ended ? "Lease ended" : "Date changed or no longer confirmed" }).eq("workspace_id", w.ws).in("id", obsolete.map((r: Row) => r.id));
    cancelled = obsolete.length;
  }
  return { created, cancelled, planned: plan.length };
}
async function cancelLeaseReminders(w: W, leaseId: string, reason: string) {
  await w.db.from("lease_reminder").update({ status: "cancelled", cancelled_reason: reason }).eq("workspace_id", w.ws).eq("lease_id", leaseId).eq("status", "scheduled");
}
export async function completeReminder(w: W, id: string) {
  return must(await w.db.from("lease_reminder").update({ status: "done" }).eq("workspace_id", w.ws).eq("id", id).in("status", ["scheduled", "sent"]).select("*").single(), "complete reminder");
}

/** JOB (admin client): deliver due reminders through the orchestrator notify service; withdraw cancelled ones. */
export async function dispatchDueReminders(admin: Db, ws: string, today: string) {
  const { data: due } = await admin.from("lease_reminder").select("*").eq("workspace_id", ws).eq("status", "scheduled").lte("remind_on", today).limit(500);
  let sent = 0;
  for (const r of (due ?? []) as Row[]) {
    const lease = (await admin.from("lease").select("id, tenant_name_raw, tenant_org_id, owner_user_id").eq("workspace_id", ws).eq("id", r.lease_id).maybeSingle()).data;
    const userId = r.assigned_user_id ?? lease?.owner_user_id;
    if (!userId) continue;
    const days = daysBetween(today, r.target_date);
    const res = await notifyUser(admin, ws, {
      userId, category: "lease_deadline", eventKey: r.dedupe_key, triggerKey: `lease_reminder:${r.id}`, severity: days <= 30 && /notice|break/.test(r.date_type) ? "urgent" : undefined,
      title: `${r.date_type.replace(/_/g, " ")} in ${days} days (${r.target_date})`, body: `${lease?.tenant_name_raw ?? "Lease"} — confirmed contractual date. Open the lease to review the source clause.`,
      record: { type: "lease", id: r.lease_id }, href: `/leases/${r.lease_id}`,
    });
    await admin.from("lease_reminder").update({ status: "sent", outbox_id: res.outboxId }).eq("workspace_id", ws).eq("id", r.id);
    sent++;
  }
  const { data: dead } = await admin.from("lease_reminder").select("id").eq("workspace_id", ws).eq("status", "cancelled").not("outbox_id", "is", null).limit(500);
  for (const r of (dead ?? []) as Row[]) await cancelObsolete(admin, ws, `lease_reminder:${r.id}`, "Lease date changed or lease ended");
  return { sent };
}

// ------------------------------------------------------------------ escalation (§6) & finance (§8)
export async function escalationView(w: W, leaseId: string) {
  const d = await getLease(w, leaseId);
  if (!d) throw new LeaseError("Lease not found.", "not_found");
  const t = d.currentTerms;
  const comm = d.dates.find((x) => x.date_type === "commencement" && x.verification_status === "confirmed" && !x.superseded_by)?.calculated_date ?? null;
  if (!t.escalation) return { schedule: null, rows: [], note: "No escalation clause recorded." };
  const s = escalationSchedule(t.monthlyRent ?? null, comm, t.escalation, t.termMonths ?? null);
  const actuals = d.financial.filter((f) => f.kind === "actual_rent_after_escalation");
  const rows = s.steps.map((st) => {
    const act = actuals.find((a) => a.on_date && st.effectiveDate && a.on_date >= st.effectiveDate) ?? null;
    return { ...st, sourceClause: t.escalation?.clauseText ?? null, page: t.escalation?.page ?? null, verification: d.currentTermVersion?.confirmed_at ? "terms confirmed" : "terms not confirmed",
      actual: act?.amount ?? null, check: escalationDiscrepancy(st.expectedMonthlyRent, act?.amount ?? null) };
  });
  return { schedule: s, rows, note: comm ? null : "Commencement date not confirmed — escalation dates not calculated." };
}

export async function addFinancialRecord(w: W, leaseId: string, i: { kind: string; amount: number; onDate?: string | null; period?: string | null; note?: string | null; source?: "user_verified" | "connected_system" }) {
  if (!Number.isFinite(i.amount)) throw new LeaseError("Amount must be a number.");
  return must(await w.db.from("lease_financial_record").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, kind: i.kind, amount: i.amount, on_date: i.onDate ?? null, period: i.period ?? null, note: i.note ?? null, source: i.source ?? "user_verified" }).select("*").single(), "financial record");
}
/** Payment status ONLY from records — otherwise "unknown" (never claims paid/outstanding). */
export function paymentStatus(records: Row[], period: string): "paid_recorded" | "unknown" {
  return records.some((r) => r.kind === "rent_payment" && r.period === period) ? "paid_recorded" : "unknown";
}
export function leaseCost(d: NonNullable<Awaited<ReturnType<typeof getLease>>>, today: string) {
  const t = d.currentTerms;
  const exp = d.dates.find((x) => x.date_type === "expiry" && x.verification_status === "confirmed" && !x.superseded_by)?.calculated_date ?? null;
  return costOverview({ monthlyRent: t.monthlyRent ?? null, camMonthly: t.camMonthly ?? null, parkingMonthly: t.parkingMonthly ?? null, otherMonthly: t.otherMonthly ?? null, securityDeposit: t.securityDeposit ?? null, expiry: exp }, today);
}

// ------------------------------------------------------------------ renewals (§5)
export const RENEWAL_STAGES = ["upcoming", "discussion", "proposal_pending", "negotiation", "approval_pending", "agreed", "completed", "at_risk", "declined"] as const;
export async function openRenewal(w: W, leaseId: string, note?: string | null) {
  const open = (await w.db.from("lease_renewal").select("*").eq("workspace_id", w.ws).eq("lease_id", leaseId).not("stage", "in", "(completed,declined)").maybeSingle()).data;
  if (open) return open as Row;
  const r = must(await w.db.from("lease_renewal").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, stage: "upcoming", log: [{ at: new Date().toISOString(), by: w.userId, note: note ?? "Renewal review opened" }] }).select("*").single(), "renewal");
  await w.db.from("task").insert({ workspace_id: w.ws, owner_user_id: w.userId, assigned_user_id: w.userId, title: "Lease renewal review", status: "open", priority: 2,
    description: "Review existing terms, notice deadlines, escalation and alternatives before discussing renewal with the client.", linked_entity_type: "lease", linked_entity_id: leaseId,
    source: "leases", idempotency_key: `lease_renewal:${r.id}` });
  return r;
}
export async function updateRenewal(w: W, id: string, i: { stage?: string; landlordResponse?: string | null; tenantResponse?: string | null; proposedTerms?: CommercialTerms | null; note?: string | null }) {
  const r = must(await w.db.from("lease_renewal").select("*").eq("workspace_id", w.ws).eq("id", id).maybeSingle(), "renewal") as Row;
  if (i.stage && !(RENEWAL_STAGES as readonly string[]).includes(i.stage)) throw new LeaseError("Unknown stage.");
  const patch: Row = { log: [...(r.log ?? []), { at: new Date().toISOString(), by: w.userId, stage: i.stage ?? r.stage, note: i.note ?? null }] };
  if (i.stage) patch.stage = i.stage;
  if (i.landlordResponse !== undefined) patch.landlord_response = i.landlordResponse;
  if (i.tenantResponse !== undefined) patch.tenant_response = i.tenantResponse;
  if (i.proposedTerms) patch.proposed_terms = i.proposedTerms;
  if (i.stage === "agreed") { patch.decision = "renew"; patch.decided_by = w.userId; patch.decided_at = new Date().toISOString(); }
  return must(await w.db.from("lease_renewal").update(patch).eq("workspace_id", w.ws).eq("id", id).select("*").single(), "update renewal");
}
export async function renewalPipeline(w: W, today: string) {
  const { data } = await w.db.from("lease_renewal").select("*").eq("workspace_id", w.ws).is("archived_at", null);
  const rows = (data ?? []) as Row[];
  const leases = await listLeases(w);
  const byId = new Map(leases.map((l) => [l.id, l]));
  const deadlines = await upcomingDates(w, { from: today, to: addDays(today, 730), types: ["renewal_notice_deadline", "expiry"], includeUnverified: true });
  const enriched = rows.filter((r) => byId.has(r.lease_id)).map((r): Row => {
    const dl = deadlines.filter((d) => d.lease_id === r.lease_id).sort((a, b) => a.calculated_date.localeCompare(b.calculated_date))[0] ?? null;
    const days = dl ? daysBetween(today, dl.calculated_date) : null;
    const atRisk = r.stage === "at_risk" || (days !== null && days <= 60 && !["agreed", "completed", "declined"].includes(r.stage));
    return { ...r, lease: byId.get(r.lease_id) ?? null, nextDeadline: dl, daysToDeadline: days, atRisk, immediate: days !== null && days <= 30 && !["agreed", "completed", "declined"].includes(r.stage) };
  });
  // leases with an expiry within 12 months and no renewal record yet = "upcoming"
  const upcoming = deadlines.filter((d) => d.date_type === "expiry" && daysBetween(today, d.calculated_date) <= 365 && !rows.some((r) => r.lease_id === d.lease_id))
    .filter((d, i, a) => a.findIndex((x) => x.lease_id === d.lease_id) === i);
  return { renewals: enriched, upcomingWithoutRecord: upcoming };
}

/**
 * Renewal vs relocation decision support (§5.3) — reuses Module 8's deterministic rvr-1.0 calc with the CURRENT
 * lease terms. Shows assumptions and missing data; never returns a recommendation (decision is the user's).
 */
export async function renewalDecisionSupport(w: W, leaseId: string, i: { proposedRentMonthly?: number | null; proposedCamMonthly?: number | null; extensionMonths?: number | null; relocation?: Partial<RvrInput["relocation"]>; discountRatePct?: number | null }) {
  const d = await getLease(w, leaseId);
  if (!d) throw new LeaseError("Lease not found.", "not_found");
  const t = d.currentTerms;
  const esc = t.escalation && t.escalation.pct != null && t.escalation.everyMonths ? { pct: t.escalation.pct, everyMonths: t.escalation.everyMonths } : null;
  const input: RvrInput = {
    renewal: { currentRentMonthly: t.monthlyRent ?? null, proposedRentMonthly: i.proposedRentMonthly ?? null, escalation: esc, extensionMonths: i.extensionMonths ?? null, rentFreeMonths: null, camMonthly: i.proposedCamMonthly ?? t.camMonthly ?? null, depositChange: null, refurbishment: null, maintenanceMonthly: null, otherMonthly: t.otherMonthly ?? null, otherOneOff: null },
    relocation: { newRentMonthly: null, escalation: null, rentFreeMonths: null, camMonthly: null, deposit: null, fitout: null, moving: null, restorationOld: null, overlapMonths: null, brokerage: null, itRelocation: null, downtimeCost: null, employeeTransition: null, otherMonthly: null, otherOneOff: null, ...(i.relocation ?? {}) },
    comparisonMonths: i.extensionMonths ?? null, discountRatePct: i.discountRatePct ?? null,
  };
  let result: ReturnType<typeof compareRenewalRelocation> | null = null; let error: string | null = null;
  try { result = compareRenewalRelocation(input); } catch (e) { error = (e as Error).message; }
  return {
    existing: { monthlyRent: t.monthlyRent ?? null, camMonthly: t.camMonthly ?? null, escalation: t.escalation ?? null, securityDeposit: t.securityDeposit ?? null },
    result, error, recommendation: null as null,
    note: "Decision support only. Renewal is not recommended merely because it avoids relocation, and relocation is not recommended without full cost and operational impact. Missing values are listed, never treated as zero.",
  };
}

// ------------------------------------------------------------------ termination (§7.3), handover (§11), obligations (§10)
/**
 * B7: once a termination notice is recorded as served (with its notice date as evidence), the lease lifecycle moves to
 * "Termination notice served" through the normal evidence gate. Skipped (not forced) when the transition is not allowed.
 */
async function syncTerminationStatus(w: W, t: Row) {
  if (t.status !== "notice_served" || !t.notice_date) return;
  const lease = (await w.db.from("lease").select("lifecycle_status").eq("workspace_id", w.ws).eq("id", t.lease_id).maybeSingle()).data;
  if (!lease || !isLeaseStatus(lease.lifecycle_status) || !nextStatuses(lease.lifecycle_status).includes("termination_notice_served")) return;
  await setStatus(w, t.lease_id, "termination_notice_served", { noticeDate: t.notice_date, note: `Termination notice served on ${t.notice_date} (recorded in termination record)`, today: new Date().toISOString().slice(0, 10) });
}
export async function startTermination(w: W, leaseId: string, i: { reason?: string | null; initiatedOn?: string | null; noticeDate?: string | null; noticePeriodText?: string | null; proposedDate?: string | null; depositAmount?: number | null }) {
  const t = must(await w.db.from("lease_termination").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, reason: i.reason ?? null, initiated_on: i.initiatedOn ?? null, notice_date: i.noticeDate ?? null,
    notice_period_text: i.noticePeriodText ?? null, proposed_date: i.proposedDate ?? null, deposit_amount: i.depositAmount ?? null, status: i.noticeDate ? "notice_served" : "initiated" }).select("*").single(), "termination") as Row;
  await syncTerminationStatus(w, t);
  return t;
}
export async function updateTermination(w: W, id: string, patch: { confirmedDate?: string | null; status?: string; settlementAmount?: number | null; depositRecovered?: number | null; depositStatus?: string; outstanding?: unknown[] }) {
  const p: Row = {};
  if (patch.confirmedDate !== undefined) p.confirmed_date = patch.confirmedDate;
  if (patch.status) p.status = patch.status;
  if (patch.settlementAmount !== undefined) p.settlement_amount = patch.settlementAmount;
  if (patch.depositRecovered !== undefined) p.deposit_recovered = patch.depositRecovered;
  if (patch.depositStatus) p.deposit_status = patch.depositStatus;
  if (patch.outstanding) p.outstanding = patch.outstanding;
  const t = must(await w.db.from("lease_termination").update(p).eq("workspace_id", w.ws).eq("id", id).select("*").single(), "update termination") as Row;
  if (patch.status === "notice_served") await syncTerminationStatus(w, t);
  return t;
}
/** Deposit recovery state from records only: amount recovered vs deposit; unknown when either is unknown. */
export function depositRecovery(t: Row) {
  if (t.deposit_amount == null || t.deposit_recovered == null) return { status: t.deposit_status as string, outstanding: null as string | null };
  const out = Number(t.deposit_amount) - Number(t.deposit_recovered);
  return { status: out <= 0 ? "recovered" : Number(t.deposit_recovered) > 0 ? "partially_recovered" : "pending", outstanding: out.toFixed(2) };
}

export async function initHandover(w: W, leaseId: string, items: string[] = DEFAULT_HANDOVER) {
  const { data: ex } = await w.db.from("lease_handover_item").select("id").eq("workspace_id", w.ws).eq("lease_id", leaseId).limit(1);
  if (ex?.length) return { created: 0 };
  const r = await w.db.from("lease_handover_item").insert(items.map((label, sort) => ({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, label, sort })));
  if (r.error) throw new LeaseError(r.error.message, "db");
  return { created: items.length };
}
export async function addHandoverItem(w: W, leaseId: string, label: string) {
  const { data: last } = await w.db.from("lease_handover_item").select("sort").eq("workspace_id", w.ws).eq("lease_id", leaseId).order("sort", { ascending: false }).limit(1).maybeSingle();
  return must(await w.db.from("lease_handover_item").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, label, sort: (last?.sort ?? -1) + 1 }).select("*").single(), "handover item");
}
export async function setHandoverItem(w: W, id: string, status: "pending" | "done" | "not_applicable", evidence?: string | null) {
  if (status === "done" && !evidence?.trim()) throw new LeaseError("Record the evidence (who/what/when) to mark this item done.", "evidence_required");
  return must(await w.db.from("lease_handover_item").update({ status, evidence_note: evidence ?? null, done_at: status === "done" ? new Date().toISOString() : null, done_by: status === "done" ? w.userId : null }).eq("workspace_id", w.ws).eq("id", id).select("*").single(), "handover");
}

export async function addObligation(w: W, leaseId: string, i: { category: string; description: string; responsible?: "tenant" | "landlord" | "shared" | "unclear"; deadline?: string | null; assignedUserId?: string | null; clauseText?: string | null }) {
  return must(await w.db.from("lease_obligation").insert({ workspace_id: w.ws, owner_user_id: w.userId, lease_id: leaseId, category: i.category, description: i.description, responsible: i.responsible ?? "unclear", deadline: i.deadline ?? null, assigned_user_id: i.assignedUserId ?? null, clause_text: i.clauseText ?? null }).select("*").single(), "obligation");
}
export async function setObligationStatus(w: W, id: string, status: "open" | "in_progress" | "done" | "waived", evidence?: string | null) {
  if ((status === "done" || status === "waived") && !evidence?.trim()) throw new LeaseError("Completion evidence is required.", "evidence_required");
  return must(await w.db.from("lease_obligation").update({ status, evidence_note: evidence ?? null, completed_at: status === "done" ? new Date().toISOString() : null }).eq("workspace_id", w.ws).eq("id", id).select("*").single(), "obligation");
}
export async function obligationTracker(w: W, f: { status?: string; responsible?: string } = {}) {
  let q = w.db.from("lease_obligation").select("*").eq("workspace_id", w.ws).is("archived_at", null).order("deadline", { ascending: true, nullsFirst: false }).limit(500);
  if (f.status) q = q.eq("status", f.status);
  if (f.responsible) q = q.eq("responsible", f.responsible);
  const rows = (must(await q, "obligations") as Row[]);
  const docIds = [...new Set(rows.map((r) => r.document_id).filter(Boolean))];
  const docs = docIds.length ? (await w.db.from("lease_document").select("id, title, version").in("id", docIds)).data ?? [] : [];
  const leases = new Map((await listLeases(w)).map((l) => [l.id, l]));
  return dedupeObligations(rows.filter((r) => leases.has(r.lease_id)))
    .map((r): Row => ({ ...r, document: docs.find((d: Row) => d.id === r.document_id) ?? null, lease: leases.get(r.lease_id) ?? null }));
}

/** Same obligation extracted twice (re-upload / re-extract) → keep one; a manually progressed row wins over an open duplicate. */
export function dedupeObligations<T extends Row>(rows: T[]): T[] {
  const rank = (s?: string | null) => (s === "done" || s === "waived" ? 2 : s === "in_progress" ? 1 : 0);
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = [r.lease_id, r.category, String(r.description ?? "").trim().toLowerCase().replace(/\s+/g, " "), r.deadline ?? "", r.responsible ?? ""].join("|");
    const cur = best.get(k);
    if (!cur || rank(r.status) > rank(cur.status)) best.set(k, r);
  }
  const keep = new Set(best.values());
  return rows.filter((r) => keep.has(r));
}

// ------------------------------------------------------------------ portfolio (§12) & dashboard
export async function portfolioView(w: W, today: string, f: Parameters<typeof listLeases>[1] = {}) {
  const leases = await listLeases(w, f);
  const ids = leases.map((l) => l.id);
  const idSet = new Set(ids);
  const terms = ((await w.db.from("lease_term_version").select("lease_id, terms").eq("workspace_id", w.ws).eq("status", "current").limit(10000)).data ?? []).filter((t: Row) => idSet.has(t.lease_id)) as Row[];
  const dates = (await liveDates(w)).filter((d) => idSet.has(d.lease_id));
  const p = portfolio(leases.map((l) => {
    const t = (terms.find((x) => x.lease_id === l.id)?.terms ?? {}) as CommercialTerms;
    const missing: string[] = [];
    if (t.monthlyRent == null) missing.push("rent");
    if (l.area_sf == null) missing.push("area");
    if (!dates.some((d) => d.lease_id === l.id && d.date_type === "expiry" && d.verification_status === "confirmed")) missing.push("confirmed expiry");
    if (dates.some((d) => d.lease_id === l.id && ["needs_review", "conflicting"].includes(d.verification_status))) missing.push("dates awaiting review");
    return { id: l.id, lifecycle_status: l.lifecycle_status, area_sf: l.area_sf == null ? null : Number(l.area_sf), area_basis: l.area_basis, monthly_rent: t.monthlyRent ?? null, missing };
  }));
  const soon = await upcomingDates(w, { from: today, to: addDays(today, 365) });
  const count = (t: string) => soonLive.filter((d) => d.date_type === t).length;
  const soonLive = soon.filter((d) => idSet.has(d.lease_id));
  // counts only for live (non-archived, filter-matching) leases
  const obl = ((await w.db.from("lease_obligation").select("lease_id, category, description, deadline, responsible, status").eq("workspace_id", w.ws).in("status", ["open", "in_progress"]).is("archived_at", null).limit(10000)).data ?? []) as Row[];
  const pendingObl = dedupeObligations(obl.filter((o) => idSet.has(o.lease_id))).length;
  const review = dates.filter((d) => ["needs_review", "conflicting", "calculated", "extracted"].includes(d.verification_status)).length;
  return { leases, portfolio: p, upcoming: { expiries: count("expiry"), renewalDeadlines: count("renewal_notice_deadline"), escalations: count("escalation"), lockins: count("lockin_end"), breaks: count("break_option"), notices: count("termination_notice_deadline") },
    terminationPipeline: leases.filter((l) => ["termination_notice_served"].includes(l.lifecycle_status) || l.termination_status).length, pendingObligations: pendingObl, datesAwaitingReview: review };
}

async function liveDates(w: W, types?: string[]): Promise<Row[]> {
  let q = w.db.from("lease_date").select("*").eq("workspace_id", w.ws).is("archived_at", null).is("superseded_by", null).limit(10000);
  if (types) q = q.in("date_type", types);
  return ((await q).data ?? []) as Row[];
}

// ------------------------------------------------------------------ opportunities (§13) — potential only
export async function scanOpportunities(w: W, today: string) {
  const leases = await listLeases(w);
  if (!leases.length) return [];
  const data = await liveDates(w, ["expiry", "lockin_end", "escalation", "break_option"]);
  const opps = identifyOpportunities(leases.map((l) => ({ id: l.id, tenant_org_id: l.tenant_org_id, tenant_name: l.tenant_name, lifecycle_status: l.lifecycle_status })), data as DateRow[], today);
  for (const o of opps) {
    await safePublish(w, { type: "lease.opportunity_identified", subjectType: "lease", subjectId: o.lease_id, dedupeKey: o.dedupe_key,
      payload: { kind: o.kind, org_id: o.org_id, due: o.due, basis: o.basis, label: "potential", next_action: o.next_action, note: "Potential opportunity — not a confirmed requirement or relocation." } });
  }
  return opps;
}

/** Alternative supply for a lease (Module 14 data via RLS): available spaces in the same micro-market, area ±25%. Shortlisting stays in deals/matching. */
export async function alternativeProperties(w: W, leaseId: string, limit = 10) {
  const lease = (await w.db.from("lease").select("id, asset_id, area_sf, micro_market").eq("workspace_id", w.ws).eq("id", leaseId).maybeSingle()).data as Row | null;
  if (!lease) throw new LeaseError("Lease not found.", "not_found");
  const mm = lease.asset_id ? (await w.db.from("asset").select("micro_market_id").eq("id", lease.asset_id).maybeSingle()).data?.micro_market_id ?? null : null;
  const { data: av } = await w.db.from("availability").select("id, status, available_from, asking_rent_min, asking_rent_max, rent_basis, fact_status, last_verified_on, space:space_id(id, asset_id, chargeable_sf, carpet_sf, floor_text, asset:asset_id(id, name, micro_market_id))")
    .eq("workspace_id", w.ws).eq("status", "available").is("archived_at", null).order("created_at", { ascending: false }).limit(500);
  const area = lease.area_sf == null ? null : Number(lease.area_sf);
  const out = ((av ?? []) as Row[]).map((a) => {
    const s = a.space as Row | null; const as = (s?.asset ?? null) as Row | null;
    const sf = s?.chargeable_sf ?? s?.carpet_sf ?? null;
    const areaFit = area && sf ? Math.abs(Number(sf) - area) / area <= 0.25 : null;
    return { availabilityId: a.id as string, asset: (as?.name ?? null) as string | null, assetId: (as?.id ?? null) as string | null, floor: (s?.floor_text ?? null) as string | null, areaSf: sf as number | null, askingRent: [a.asking_rent_min, a.asking_rent_max], rentBasis: a.rent_basis, availableFrom: a.available_from, verifiedOn: a.last_verified_on,
      sameMicroMarket: mm && as ? as.micro_market_id === mm : null, areaFit, factStatus: a.fact_status as string };
  }).filter((x) => x.assetId !== lease.asset_id && x.areaFit !== false && x.sameMicroMarket !== false);
  return { items: out.slice(0, limit), basis: { areaSf: area, microMarketKnown: !!mm }, note: "Supply as recorded in Module 14 — verify availability before sharing. Shortlisting/scoring happens in Requirements → matching." };
}

/** Lease history for meeting briefs (Module 7) and outreach context (Module 5): confirmed facts only, with sources. */
export async function leaseContextForOrg(w: W, orgId: string, today: string) {
  const leases = await listLeases(w, { orgId });
  const out = [];
  for (const l of leases) {
    const { data } = await w.db.from("lease_date").select("date_type, calculated_date, verification_status, page, document_id, clause_text").eq("workspace_id", w.ws).eq("lease_id", l.id).is("archived_at", null).is("superseded_by", null).gte("calculated_date", addDays(today, -365));
    out.push({ leaseId: l.id, asset: l.asset_name, status: l.lifecycle_status, dates: (data ?? []).map((d: Row) => ({ ...d, contractual: d.verification_status === "confirmed" })) });
  }
  return out;
}

// ------------------------------------------------------------------ Module 16 hand-off (docs/lease-lifecycle/CONTRACT.md)
export interface ExecutedLeaseInput {
  leaseId?: string | null; tenantOrgId?: string | null; landlordOrgId?: string | null; assetId?: string | null; spaceId?: string | null; tenantNameRaw?: string | null;
  reference?: string | null; category?: LeaseCategory; floor?: string | null; unit?: string | null; microMarket?: string | null; executionDate?: string | null;
  terms?: CommercialTerms; document?: { title: string; docType: DocType; executionState: "executed" | "signed"; text?: string | null; pages?: string[] | null; sourceObjectId?: string | null; storagePath?: string | null } | null;
  contactPersonIds?: string[];
}
export async function receiveExecutedLease(w: W, transactionId: string, input: ExecutedLeaseInput & { today?: string }) {
  const warnings: string[] = [];
  let lease = input.leaseId ? (await w.db.from("lease").select("*").eq("workspace_id", w.ws).eq("id", input.leaseId).maybeSingle()).data as Row | null
    : (await w.db.from("lease").select("*").eq("workspace_id", w.ws).eq("transaction_id", transactionId).is("archived_at", null).maybeSingle()).data as Row | null;
  let created = false;
  if (!lease) {
    lease = await createLease(w, { tenantOrgId: input.tenantOrgId, tenantNameRaw: input.tenantNameRaw, landlordOrgId: input.landlordOrgId, assetId: input.assetId, spaceId: input.spaceId, reference: input.reference,
      category: input.category, floor: input.floor, unit: input.unit, microMarket: input.microMarket, status: "awaiting_execution", transactionId, contactPersonIds: input.contactPersonIds });
    created = true;
  } else if (!lease.transaction_id && input.leaseId) {
    await w.db.from("lease").update({ transaction_id: transactionId }).eq("workspace_id", w.ws).eq("id", lease.id);
  }
  if (input.terms && Object.keys(input.terms).length) await addTermVersion(w, lease.id, { terms: input.terms, source: "transaction", note: `From transaction ${transactionId} — confirm against the executed agreement` });
  let documentId: string | null = null; let dateIds: string[] = [];
  if (input.document) {
    const r = await addDocument(w, lease.id, { ...input.document, origin: "transaction" });
    documentId = r.document.id; dateIds = r.dates.map((d) => d.id);
  } else warnings.push("No executed document supplied — lease stays 'awaiting execution'.");
  let status = lease.lifecycle_status as LeaseStatus;
  if (documentId && input.executionDate && ["awaiting_execution", "draft", "under_negotiation", "awaiting_approval"].includes(status)) {
    // walk the allowed path; each step audited in lease_status_history
    for (const step of (["under_negotiation", "awaiting_execution", "executed"] as LeaseStatus[]).slice(status === "draft" ? 0 : status === "under_negotiation" || status === "awaiting_approval" ? 1 : 2)) {
      await setStatus(w, lease.id, step, { documentId, executionDate: input.executionDate, note: `Executed via transaction ${transactionId}`, today: input.today ?? new Date().toISOString().slice(0, 10) });
    }
    status = "executed";
  } else if (!input.executionDate) warnings.push("Execution date missing — status not changed to executed.");
  await safePublish(w, { type: "lease.executed_received", subjectType: "lease", subjectId: lease.id, payload: { transaction_id: transactionId, document_id: documentId }, dedupeKey: `lease:${lease.id}:tx:${transactionId}:${documentId ?? "nodoc"}` });
  return { leaseId: lease.id as string, created, documentId, dateIds, status, warnings };
}

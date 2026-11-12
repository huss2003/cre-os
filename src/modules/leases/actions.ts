"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { localDate } from "@/lib/util/time";
import * as svc from "./service";
import { backUrl } from "./url";
import type { CommercialTerms, DocType, ExecState } from "./service";
import type { LeaseCategory, LeaseStatus } from "./status";

const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === "string" ? v.trim() : ""; };
const o = (f: FormData, k: string) => s(f, k) || null;
/** Blank stays unknown (null) — never 0. */
const n = (f: FormData, k: string): number | null => { const v = s(f, k).replace(/,/g, ""); if (!v) return null; const x = Number(v); if (!Number.isFinite(x)) throw new Error(`"${k}" must be a number`); return x; };
async function who() { const c = await requireContext("editor"); return { db: c.db, ws: c.workspaceId, userId: c.userId }; }

async function run(path: string, fn: () => Promise<string | void>) {
  let target = path; let msg: { ok?: string; err?: string } = {};
  try { const r = await fn(); if (typeof r === "string") target = r; msg = { ok: "Saved." }; }
  catch (e) { msg = { err: e instanceof Error ? e.message.slice(0, 400) : "Something went wrong" }; }
  revalidatePath("/leases", "layout");
  redirect(backUrl(target, msg));
}

function termsFrom(f: FormData): CommercialTerms {
  const t: CommercialTerms = {
    monthlyRent: n(f, "rent"), rentPerSf: n(f, "rent_psf"), chargeableArea: n(f, "area"), areaBasis: (o(f, "area_basis") as CommercialTerms["areaBasis"]) ?? null,
    camMonthly: n(f, "cam"), parkingMonthly: n(f, "parking"), securityDeposit: n(f, "deposit"), termMonths: n(f, "term"), lockinMonths: n(f, "lockin"),
    noticePeriod: o(f, "notice"),
  };
  const pct = n(f, "esc_pct"); const every = n(f, "esc_every");
  if (pct != null || every != null) t.escalation = { basis: (o(f, "esc_basis") as "compounding" | "on_original" | "unknown") ?? "unknown", pct, everyMonths: every, clauseText: o(f, "esc_clause") };
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v != null)) as CommercialTerms;
}

export async function createLeaseAction(f: FormData) {
  await run("/leases/new", async () => {
    const w = await who();
    const l = await svc.createLease(w, { tenantOrgId: o(f, "tenant_org_id"), tenantNameRaw: o(f, "tenant_name"), landlordOrgId: o(f, "landlord_org_id"), assetId: o(f, "asset_id"),
      reference: o(f, "reference"), category: (o(f, "category") as LeaseCategory) ?? undefined, status: (o(f, "status") as LeaseStatus) ?? "draft", floor: o(f, "floor"), unit: o(f, "unit"),
      microMarket: o(f, "micro_market"), commencement: o(f, "commencement"), expiry: o(f, "expiry"), terms: termsFrom(f) });
    return `/leases/${l.id}`;
  });
}
export async function setStatusAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}`, async () => { await svc.setStatus(await who(), id, s(f, "to"), { documentId: o(f, "document_id"), executionDate: o(f, "execution_date"), noticeDate: o(f, "notice_date"), note: o(f, "note"), today: localDate() }); });
}
export async function uploadDocumentAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}`, async () => {
    const file = f.get("file");
    let text = s(f, "text");
    if (file instanceof File && file.size > 0) {
      if (file.size > 10 * 1024 * 1024) throw new Error("File too large (10 MB max here; use Capture for scans).");
      if (/text|csv|json/.test(file.type) || /\.txt$/i.test(file.name)) text = await file.text();
      else throw new Error("Paste the document text, or upload it through Capture → Documents (OCR/PDF) and link it to this lease.");
    }
    const r = await svc.addDocument(await who(), id, { title: s(f, "title") || (file instanceof File ? file.name : "Document"), docType: s(f, "doc_type") as DocType, executionState: s(f, "execution_state") as ExecState, text });
    if (r.duplicate) throw new Error("This exact document is already attached.");
  });
}
export async function confirmDateAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#dates`, async () => { await svc.confirmDate(await who(), s(f, "date_id"), { date: o(f, "date"), note: o(f, "note"), today: localDate() }); });
}
export async function rejectDateAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#dates`, async () => { await svc.rejectDate(await who(), s(f, "date_id"), s(f, "note") || "rejected"); });
}
export async function addDateAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#dates`, async () => {
    const w = await who();
    const clause = o(f, "clause");
    const type = s(f, "date_type");
    if (!o(f, "date") && clause) await svc.calculateDate(w, id, { dateType: type as "lockin_end", clauseText: clause, months: n(f, "months") });
    else await svc.addManualDate(w, id, { dateType: type, date: s(f, "date"), clauseText: clause });
  });
}
export async function confirmTermsAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#terms`, async () => { const w = await who(); if (s(f, "op") === "reject") await svc.rejectTermVersion(w, s(f, "version_id")); else await svc.confirmTermVersion(w, s(f, "version_id")); });
}
export async function addAmendmentAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#terms`, async () => { await svc.addTermVersion(await who(), id, { terms: termsFrom(f), source: "amendment", effectiveFrom: o(f, "effective_from"), note: o(f, "note") }); });
}
export async function renewalAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#renewal`, async () => {
    const w = await who();
    if (s(f, "op") === "open") { await svc.openRenewal(w, id, o(f, "note")); return; }
    await svc.updateRenewal(w, s(f, "renewal_id"), { stage: o(f, "stage") ?? undefined, landlordResponse: o(f, "landlord_response") ?? undefined, tenantResponse: o(f, "tenant_response") ?? undefined, note: o(f, "note") });
  });
}
export async function terminationAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#termination`, async () => {
    const w = await who();
    if (s(f, "op") === "start") { await svc.startTermination(w, id, { reason: o(f, "reason"), noticeDate: o(f, "notice_date"), noticePeriodText: o(f, "notice_period"), proposedDate: o(f, "proposed_date"), depositAmount: n(f, "deposit") }); return; }
    await svc.updateTermination(w, s(f, "termination_id"), { confirmedDate: o(f, "confirmed_date") ?? undefined, depositRecovered: n(f, "deposit_recovered") ?? undefined, depositStatus: o(f, "deposit_status") ?? undefined, status: o(f, "status") ?? undefined, settlementAmount: n(f, "settlement") ?? undefined });
  });
}
export async function handoverAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#handover`, async () => {
    const w = await who();
    const op = s(f, "op");
    if (op === "init") await svc.initHandover(w, id);
    else if (op === "add") await svc.addHandoverItem(w, id, s(f, "label"));
    else await svc.setHandoverItem(w, s(f, "item_id"), s(f, "status") as "done", o(f, "evidence"));
  });
}
export async function obligationAction(f: FormData) {
  const id = s(f, "lease_id"); const ret = s(f, "return") || `/leases/${id}#obligations`;
  await run(ret, async () => {
    const w = await who();
    if (s(f, "op") === "add") await svc.addObligation(w, id, { category: s(f, "category") || "other", description: s(f, "description"), responsible: (o(f, "responsible") as "tenant") ?? "unclear", deadline: o(f, "deadline") });
    else await svc.setObligationStatus(w, s(f, "obligation_id"), s(f, "status") as "done", o(f, "evidence"));
  });
}
export async function financialAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#finance`, async () => { await svc.addFinancialRecord(await who(), id, { kind: s(f, "kind"), amount: n(f, "amount") ?? NaN, onDate: o(f, "on_date"), period: o(f, "period"), note: o(f, "note") }); });
}
export async function remindersAction(f: FormData) {
  const id = s(f, "lease_id");
  await run(`/leases/${id}#reminders`, async () => { const w = await who(); if (s(f, "op") === "done") await svc.completeReminder(w, s(f, "reminder_id")); else await svc.syncReminders(w, id, localDate()); });
}

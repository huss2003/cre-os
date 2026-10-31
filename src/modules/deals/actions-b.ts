"use server";
/**
 * Server Actions for the deals "execution" half (deals-B): closing checklist details, document regeneration, fee
 * terms / invoice details and the official-finance CSV reconciliation. Same pattern as actions.ts: run as the
 * signed-in user (RLS), redirect back with ?msg= / ?err=.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/auth/context";
import { toDealsCtx } from "./api";
import { DealsError, type DealsCtx } from "./ctx";
import { updateMilestoneDetails, type MilestoneEdit } from "./pipeline/closing-service";
import { recordFeeMilestone, updateFeeMilestone } from "./pipeline/service";
import { regenerateDocument } from "./documents/service";
import { importFinanceCsv, MAX_IMPORT_BYTES } from "./fees/recon-service";
import type { FeeRowB } from "./fees/ledger";

const s = (f: FormData, k: string) => { const v = f.get(k); return v === null || v instanceof File ? "" : String(v).trim(); };
const n = (f: FormData, k: string) => { const v = s(f, k); if (v === "") return null; const x = Number(v.replace(/,/g, "")); return Number.isFinite(x) ? x : null; };
const opt = (f: FormData, k: string) => s(f, k) || null;

function errText(e: unknown): string {
  if (e instanceof DealsError) {
    const d = e.details as { reasons?: string[]; issues?: { message: string }[] } | undefined;
    return [e.message, ...(d?.reasons ?? d?.issues?.map((i) => i.message) ?? [])].join(" · ").slice(0, 600);
  }
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message).slice(0, 400);
  return "Something went wrong";
}
const withParam = (path: string, k: string, v: string) => `${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;

async function run(back: string, minRole: "editor" | "admin", fn: (ctx: DealsCtx) => Promise<string | { to?: string; msg?: string } | void>, okMsg = "Saved") {
  let dest = back, msg = okMsg, err: string | null = null;
  try {
    const r = await fn(toDealsCtx(await requireContext(minRole)));
    if (typeof r === "string") dest = r;
    else if (r) { dest = r.to ?? back; msg = r.msg ?? okMsg; }
  } catch (e) { err = errText(e); }
  revalidatePath(back.split("?")[0]);
  redirect(err ? withParam(back, "err", err) : withParam(dest, "msg", msg));
}

// ---------------------------------------------------------------- 17 closing checklist
export async function updateMilestoneDetailsAction(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => {
    const edit: MilestoneEdit = {};
    if (f.has("status")) edit.status = s(f, "status");
    if (f.has("proof_text")) edit.proofText = opt(f, "proof_text");
    if (f.has("due_date")) edit.dueDate = opt(f, "due_date");
    if (f.has("assignee_user_id")) edit.assigneeUserId = opt(f, "assignee_user_id");
    if (f.has("owner_note")) edit.ownerNote = opt(f, "owner_note");
    if (f.has("depends_on")) edit.dependsOn = opt(f, "depends_on");
    await updateMilestoneDetails(ctx, s(f, "milestone_id"), edit);
  }, "Checklist item updated");
}

// ---------------------------------------------------------------- 21 fee terms / events
export async function feeActionB(f: FormData) {
  const id = s(f, "id");
  await run(`/deals/${id}`, "editor", async (ctx) => {
    const pct = n(f, "credit_share_pct");
    const row: FeeRowB = {
      gross_fee: n(f, "gross_fee"), credit_share: pct === null ? null : pct / 100, milestone: opt(f, "milestone"),
      contractual_amount: n(f, "contractual_amount"), contract_ref: opt(f, "contract_ref"), attributed_on: opt(f, "attributed_on"), attribution_ref: opt(f, "attribution_ref"),
      invoiced_amount: n(f, "invoiced_amount"), invoiced_on: opt(f, "invoiced_on"), invoice_no: opt(f, "invoice_no"), invoice_due_on: opt(f, "invoice_due_on"),
      recognised_amount: n(f, "recognised_amount"), recognised_on: opt(f, "recognised_on"),
      collected_amount: n(f, "collected_amount"), collected_on: opt(f, "collected_on"), evidence: opt(f, "evidence"), deal_milestone_id: opt(f, "deal_milestone_id"),
    };
    if (s(f, "milestone_id")) await updateFeeMilestone(ctx, s(f, "milestone_id"), Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)));
    else await recordFeeMilestone(ctx, id, row);
  }, "Fee record saved");
}

// ---------------------------------------------------------------- 12 documents
export async function regenerateDocumentAction(f: FormData) {
  await run("/documents", "editor", async (ctx) => {
    const r = await regenerateDocument(ctx, s(f, "id"));
    const d = r.document as { version_no: number };
    return { msg: `Version ${d.version_no} generated from current inputs — earlier versions are kept${r.warnings.length ? `. ${r.warnings.join(" ")}` : ""}` };
  });
}

// ---------------------------------------------------------------- 21 official finance reconciliation
export async function importFinanceCsvAction(f: FormData) {
  await run("/fees/reconcile", "editor", async (ctx) => {
    const file = f.get("file");
    if (!(file instanceof File) || file.size === 0) throw new DealsError(400, "choose the CSV exported from your finance system");
    if (file.size > Math.min(MAX_IMPORT_BYTES, 1_000_000)) throw new DealsError(413, "file too large for the page upload (max 1 MB) — split it or use the API");
    const r = await importFinanceCsv(ctx, { fileName: file.name, text: await file.text(), sourceSystem: opt(f, "source_system") });
    const imp = r.import as { id: string; summary: Record<string, number> };
    return { to: `/fees/reconcile?import=${imp.id}`, msg: r.replayed ? "This file was already imported — showing the earlier result (nothing proposed twice)." : `Imported: ${imp.summary.matched ?? 0} matched, ${(imp.summary.mismatch ?? 0) + (imp.summary.missing_in_cre_os ?? 0)} need approval, ${imp.summary.unmatched ?? 0} unmatched.` };
  });
}

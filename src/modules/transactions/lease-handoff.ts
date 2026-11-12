import { receiveExecutedLease, type CommercialTerms } from "@/modules/leases/service";
import { findClauses, statedDates } from "@/modules/leases/extract";
import type { TxCtx } from "./ctx";
import { TxError } from "./ctx";
import { AGREED_STATUSES } from "./model";
import { record } from "./events";

/**
 * Module 15 hand-off (USER-RULES 2: Module 16 executes; Module 15 monitors after execution).
 *
 * Calls Module 15 `receiveExecutedLease` per docs/lease-lifecycle/CONTRACT.md (idempotent per transaction). Only agreed
 * terms are passed, as stated (no arithmetic: e.g. CAM per SF is NOT turned into a monthly amount). Module 15 keeps them
 * as a "proposed" term version until a human confirms them, and extracts dates from the executed text itself.
 * If the call fails, the payload is stored on tx_transaction.lease_handoff (status "pending_module_15") for replay.
 */
export interface ExecutedLeasePayload {
  source: "module16";
  transactionId: string;
  transactionCode: string;
  workspaceId: string;
  clientOrgId: string | null;
  clientName: string | null;
  requirementId: string | null;
  opportunityId: string | null;
  spaceIds: string[];
  propertyLabels: string[];
  /** Building resolved from the first space, else from a property label that names exactly one building. */
  assetId?: string | null;
  floor?: string | null;
  unit?: string | null;
  executedDocumentId: string;
  executedOn: string;
  /** Verified terms only where verified against the executed agreement; other agreed terms flagged verified=false. */
  terms: { key: string; label: string; value: string | null; status: string; verified: boolean }[];
  possession: { expectedOn: string | null; achievedOn: string | null };
  deposits: { type: string; amount: string | null; paidOn: string | null; refundable: boolean | null; refundConditions: string | null }[];
  /** Raw clause text for Module 15's own date/notice extraction (USER-RULES 1: source clause retained). */
  executedAgreementText: string;
}

export type LeaseReceiver = (ctx: TxCtx, p: ExecutedLeasePayload) => Promise<{ leaseId: string } | { pending: true; reason: string }>;

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const CATEGORY: Record<string, "conventional_office" | "managed_office" | "coworking" | "other"> = { conventional_leasing: "conventional_office", lease_renewal: "conventional_office", relocation: "conventional_office", managed_office: "managed_office", coworking: "coworking" };

const START_LINE = /\b(?:lease|licen[cs]e|term)\s+(?:start|starts|starting|begins?|beginning)\b|\bstart\s+date\b|\bcommenc\w*/i;

/**
 * Executed text → pages for Module 15's extractor. When the extractor finds no commencement clause but a line plainly
 * states a start date ("Lease start 1 March 2027"), a supplementary page restates it in the extractor's vocabulary,
 * quoting the source line. Dates stay proposed in Module 15 (extracted, never confirmed) — this only makes them visible.
 */
export function executedPages(text: string): string[] {
  const pages = text.split("\f");
  if (!text.trim() || findClauses(pages).some((c) => c.kind === "commencement")) return pages;
  const extra: string[] = [];
  for (const line of text.split(/\n|(?<=\.)\s+/)) {
    if (!START_LINE.test(line)) continue;
    const d = statedDates(line);
    if (d.length === 1) { extra.push(`Commencement date: ${d[0]} (as stated in the executed agreement: "${line.trim().slice(0, 200)}").`); break; }
  }
  return extra.length ? [...pages, extra.join("\n")] : pages;
}

/** Map Module 16 payload → Module 15 ExecutedLeaseInput (pure). */
export function toExecutedLeaseInput(p: ExecutedLeasePayload, txType: string) {
  const t = (k: string) => p.terms.find((x) => x.key === k)?.value ?? null;
  const basis = t("areaBasis");
  const terms: Partial<CommercialTerms> = {};
  if (num(t("rentPerSf")) !== undefined) terms.rentPerSf = num(t("rentPerSf"));
  if (num(t("areaSf")) !== undefined) { if (basis === "carpet") terms.carpetArea = num(t("areaSf")); else terms.chargeableArea = num(t("areaSf")); terms.areaBasis = basis === "carpet" ? "carpet" : basis ? "chargeable" : null; }
  if (num(t("rentFreeMonths")) !== undefined) terms.rentFreeMonths = num(t("rentFreeMonths"));
  if (num(t("tenureMonths")) !== undefined) terms.termMonths = num(t("tenureMonths"));
  if (num(t("lockInMonths")) !== undefined) terms.lockinMonths = num(t("lockInMonths"));
  const sec = p.deposits.filter((d) => /security/i.test(d.type) && d.amount !== null);
  if (sec.length === 1) terms.securityDeposit = num(sec[0].amount);
  if (t("breakClause")) terms.breakClause = t("breakClause");
  if (t("renewalOption")) terms.renewalOption = t("renewalOption");
  const asText = ["camPerSf", "depositMonths", "escalationPct", "escalationEveryMonths", "fitoutContribution", "possessionDate", "handover", "other"].filter((k) => t(k) !== null).map((k) => `${p.terms.find((x) => x.key === k)!.label}: ${t(k)}`);
  if (asText.length) terms.other = `As agreed in transaction ${p.transactionCode} (stated, not converted): ${asText.join("; ")}`;
  return {
    tenantOrgId: p.clientOrgId, tenantNameRaw: p.clientName, spaceId: p.spaceIds[0] ?? null, assetId: p.assetId ?? null, floor: p.floor ?? null, unit: p.unit ?? null, reference: p.transactionCode, category: CATEGORY[txType] ?? "other",
    executionDate: p.executedOn, terms,
    document: { title: `Executed agreement (${p.transactionCode})`, docType: "lease_agreement" as const, executionState: "executed" as const, pages: executedPages(p.executedAgreementText) },
  };
}

const defaultReceiver: LeaseReceiver = async (ctx, p) => {
  if (!p.clientOrgId) return { pending: true, reason: "link the client company to the transaction — Lease Lifecycle needs the tenant" };
  const tx = (await ctx.db.from("tx_transaction").select("tx_type").eq("id", p.transactionId).single()).data;
  try {
    const r = await receiveExecutedLease({ db: ctx.db, ws: ctx.workspaceId, userId: ctx.userId }, p.transactionId, toExecutedLeaseInput(p, tx?.tx_type ?? "other"));
    return { leaseId: r.leaseId };
  } catch (e) { return { pending: true, reason: `Module 15 receiveExecutedLease failed: ${e instanceof Error ? e.message : String(e)}` }; }
};
let receiver: LeaseReceiver = defaultReceiver;
export function registerLeaseReceiver(r: LeaseReceiver) { receiver = r; }

export async function buildExecutedLeasePayload(ctx: TxCtx, txId: string): Promise<ExecutedLeasePayload> {
  const tx = (await ctx.db.from("tx_transaction").select("*").eq("workspace_id", ctx.workspaceId).eq("id", txId).maybeSingle()).data;
  if (!tx) throw new TxError(404, "transaction not found");
  const ms = (await ctx.db.from("tx_milestone").select("*").eq("transaction_id", txId)).data ?? [];
  const exec = ms.find((m: any) => m.kind === "executed" && m.achieved_on);
  if (!exec?.document_id) throw new TxError(409, "agreement not executed — nothing to hand over to lease lifecycle");
  const doc = (await ctx.db.from("tx_document").select("id, body").eq("id", exec.document_id).single()).data;
  const pts = ((await ctx.db.from("tx_commercial_point").select("*").eq("transaction_id", txId).is("superseded_at", null).is("archived_at", null)).data ?? []).filter((p: any) => AGREED_STATUSES.includes(p.status));
  const deps = (await ctx.db.from("tx_deposit").select("*").eq("transaction_id", txId).is("archived_at", null)).data ?? [];
  const pos = ms.find((m: any) => m.kind === "possession_completed");
  const where = await resolveProperty(ctx, tx.space_ids ?? [], tx.property_labels ?? []);
  const org = tx.client_org_id ? (await ctx.db.from("organisation").select("display_name").eq("id", tx.client_org_id).maybeSingle()).data : null;
  return {
    source: "module16", transactionId: txId, transactionCode: tx.code, workspaceId: ctx.workspaceId, clientOrgId: tx.client_org_id, clientName: org?.display_name ?? null, requirementId: tx.requirement_id,
    opportunityId: tx.opportunity_id, spaceIds: tx.space_ids ?? [], propertyLabels: tx.property_labels ?? [], ...where, executedDocumentId: exec.document_id, executedOn: exec.achieved_on,
    terms: pts.map((p: any) => ({ key: p.term_key, label: p.label, value: p.value, status: p.status, verified: p.status === "verified_executed" })),
    possession: { expectedOn: pos?.expected_on ?? null, achievedOn: pos?.achieved_on ?? null },
    deposits: deps.map((d: any) => ({ type: d.deposit_type, amount: d.amount === null ? null : String(d.amount), paidOn: d.paid_on, refundable: d.refundable, refundConditions: d.refund_conditions })),
    executedAgreementText: doc?.body ?? "",
  };
}

/** Building / floor / unit for the hand-off: first linked space wins; else a label naming exactly one building. Unknown stays null. */
async function resolveProperty(ctx: TxCtx, spaceIds: string[], labels: string[]): Promise<{ assetId: string | null; floor: string | null; unit: string | null }> {
  if (spaceIds.length) {
    const s = (await ctx.db.from("space").select("asset_id, floor_text, unit").eq("workspace_id", ctx.workspaceId).eq("id", spaceIds[0]).maybeSingle()).data as { asset_id: string | null; floor_text: string | null; unit: string | null } | null;
    if (s?.asset_id) return { assetId: s.asset_id, floor: s.floor_text, unit: s.unit };
  }
  if (!labels.length) return { assetId: null, floor: null, unit: null };
  // candidate building names = contiguous word runs of each label (case-insensitive exact match on asset.name)
  const grams = new Set<string>();
  for (const l of labels) {
    const w = l.split(/[\s,;()|—–]+/).map((x) => x.replace(/[^\p{L}\p{N}&'./-]/gu, "")).filter(Boolean);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j <= Math.min(w.length, i + 6); j++) { const g = w.slice(i, j).join(" "); if (g.length > 2) grams.add(g); }
  }
  const list = [...grams].slice(0, 60).filter((g) => !/[%_*"\\]/.test(g));
  if (!list.length) return { assetId: null, floor: null, unit: null };
  const assets = ((await ctx.db.from("asset").select("id, name").eq("workspace_id", ctx.workspaceId).is("archived_at", null)
    .or(list.map((g) => `name.ilike."${g}"`).join(",")).limit(50)).data ?? []) as { id: string; name: string }[];
  for (const l of labels) {
    const low = l.toLowerCase();
    const hits = assets.filter((a) => a.name && a.name.trim().length > 2 && low.includes(a.name.toLowerCase()));
    const best = hits.sort((a, b) => b.name.length - a.name.length);
    if (best.length && (best.length === 1 || best[0].name.length > best[1].name.length)) {
      const floor = /\bfloors?\s+([\w–-]+)/i.exec(l)?.[1] ?? null;
      const unit = /\bunit\s+([\w-]+)/i.exec(l)?.[1] ?? null;
      return { assetId: best[0].id, floor, unit };
    }
  }
  return { assetId: null, floor: null, unit: null };
}

/** Idempotent: a completed hand-off is not repeated; a pending one is retried. */
export async function handOffExecutedLease(ctx: TxCtx, txId: string) {
  const tx = (await ctx.db.from("tx_transaction").select("lease_handoff").eq("id", txId).single()).data;
  if (tx?.lease_handoff?.status === "delivered") return tx.lease_handoff;
  const payload = await buildExecutedLeasePayload(ctx, txId);
  const r = await receiver(ctx, payload);
  const state = "leaseId" in r
    ? { status: "delivered", lease_id: r.leaseId, at: new Date().toISOString() }
    : { status: "pending_module_15", reason: r.reason, at: new Date().toISOString(), payload };
  await ctx.db.from("tx_transaction").update({ lease_handoff: state }).eq("id", txId);
  await record(ctx, txId, { kind: "lease_handoff", summary: state.status === "delivered" ? "Executed lease handed to Lease Lifecycle" : `Lease Lifecycle hand-off queued: ${(state as any).reason}`, subjectType: "tx_transaction", subjectId: txId });
  return state;
}

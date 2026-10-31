/**
 * Quotes are versioned and immutable (spec Part I §8 "Quote leakage prevention"). A revision inserts version n+1 and
 * points the old row's superseded_by at it; the DB trigger quote_deals_invalidate then drops dependent finance
 * approvals and marks documents built on the old version stale.
 */
import { type DealsCtx, DealsError, dbError, must, owned } from "../ctx";

export interface QuoteTermsInput {
  rent?: number | null;            // ₹ per basis unit per month
  rent_basis?: "chargeable" | "carpet" | "seat" | null;
  cam_per_sf?: number | null;
  cam_included?: boolean | null;
  parking_per_slot?: number | null;
  escalation_pct?: number | null;
  escalation_every_months?: number | null;
  rent_free_months?: number | null;
  deposit_months?: number | null;
  capex_support?: number | null;
  lockin_months?: number | null;
  tenure_months?: number | null;
  gst?: "excluded" | "included" | null;
  inclusions?: string | null;
  [k: string]: unknown;
}
export interface QuoteInput {
  requirementId: string; spaceId?: string | null; counterpartyOrgId?: string | null; terms: QuoteTermsInput;
  validUntil?: string | null; evidence?: string | null; approvedFloor?: number | null; approvedCeiling?: number | null;
}

export async function createQuote(ctx: DealsCtx, q: QuoteInput) {
  const req = must(await ctx.db.from("requirement").select("id, classification").eq("id", q.requirementId).maybeSingle(), "requirement") as { classification: string };
  if (q.approvedFloor != null && q.approvedCeiling != null && q.approvedFloor > q.approvedCeiling) throw new DealsError(400, "approved floor exceeds ceiling");
  return must(await ctx.db.from("quote").insert({
    ...owned(ctx, req.classification), requirement_id: q.requirementId, space_id: q.spaceId ?? null, counterparty_org_id: q.counterpartyOrgId ?? null,
    version: 1, terms_json: q.terms, valid_until: q.validUntil ?? null, evidence: q.evidence ?? null,
    approved_floor: q.approvedFloor ?? null, approved_ceiling: q.approvedCeiling ?? null,
  }).select("*").single(), "quote");
}

/** New version of a quote. Old version is superseded (and its dependants invalidated by the DB). */
export async function reviseQuote(ctx: DealsCtx, quoteId: string, changes: { terms?: Partial<QuoteTermsInput>; validUntil?: string | null; evidence?: string | null; approvedFloor?: number | null; approvedCeiling?: number | null }) {
  const old = must(await ctx.db.from("quote").select("*").eq("id", quoteId).maybeSingle(), "quote") as Record<string, unknown>;
  if (old.superseded_by) throw new DealsError(409, "this quote version is already superseded: revise the latest version");
  const next = must(await ctx.db.from("quote").insert({
    ...owned(ctx, String(old.classification)), requirement_id: old.requirement_id, space_id: old.space_id, counterparty_org_id: old.counterparty_org_id,
    version: Number(old.version) + 1, currency: old.currency,
    terms_json: { ...(old.terms_json as object), ...(changes.terms ?? {}) },
    valid_until: changes.validUntil !== undefined ? changes.validUntil : old.valid_until,
    evidence: changes.evidence ?? old.evidence,
    approved_floor: changes.approvedFloor !== undefined ? changes.approvedFloor : old.approved_floor,
    approved_ceiling: changes.approvedCeiling !== undefined ? changes.approvedCeiling : old.approved_ceiling,
  }).select("*").single(), "quote") as Record<string, unknown>;
  const up = await ctx.db.from("quote").update({ superseded_by: next.id }).eq("id", quoteId).is("superseded_by", null).select("id");
  if (up.error) throw dbError(up.error, "quote");
  if (!up.data?.length) throw new DealsError(409, "quote was revised concurrently");
  return next;
}

export interface LeakageIssue { code: string; message: string; blocking: boolean }

/** Quote leakage check before anything leaves the building: expiry, version, inclusions, recipient, watermark. Pure. */
export function quoteLeakageCheck(q: { version: number; valid_until?: string | null; superseded_by?: string | null; terms_json?: QuoteTermsInput | null; evidence?: string | null },
  opts: { asOf: string; recipient?: string | null; watermark?: boolean }): LeakageIssue[] {
  const out: LeakageIssue[] = [];
  const t = q.terms_json ?? {};
  if (q.superseded_by) out.push({ code: "superseded", message: `quote v${q.version} has been superseded`, blocking: true });
  if (!q.valid_until) out.push({ code: "no_expiry", message: "quote has no validity date", blocking: true });
  else if (q.valid_until < opts.asOf) out.push({ code: "expired", message: `quote v${q.version} expired on ${q.valid_until}`, blocking: true });
  if (t.rent === undefined || t.rent === null) out.push({ code: "no_rent", message: "rent missing", blocking: true });
  if (!t.rent_basis) out.push({ code: "no_basis", message: "rent basis (carpet / chargeable / seat) missing", blocking: true });
  if (t.cam_included !== true && (t.cam_per_sf === undefined || t.cam_per_sf === null)) out.push({ code: "cam_unknown", message: "CAM not stated (included or ₹/SF)", blocking: false });
  if (!t.gst) out.push({ code: "gst_unknown", message: "GST treatment not stated", blocking: false });
  if (!t.inclusions) out.push({ code: "inclusions_unknown", message: "inclusions / exclusions not stated", blocking: false });
  if (!q.evidence) out.push({ code: "no_source", message: "no source evidence for the quote", blocking: false });
  if (opts.recipient !== undefined && !opts.recipient) out.push({ code: "no_recipient", message: "recipient not recorded", blocking: true });
  if (opts.watermark === false) out.push({ code: "no_watermark", message: "document is not watermarked confidential", blocking: true });
  return out;
}

export async function listQuotes(ctx: DealsCtx, requirementId: string) {
  const r = await ctx.db.from("quote").select("*").eq("requirement_id", requirementId).order("version", { ascending: false });
  if (r.error) throw dbError(r.error, "quotes");
  return r.data ?? [];
}

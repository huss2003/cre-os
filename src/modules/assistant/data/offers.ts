/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { landlordOfferSchema, offerToQuoteTerms, type LandlordOffer } from "@/modules/toolkit/calc/landlord-offer";

/**
 * Landlord offers are quote versions with kind='landlord_offer' and a schema-validated `offer` jsonb. terms_json is
 * filled from the offer so the existing deal screens (requirement quotes, leakage check, scenarios) keep working.
 * Versions are immutable (DB guard): a change is a new version that supersedes the old one.
 */
type Row = Record<string, any>;
export interface OfferCtx { db: any; workspaceId: string; userId: string }

export async function saveLandlordOffer(ctx: OfferCtx, s: { requirementId: string; offer: LandlordOffer; landlordOrgId?: string | null; evidence?: string | null }): Promise<Row> {
  const offer = landlordOfferSchema.parse(s.offer);
  const { data: req } = await ctx.db.from("requirement").select("id, classification").eq("workspace_id", ctx.workspaceId).eq("id", s.requirementId).maybeSingle();
  if (!req) throw new Error("not_found_or_no_access");
  const { data, error } = await ctx.db.from("quote").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification: req.classification,
    requirement_id: s.requirementId, space_id: offer.spaceId ?? null, counterparty_org_id: s.landlordOrgId ?? null,
    version: 1, kind: "landlord_offer", offer, terms_json: offerToQuoteTerms(offer), valid_until: offer.validUntil ?? null,
    evidence: s.evidence ?? sourceLabel(offer),
  }).select("*").single();
  if (error) throw new Error(error.message);
  return data as Row;
}

export const sourceLabel = (o: LandlordOffer) => (o.sourceDoc ? `${o.sourceDoc}${o.sourcePage ? ` p.${o.sourcePage}` : ""}` : null);

/** New version of an offer (the old one is superseded; dependent approvals/documents are invalidated by the DB). */
export async function reviseLandlordOffer(ctx: OfferCtx, quoteId: string, offerIn: LandlordOffer, evidence?: string | null): Promise<Row> {
  const offer = landlordOfferSchema.parse(offerIn);
  const { data: old } = await ctx.db.from("quote").select("*").eq("workspace_id", ctx.workspaceId).eq("id", quoteId).maybeSingle();
  if (!old) throw new Error("not_found_or_no_access");
  if (old.superseded_by) throw new Error("this offer version is already superseded: revise the latest version");
  const { data: next, error } = await ctx.db.from("quote").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification: old.classification,
    requirement_id: old.requirement_id, space_id: offer.spaceId ?? old.space_id, counterparty_org_id: old.counterparty_org_id,
    version: Number(old.version) + 1, currency: old.currency, kind: "landlord_offer", offer,
    terms_json: { ...(old.terms_json ?? {}), ...offerToQuoteTerms(offer) }, valid_until: offer.validUntil ?? null,
    evidence: evidence ?? sourceLabel(offer) ?? old.evidence,
    approved_floor: old.approved_floor, approved_ceiling: old.approved_ceiling,
  }).select("*").single();
  if (error) throw new Error(error.message);
  const up = await ctx.db.from("quote").update({ superseded_by: next.id }).eq("workspace_id", ctx.workspaceId).eq("id", quoteId).is("superseded_by", null).select("id");
  if (up.error) throw new Error(up.error.message);
  if (!up.data?.length) throw new Error("offer was revised concurrently");
  return next as Row;
}

export async function getOfferQuote(ctx: OfferCtx, quoteId: string): Promise<Row | null> {
  const { data } = await ctx.db.from("quote").select("*").eq("workspace_id", ctx.workspaceId).eq("id", quoteId).eq("kind", "landlord_offer").maybeSingle();
  return (data as Row | null) ?? null;
}

export async function listLandlordOffers(ctx: OfferCtx, requirementId: string, includeSuperseded = false): Promise<Row[]> {
  let q = ctx.db.from("quote").select("*").eq("workspace_id", ctx.workspaceId).eq("requirement_id", requirementId).eq("kind", "landlord_offer").is("archived_at", null);
  if (!includeSuperseded) q = q.is("superseded_by", null);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

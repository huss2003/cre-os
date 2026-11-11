import type { ParsedCard } from "../docs/card";
import { uncertainCardFields } from "../docs/card";
import { contentHash, factClass, type DraftObservation, type SourceType } from "./analysis";

/**
 * Business-card fields as extracted-information rows (spec §13B), so a card shows what was read — not just the
 * proposals. One row per value read (name, title, company, each email/phone, website, address). Nothing is invented:
 * a field the card doesn't show gets no row. OCR readings are machine readings (fact class via `factClass`); fields
 * the card parser is unsure of are flagged `uncertain` and wait for review.
 */
export function cardObservations(card: ParsedCard, o: { prefix: string; text: string; fileName?: string | null; documentId?: string | null; sourceType?: SourceType }): DraftObservation[] {
  const sourceType: SourceType = o.sourceType ?? "business_card";
  const unsure = uncertainCardFields(card);
  const reasonFor = (field: string, value: string) => unsure.find((u) => u.field === field || u.field === `${field} ${value}`)?.reason ?? null;
  const rows: { field: string; value: string; unsureKey: string; extra?: Record<string, unknown> }[] = [];
  if (card.name) rows.push({ field: "contact_name", value: card.name, unsureKey: "name" });
  if (card.title) rows.push({ field: "contact_title", value: card.title, unsureKey: "designation" });
  if (card.company) rows.push({ field: "company_name", value: card.company, unsureKey: "company" });
  for (const e of card.emails) rows.push({ field: "contact_email", value: e, unsureKey: "email" });
  for (const p of card.phones) rows.push({ field: "contact_phone", value: p.value, unsureKey: "phone", extra: { phone_type: p.type, label: p.label } });
  if (card.website) rows.push({ field: "company_website", value: card.website, unsureKey: "website" });
  if (card.address) rows.push({ field: "company_address", value: card.address, unsureKey: "address" });
  const lower = o.text.toLowerCase();
  return rows.map((r, n) => {
    const reason = reasonFor(r.unsureKey, r.value);
    const at = lower.indexOf(r.value.toLowerCase().split("\n")[0]);
    const company = r.field.startsWith("company");
    return {
      obs_key: `${o.prefix}:card:${r.field}:${n}`, intent: company ? "new_company_information" : "new_contact_information",
      fact_class: factClass({ kind: "value", sourceType }), field: r.field, raw_text: r.value, value_json: r.value, unit: null,
      pricing_basis: null, area_basis: null, cam_treatment: null, date_class: null, missing: [],
      subject_type: null, subject_id: null, links: [], match_confidence: null, confidence: reason ? 0.5 : 0.8, source_type: sourceType,
      source_ref: { locator: at >= 0 ? `file:${at}-${at + r.value.length}` : "file", page: 1, file_name: o.fileName ?? null, document_id: o.documentId ?? null,
        snippet: r.value.slice(0, 200), ...(r.extra ?? {}), uncertain: !!reason, ...(reason ? { uncertain_reason: reason } : {}) },
      verification: reason ? "needs_clarification" : "unverified",
      review_category: reason ? (company ? "uncertain_company_match" : "uncertain_contact_match") : null,
      status: reason ? "pending_review" : "auto_saved",
      content_hash: contentHash(r.field, r.value, null), material: false,
    };
  });
}

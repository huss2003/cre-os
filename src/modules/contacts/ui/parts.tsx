/** Shared bits for the contact screens. Status chips are the one visual language: colour = how much to trust a value. */
export const STATUS: Record<string, { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  likely_valid: { label: "Likely valid", cls: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  published_business: { label: "Published business", cls: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  switchboard: { label: "Switchboard", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  business_mobile: { label: "Business mobile", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  reported: { label: "Reported", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  user_provided: { label: "User-provided", cls: "bg-slate-50 text-slate-700 ring-slate-200" },
  inferred: { label: "Inferred", cls: "bg-violet-50 text-violet-800 ring-violet-200" },
  unverified: { label: "Unverified", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  generic: { label: "Generic inbox", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  risky: { label: "Risky", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  invalid: { label: "Invalid", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
  missing: { label: "Missing", cls: "bg-slate-50 text-slate-500 ring-slate-200" },
  unknown: { label: "Unknown", cls: "bg-slate-50 text-slate-500 ring-slate-200" },
};
export function Chip({ s }: { s: string | null | undefined }) {
  const x = STATUS[s ?? "unknown"] ?? { label: String(s), cls: "bg-slate-50 text-slate-600 ring-slate-200" };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${x.cls}`}>{x.label}</span>;
}
export const ROLE: Record<string, string> = { decision_maker: "Decision-maker", economic_buyer: "Economic buyer", technical_evaluator: "Technical evaluator", operational: "Operational", influencer: "Influencer", gatekeeper: "Gatekeeper", procurement: "Procurement", administrative: "Administrative", unknown: "Unknown" };
export const REL: Record<string, string> = { high: "High CRE relevance", medium: "Medium relevance", low: "Low relevance", none: "Not CRE-relevant", unknown: "Relevance unknown" };
export const STAGE: Record<string, string> = { pending: "Pending", researching: "Researching", discovered: "Discovered", identity_matching: "Identity matching", possible_duplicate: "Possible duplicate", employment_verification_pending: "Employment check", enrichment_pending: "Enrichment pending", partially_enriched: "Partially enriched", verification_required: "Needs review", verified: "Verified", rejected: "Rejected", failed: "Failed" };
export const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

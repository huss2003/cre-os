import type { z, ZodType } from "zod";
import type { StructuredCall, StructuredResult } from "@/lib/ai/gateway";

/** Injectable AI caller (defaults to the gateway). Tests inject failures such as budget_exceeded. */
export type AiCall = <S extends ZodType>(call: StructuredCall<S>) => Promise<StructuredResult<z.infer<S>>>;

export type EvidenceTier = "documentary_current" | "credible_reported" | "corroborated_public" | "single_unverified" | "inference";
export type FactStatus = "historical_observed" | "currently_confirmed" | "reported" | "ai_inference" | "unknown";
export type ResearchTier = "critical" | "active" | "universe";

export const EVIDENCE_TIER_RANK: Record<EvidenceTier, number> = {
  documentary_current: 5, credible_reported: 4, corroborated_public: 3, single_unverified: 2, inference: 1,
};
export const EVIDENCE_TIER_LABEL: Record<EvidenceTier, string> = {
  documentary_current: "Documentary / current",
  credible_reported: "Credible reported",
  corroborated_public: "Corroborated public",
  single_unverified: "Single unverified",
  inference: "Inference",
};

/** Spec §9 research tiers: 50-100 critical weekly, 400-500 active monthly, 1,000-1,500 universe quarterly. */
export const TIER_POLICY: Record<ResearchTier, { cadenceDays: number; capacity: number; label: string }> = {
  critical: { cadenceDays: 7, capacity: 100, label: "Critical — weekly" },
  active: { cadenceDays: 30, capacity: 500, label: "Active / nurture — monthly" },
  universe: { cadenceDays: 90, capacity: 1500, label: "Universe — quarterly" },
};

/** Default evidence shelf-life by claim type (days) when the source gives no explicit expiry. Operating defaults, not guarantees. */
export const DEFAULT_EXPIRY_DAYS: Record<string, number> = {
  hiring: 90, headcount: 180, funding: 365, financial: 365, expansion: 180, rto: 180, consolidation: 180, gcc_plan: 180,
  job_move: 180, employment: 30, contact: 180, footprint: 365, identity: 730, lease: 365, transaction: 3650, interaction: 365,
  quote: 30, availability: 30, objection: 120, default: 180,
};

export function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function expiryFor(claimType: string, observed: string | null, explicit?: string | null): string | null {
  if (explicit) return explicit;
  if (!observed) return null;
  return addDays(observed, DEFAULT_EXPIRY_DAYS[claimType] ?? DEFAULT_EXPIRY_DAYS.default);
}

export function isExpired(expiresOn: string | null | undefined, today: string): boolean {
  return !!expiresOn && expiresOn < today;
}

export const LEGAL_DISCLAIMER = "For review by the tenant's legal team — not legal advice.";
export const STRATEGY_DISCLAIMER = "Suggestions only — price and negotiation decisions stay with you.";
export const MARKET_DISCLAIMER = "Descriptive only — not a forecast. Figures carry their source, period type and definition.";

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function monthKey(d: string | Date): string {
  const s = typeof d === "string" ? d : d.toISOString();
  return s.slice(0, 7);
}

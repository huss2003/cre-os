/**
 * Prospect researcher — approved-source registry rules and the licence policy applied to pasted evidence (pure).
 * Spec Part II §3 adapter registry: every source has an acquisition method, licence, rate limit, refresh cadence,
 * storage/reuse rights and prohibited methods. Scraping, session automation, CAPTCHA/paywall bypass and fake accounts are
 * always prohibited and cannot be removed. Licensed content keeps its licence restrictions (classification
 * licensed_restricted, AI processing only where the licence and a data lane allow it).
 */
import { z } from "zod";
import { type EvidenceTier, EVIDENCE_TIER_RANK } from "../common";

export const SOURCE_KINDS = ["website", "feed", "filing", "press", "careers", "licensed", "export", "native_alert", "manual"] as const;
export const ACQUISITION_METHODS = ["manual_paste", "official_api", "rss", "licensed_export", "native_alert", "user_export", "gateway_web_search"] as const;
export const ALWAYS_PROHIBITED = ["scraping", "session_automation", "captcha_bypass", "paywall_bypass", "fake_accounts"] as const;
export const OPTIONAL_PROHIBITED = ["bulk_download", "redistribution", "ai_training", "login_only_content"] as const;
/** Methods through which a user may paste content from a source into CRE OS. Web search is only used by webResearch. */
export const PASTE_METHODS = new Set<string>(["manual_paste", "official_api", "rss", "licensed_export", "native_alert", "user_export"]);
/** LinkedIn content may only arrive as something the user saw natively or exported themselves. */
export const LINKEDIN_METHODS = new Set<string>(["native_alert", "user_export"]);

const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const optInt = z.union([z.number(), z.string()]).optional().nullable().transform((v, ctx) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) { ctx.addIssue({ code: "custom", message: "must be a whole number ≥ 0" }); return z.NEVER; }
  return n;
});

export const SourceInput = z.object({
  name: z.string().trim().min(2).max(160),
  kind: z.enum(SOURCE_KINDS),
  baseUrl: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), "http(s) only").optional().nullable().or(z.literal("").transform(() => null)),
  acquisitionMethod: z.enum(ACQUISITION_METHODS),
  licence: optText(500),
  licensedSourceId: z.string().uuid().optional().nullable().or(z.literal("").transform(() => null)),
  rateLimitPerDay: optInt,
  refreshCadenceDays: optInt,
  storageRights: optText(500),
  reuseRights: optText(500),
  credentialsOwner: optText(160),
  failurePolicy: optText(300),
  sourceOwner: optText(160),
  allowed: z.boolean().default(true),
  prohibitedMethods: z.array(z.string().max(60)).max(20).default([]),
});
export type SourceInputT = z.output<typeof SourceInput>;

export interface LicensedSourceLite { id: string; name: string; expires_on: string | null; allowed_purposes: string[] | null; permits_ai_processing: boolean; permits_colleague_sharing: boolean; archived_at?: string | null }

export const isLinkedIn = (url: string | null | undefined) => !!url && /(^|\.)linkedin\.com$/i.test(hostOf(url) ?? "");
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

/** Licence is usable for research today: present, not archived, not expired, purpose permitted (empty = unrestricted). */
export function licenceProblem(l: LicensedSourceLite | null | undefined, today: string): string | null {
  if (!l || l.archived_at) return "The linked licensed source is missing or archived.";
  if (l.expires_on && l.expires_on < today) return `The licence for ${l.name} expired on ${l.expires_on}.`;
  const p = (l.allowed_purposes ?? []).map((x) => x.toLowerCase());
  if (p.length && !p.some((x) => ["research", "prospecting", "prospect_research", "internal_research", "all"].includes(x))) {
    return `The licence for ${l.name} does not list research/prospecting as an allowed purpose.`;
  }
  return null;
}

/** Normalise + validate a registry entry. Returns the DB row fields or throws with every problem listed. */
export function validateSource(input: SourceInputT, licensed: LicensedSourceLite | null, today: string) {
  const errors: string[] = [];
  const prohibited = [...new Set([...ALWAYS_PROHIBITED, ...input.prohibitedMethods.filter((m) => /^[a-z_]+$/.test(m))])];
  const licensedKind = input.kind === "licensed" || input.acquisitionMethod === "licensed_export";
  if (licensedKind && !input.licensedSourceId) errors.push("Licensed sources must link a licensed-source record (licence terms, purposes, AI permission).");
  if (input.licensedSourceId) {
    const p = licenceProblem(licensed, today);
    if (p && input.allowed) errors.push(`${p} Disable the source or renew the licence first.`);
  }
  if (licensedKind && input.allowed && (!input.storageRights || !input.reuseRights)) errors.push("Record storage and reuse rights for a licensed source.");
  if (isLinkedIn(input.baseUrl) && !LINKEDIN_METHODS.has(input.acquisitionMethod)) errors.push("LinkedIn may only be a native alert or your own export — never automated or searched.");
  if (input.acquisitionMethod === "gateway_web_search" && (input.rateLimitPerDay === null || input.rateLimitPerDay < 1)) errors.push("Web search needs a daily rate limit of at least 1 (spend control).");
  if (input.acquisitionMethod === "gateway_web_search" && input.kind === "licensed") errors.push("Licensed content cannot be acquired through web search.");
  if (errors.length) throw new SourceRuleError(errors);
  return {
    name: input.name, kind: input.kind, base_url: input.baseUrl ?? null, acquisition_method: input.acquisitionMethod, licence: input.licence,
    licensed_source_id: input.licensedSourceId ?? null, rate_limit_per_day: input.rateLimitPerDay, refresh_cadence_days: input.refreshCadenceDays,
    storage_rights: input.storageRights, reuse_rights: input.reuseRights, credentials_owner: input.credentialsOwner, failure_policy: input.failurePolicy,
    source_owner: input.sourceOwner, allowed: input.allowed, prohibited_methods: prohibited,
  };
}

export class SourceRuleError extends Error {
  constructor(public problems: string[]) { super(problems.join(" ")); }
}

// ------------------------------------------------------------------ pasted-evidence licence policy
export interface RegistrySourceLite {
  id: string; name: string; kind: string; base_url: string | null; acquisition_method: string; allowed: boolean; archived_at?: string | null;
  licensed_source_id: string | null;
}

export interface EvidencePolicy {
  evidence_tier: EvidenceTier;
  classification: "corporate_confidential" | "licensed_restricted";
  source_locator: string;
  registry_source_id: string | null;
  licensed_source_id: string | null;
  permits_ai_processing: boolean;
  tier_lowered: boolean;
}

export class EvidenceSourceError extends Error {}

const MANUAL_MAX_TIER: EvidenceTier = "single_unverified";

/**
 * Decide how a pasted evidence item may be stored. Every paste must name either a registered, allowed source or be marked
 * as a manual note (tier capped at "single unverified"). Licensed sources: valid licence required; the claim is stored as
 * licensed_restricted and AI processing follows the licence.
 */
export function evidencePolicy(
  input: { url?: string | null; evidenceTier: EvidenceTier; manualNote: boolean; viaWebResearch?: boolean },
  source: RegistrySourceLite | null,
  licensed: LicensedSourceLite | null,
  today: string,
): EvidencePolicy {
  if (input.url && isLinkedIn(input.url) && (!source || !LINKEDIN_METHODS.has(source.acquisition_method))) {
    throw new EvidenceSourceError("LinkedIn content can only be recorded from a registered native alert or your own export source.");
  }
  if (!source) {
    if (!input.manualNote) throw new EvidenceSourceError("Name the source: choose an approved source from the registry, or mark the evidence as a manual note.");
    const lowered = EVIDENCE_TIER_RANK[input.evidenceTier] > EVIDENCE_TIER_RANK[MANUAL_MAX_TIER];
    return {
      evidence_tier: lowered ? MANUAL_MAX_TIER : input.evidenceTier, classification: "corporate_confidential",
      source_locator: input.url ? "manual note (with link)" : "manual note", registry_source_id: null, licensed_source_id: null,
      permits_ai_processing: true, tier_lowered: lowered,
    };
  }
  if (!source.allowed || source.archived_at) throw new EvidenceSourceError(`${source.name} is not an allowed source in the research registry.`);
  if (source.acquisition_method === "gateway_web_search" ? !input.viaWebResearch : !PASTE_METHODS.has(source.acquisition_method)) {
    throw new EvidenceSourceError(`${source.name} is registered for ${source.acquisition_method.replace(/_/g, " ")}, not for pasted evidence.`);
  }
  const srcHost = hostOf(source.base_url);
  const urlHost = hostOf(input.url);
  if (srcHost && urlHost && !(urlHost === srcHost || urlHost.endsWith(`.${srcHost}`)) && source.acquisition_method !== "gateway_web_search") {
    throw new EvidenceSourceError(`The link (${urlHost}) is not from the registered source ${source.name} (${srcHost}).`);
  }
  if (source.licensed_source_id) {
    const p = licenceProblem(licensed, today);
    if (p) throw new EvidenceSourceError(p);
    return {
      evidence_tier: input.evidenceTier, classification: "licensed_restricted", source_locator: `licensed: ${licensed!.name} via ${source.name}`,
      registry_source_id: source.id, licensed_source_id: source.licensed_source_id, permits_ai_processing: !!licensed!.permits_ai_processing, tier_lowered: false,
    };
  }
  return {
    evidence_tier: input.evidenceTier, classification: "corporate_confidential", source_locator: `registry: ${source.name}`,
    registry_source_id: source.id, licensed_source_id: null, permits_ai_processing: true, tier_lowered: false,
  };
}

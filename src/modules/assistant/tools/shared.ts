/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import type { ZodType } from "zod";
import { IST, localDate } from "@/lib/util/time";
import type { Block, EntityRef, EntityType, SourceRef, ToolContext, ToolDef, ToolResult } from "../types";

/**
 * Shared helpers for assistant tools. Every tool:
 *  - uses t.ctx.db (RLS) AND filters workspace_id explicitly (defence in depth);
 *  - returns `not_found_or_no_access` (and logs a security event) when a referenced record is not visible;
 *  - never computes money/dates/areas itself — that is done by the existing deterministic calculators.
 */
export type Row = Record<string, any>;

export const MAX_LIMIT = 25;
export const NOT_FOUND = "not_found_or_no_access";

/** Erase the generic so tools of different schemas fit in one array (run/plan params are contravariant). */
export function defineTool<S extends ZodType>(d: ToolDef<S>): ToolDef {
  return d as unknown as ToolDef;
}

export const ws = (t: ToolContext) => t.ctx.workspaceId;
export const db = (t: ToolContext) => t.ctx.db as any;
/** Calendar day in the workspace time zone (default IST) — not the UTC day, which is wrong after 18:30 UTC. */
export const today = (tz: string = IST) => localDate(new Date(), tz);
export const clampLimit = (n?: number | null) => Math.max(1, Math.min(MAX_LIMIT, Math.floor(n ?? 10)));

/** In-app routes (checked against src/app/(app)). */
export const HREF = {
  company: (id: string) => `/companies/${id}`,
  person: (id: string) => `/people/${id}`,
  contact: (id: string) => `/contacts/${id}`,
  asset: (id: string) => `/buildings/${id}`,
  requirement: (id: string) => `/requirements/${id}`,
  opportunity: (id: string) => `/deals/${id}`,
  meeting: (prepId: string) => `/meetings/${prepId}`,
  outreach: (id: string) => `/outreach/${id}`,
  signal: (id: string) => `/signals/${id}`,
  legal: (id: string) => `/legal/${id}`,
  tasks: () => `/tasks`,
  drafts: () => `/drafts`,
  leases: () => `/leases`,
  score: (model: string, id: string) => `/scoring/${model}/${id}`,
  analysis: (kind: string, id: string) => {
    switch (kind) {
      case "property_comparison": return `/toolkit/compare/${id}`;
      case "lease_economics": return `/toolkit/lease?id=${id}`;
      case "occupancy": return `/toolkit/occupancy?id=${id}`;
      case "renewal_vs_relocation": return `/toolkit/renewal/${id}`;
      case "conventional_vs_managed": return `/toolkit/managed/${id}`;
      case "fitout": return `/toolkit/fitout/${id}`;
      case "financing": return `/toolkit/financing/${id}`;
      case "negotiation": return `/toolkit/negotiation/${id}`;
      default: return `/toolkit`;
    }
  },
};

export function ref(type: EntityType, id: string, label: string | null | undefined, href?: string): EntityRef {
  return { type, id, label: label ?? "(unnamed)", href };
}

/** Fact status → SourceRef status (S6: reported ≠ confirmed ≠ inference). */
export function factToStatus(s: string | null | undefined): SourceRef["status"] {
  if (!s) return "unknown";
  if (["currently_confirmed", "contractual", "confirmed", "client_confirmed", "verified", "fact"].includes(s)) return "verified";
  if (["ai_inference", "inference", "hypothesis", "estimated", "inferred"].includes(s)) return "inferred";
  if (["reported", "likely_valid", "historical_observed"].includes(s)) return "reported";
  return "unknown";
}

export const fmt = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** Log an access-denied event. Never includes the name of the inaccessible record. Best effort. */
export async function logDenied(t: ToolContext, toolId: string, detail: Row) {
  try {
    await db(t).from("assistant_security_event").insert({
      workspace_id: ws(t), kind: "access_denied", tool_id: toolId,
      detail: { ...detail, run_id: t.runId, conversation_id: t.conversationId }, owner_user_id: t.ctx.userId,
    });
  } catch { /* logging must never break the run */ }
}

export async function denied(t: ToolContext, toolId: string, detail: Row): Promise<ToolResult> {
  await logDenied(t, toolId, detail);
  return { ok: false, error: NOT_FOUND, summary: "Record not found or you don't have access." };
}

/** Fetch one row by id in the caller's workspace (RLS + explicit workspace filter). */
export async function getOne(t: ToolContext, table: string, id: string, select = "*"): Promise<Row | null> {
  const { data } = await db(t).from(table).select(select).eq("workspace_id", ws(t)).eq("id", id).maybeSingle();
  return (data as Row | null) ?? null;
}

export async function namesById(t: ToolContext, table: "organisation" | "person" | "asset" | "geography" | "requirement", ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  const out = new Map<string, string>();
  if (!uniq.length) return out;
  const col = table === "organisation" ? "display_name" : table === "person" ? "full_name" : table === "requirement" ? "title" : "name";
  for (let i = 0; i < uniq.length; i += 150) {
    const { data } = await db(t).from(table).select(`id, ${col}`).eq("workspace_id", ws(t)).in("id", uniq.slice(i, i + 150));
    for (const r of (data ?? []) as Row[]) out.set(r.id, r[col]);
  }
  return out;
}

/** Postgres error for an invalid uuid etc. → treat as not found (never leak). */
export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function sourcesBlock(items: SourceRef[]): Block[] {
  return items.length ? [{ kind: "sources", items }] : [];
}
export function missingBlock(items: string[]): Block[] {
  return items.length ? [{ kind: "missing", items }] : [];
}

export const ilikeSafe = (s: string) => s.replace(/[%_,()\\]/g, " ").trim();

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Wrap a service error as a ToolResult (no stack traces). */
export function failed(summary: string, e: unknown): ToolResult {
  return { ok: false, error: errMsg(e), summary };
}

export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Plain words for stored fact statuses (never show raw codes like historical_observed). */
export const FACT_LABEL: Record<string, string> = {
  currently_confirmed: "Confirmed", reported: "Reported", likely_valid: "Likely valid", historical_observed: "Seen earlier (historical)",
  ai_inference: "AI inference — unverified", unverified: "Unverified", stale: "Possibly outdated", user_entered: "Entered by user",
};
export const factLabel = (s: string | null | undefined) => (s ? FACT_LABEL[s] ?? s.replace(/_/g, " ") : "Unknown");
/** Area with Indian digit grouping, unit stated; null stays "unknown". */
export const areaSf = (n: unknown) => (n == null || n === "" || !Number.isFinite(Number(n)) ? "unknown" : `${Number(n).toLocaleString("en-IN")} sq ft`);

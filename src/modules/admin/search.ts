/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Any supabase client (user client in the app; tests pass a signed-in client). Never pass the service-role client here. */
type Client = SupabaseClient<any, "public", any>;

export const SEARCH_TYPES = ["organisation", "person", "asset", "requirement", "opportunity"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const TYPE_LABEL: Record<SearchType, string> = {
  organisation: "Company",
  person: "Person",
  asset: "Building",
  requirement: "Requirement",
  opportunity: "Opportunity",
};

export const searchParamsSchema = z.object({
  q: z.string().max(200).default(""),
  types: z.array(z.enum(SEARCH_TYPES)).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  includeArchived: z.boolean().default(false),
});
export type SearchParams = z.input<typeof searchParamsSchema>;

export interface SearchHit {
  entity_type: SearchType;
  id: string;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  classification: string;
  fact_status: string | null;
  status_label: string | null;
  freshness: string | null;
  matched_alias: string | null;
  score: number;
  archived: boolean;
  href: string;
}

export function entityHref(type: string, id: string): string {
  switch (type) {
    case "organisation": return `/companies/${id}`;
    case "person": return `/people/${id}`;
    case "asset": return `/buildings/${id}`;
    case "requirement": return `/requirements/${id}`;
    case "opportunity": return `/deals/${id}`;
    default: return `/search?q=${encodeURIComponent(id)}`;
  }
}

/** Parse URL query (?q=&type=person,organisation&as_of=2026-10-01&limit=&archived=1). */
export function parseSearchQuery(sp: URLSearchParams | Record<string, string | string[] | undefined>) {
  const get = (k: string): string | undefined => {
    if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const rawTypes = (get("type") ?? get("types") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const alias: Record<string, SearchType> = { company: "organisation", companies: "organisation", org: "organisation", building: "asset", buildings: "asset", people: "person" };
  const types = rawTypes.map((t) => alias[t] ?? t).filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
  return searchParamsSchema.parse({
    q: get("q") ?? "",
    types: types.length ? types : undefined,
    asOf: get("as_of") || get("asOf") || undefined,
    limit: get("limit") ?? 50,
    includeArchived: ["1", "true"].includes(get("archived") ?? ""),
  });
}

/**
 * Permission-filtered typed search. Runs app.search_entities as SECURITY INVOKER, so the database applies RLS
 * (tenant, classification, colleague assignment/sharing) to every row — the UI and API cannot widen it.
 */
export async function searchEntities(db: Client, workspaceId: string, params: SearchParams): Promise<SearchHit[]> {
  const p = searchParamsSchema.parse(params);
  const { data, error } = await db.schema("app").rpc("search_entities", {
    p_workspace: workspaceId,
    p_query: p.q,
    p_types: p.types ?? null,
    p_as_of: p.asOf ?? null,
    p_limit: p.limit,
    p_include_archived: p.includeArchived,
  });
  if (error) throw new Error(`search failed: ${error.message}`);
  return ((data ?? []) as Omit<SearchHit, "href">[]).map((r) => ({ ...r, score: Number(r.score), href: entityHref(r.entity_type, r.id) }));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { z } from "zod";
import { entityHref } from "@/modules/admin/search";

type Db = any;

export const EVERYTHING_TYPES = [
  "organisation", "person", "asset", "requirement", "opportunity",
  "lease", "space", "meeting", "task", "signal", "document", "legal_document", "quote", "conversation",
] as const;
export type EverythingType = (typeof EVERYTHING_TYPES)[number];

export const EVERYTHING_LABEL: Record<EverythingType, string> = {
  organisation: "Company", person: "Person", asset: "Building", requirement: "Requirement", opportunity: "Deal",
  lease: "Lease", space: "Floor / unit", meeting: "Meeting", task: "Task", signal: "Signal", document: "Generated document",
  legal_document: "Legal document", quote: "Quote", conversation: "Assistant chat",
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const everythingParamsSchema = z.object({
  q: z.string().max(200).default(""),
  types: z.array(z.enum(EVERYTHING_TYPES)).max(EVERYTHING_TYPES.length).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  statuses: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  geographyIds: z.array(z.string().uuid()).max(20).optional(),
  source: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EverythingParams = z.input<typeof everythingParamsSchema>;

export interface EverythingHit {
  entity_type: EverythingType; id: string; parent_id: string | null; title: string; subtitle: string | null;
  status_label: string | null; source: string | null; occurred_on: string | null; location: string | null;
  classification: string; fact_status: string | null; score: number; href: string;
}

/** Link to the original record (detail page where one exists, otherwise the owning list/parent). */
export function everythingHref(type: string, id: string, parentId: string | null): string {
  switch (type) {
    case "lease": return parentId ? `/companies/${parentId}` : "/leases";
    case "space": return parentId ? `/buildings/${parentId}` : "/buildings";
    case "meeting": return "/calendar";
    case "task": return "/tasks";
    case "signal": return `/signals/${id}`;
    case "document": return "/documents";
    case "legal_document": return `/legal/${id}`;
    case "quote": return parentId ? `/requirements/${parentId}` : "/deals";
    case "conversation": return `/assistant/${id}`;
    default: return entityHref(type, id);
  }
}

/** Parse ?q=&type=lease,task&from=&to=&status=&geo=<uuid>&source=&limit= */
export function parseEverythingQuery(sp: URLSearchParams | Record<string, string | string[] | undefined>) {
  const get = (k: string): string | undefined => {
    if (sp instanceof URLSearchParams) return sp.get(k) ?? undefined;
    const v = sp[k]; return Array.isArray(v) ? v[0] : v;
  };
  const list = (k: string) => (get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const alias: Record<string, EverythingType> = { company: "organisation", companies: "organisation", building: "asset", buildings: "asset", people: "person", deal: "opportunity", deals: "opportunity", meetings: "meeting", tasks: "task", signals: "signal", leases: "lease", quotes: "quote", documents: "document", chat: "conversation" };
  const types = list("type").map((t) => alias[t] ?? t).filter((t): t is EverythingType => (EVERYTHING_TYPES as readonly string[]).includes(t));
  const geo = list("geo").filter((g) => /^[0-9a-f-]{36}$/i.test(g));
  const r = everythingParamsSchema.safeParse({
    q: (get("q") ?? "").slice(0, 200), types: types.length ? types : undefined,
    from: get("from") || undefined, to: get("to") || undefined,
    statuses: list("status").length ? list("status") : undefined,
    geographyIds: geo.length ? geo : undefined, source: get("source") || undefined, limit: get("limit") ?? 50,
  });
  return r.success ? r.data : everythingParamsSchema.parse({ q: (get("q") ?? "").slice(0, 200) });
}

export function hasEverythingCriteria(p: z.output<typeof everythingParamsSchema>): boolean {
  return !!(p.q.trim() || p.types?.length || p.from || p.to || p.statuses?.length || p.geographyIds?.length || p.source);
}

/** Expanded global search (SECURITY INVOKER RPC → RLS on every row; workspace passed explicitly). */
export async function searchEverything(db: Db, ws: string, params: EverythingParams): Promise<EverythingHit[]> {
  const p = everythingParamsSchema.parse(params);
  const { data, error } = await db.schema("mudar_app").rpc("search_everything", {
    p_workspace: ws, p_query: p.q, p_types: p.types ?? null, p_from: p.from ?? null, p_to: p.to ?? null,
    p_statuses: p.statuses ?? null, p_geography: p.geographyIds ?? null, p_source: p.source ?? null, p_limit: p.limit,
  });
  if (error) throw new Error(`search failed: ${error.message}`);
  return ((data ?? []) as Omit<EverythingHit, "href">[]).map((r) => ({ ...r, score: Number(r.score), href: everythingHref(r.entity_type, r.id, r.parent_id) }));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
import { callStructured } from "@/lib/ai/gateway";
import { localDate } from "@/lib/util/time";
import { accountFilterSchema, resolveWindow, type AccountFilter } from "./filter";
import { parseAccountQuery, type Place } from "./parse";

type Db = any;

export interface AccountHit {
  orgId: string; name: string; sector: string | null;
  areaSf: number | null; areaBasis: string | null; leasesInScope: number | null; leasesWithArea: number | null;
  leases: { id: string; building: string | null; assetId: string | null; areaSf: number | null; areaBasis: string | null; grade: string | null; expiry: string | null; factStatus: string | null }[] | null;
  events: { leaseId: string; type: string; date: string; confirmed: boolean | null }[] | null;
  contacts: { personId: string; name: string; title: string | null; basis: string }[] | null;
  signals: { id: string; kind: string; category: string; title: string; detectedAt: string }[] | null;
  scoreBand: string | null; score: number | null;
  requirements: { id: string; title: string; status: string }[] | null;
  opportunities: { id: string; name: string; stage: string }[] | null;
}
export interface FinderCoverage {
  companiesChecked: number; candidates: number; matched: number;
  areaUnknown: number | null; eventsUnknown: number | null; truncated: boolean;
  unresolvedPlaces: string[];
}
export interface FinderResult { filter: AccountFilter; results: AccountHit[]; coverage: FinderCoverage; window: { from: string; to: string } | null }

/** Workspace geographies (name + aliases) for the parser and place resolution. RLS + explicit workspace filter. */
export async function loadPlaces(db: Db, ws: string): Promise<(Place & { id: string; parent_id: string | null })[]> {
  const { data, error } = await db.from("geography").select("id, name, aliases, parent_id").eq("workspace_id", ws).is("archived_at", null).limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

/** Place names → geography ids (exact name/alias match, case-insensitive). Unknown names are reported, not guessed. */
export function resolvePlaceIds(names: string[], places: (Place & { id: string })[]): { ids: string[]; unresolved: string[] } {
  const ids = new Set<string>(); const unresolved: string[] = [];
  for (const n of names) {
    const k = n.trim().toLowerCase();
    const hit = places.filter((p) => p.name.toLowerCase() === k || (p.aliases ?? []).some((a) => a.toLowerCase() === k));
    if (hit.length) hit.forEach((h) => ids.add(h.id)); else unresolved.push(n);
  }
  return { ids: [...ids], unresolved };
}

/**
 * Structured account finder. The validated filter is passed as a jsonb PARAMETER to mudar_app.find_accounts
 * (SECURITY INVOKER → caller's RLS); no SQL is assembled from text (S7). Dates are computed here deterministically (S5).
 */
export async function findAccounts(db: Db, ws: string, input: AccountFilter, opts: { today?: string; limit?: number } = {}): Promise<FinderResult> {
  const filter = accountFilterSchema.parse(input);
  const today = opts.today ?? localDate();
  let geographyIds = filter.geographyIds ?? [];
  let unresolved: string[] = [];
  if (filter.places?.length) {
    const r = resolvePlaceIds(filter.places, await loadPlaces(db, ws));
    geographyIds = [...new Set([...geographyIds, ...r.ids])];
    unresolved = r.unresolved;
  }
  const win = resolveWindow(filter.eventWindow, today);
  const p = {
    areaMin: filter.areaMinSf ?? null, areaMax: filter.areaMaxSf ?? null, areaBasis: filter.areaBasis ?? "any",
    geographyIds, placeNames: unresolved, grades: filter.grades ?? [],
    eventTypes: filter.eventTypes ?? [], eventFrom: win?.from ?? null, eventTo: win?.to ?? null,
    sectors: filter.sectors ?? [], knownContact: filter.knownContact ?? false,
    signalKinds: filter.signalKinds ?? [], signalSince: filter.signalSince ?? null,
    scoreBands: filter.scoreBands ?? [], requirementStatuses: filter.requirementStatuses ?? [],
    hasOpenOpportunity: filter.hasOpenOpportunity ?? null,
  };
  const { data, error } = await db.schema("mudar_app").rpc("find_accounts", { p_workspace: ws, p_filter: p, p_today: today, p_limit: opts.limit ?? 50 });
  if (error) throw new Error(`account search failed: ${error.message}`);
  const cov = (data?.coverage ?? {}) as Partial<FinderCoverage>;
  return {
    filter, window: win,
    results: ((data?.results ?? []) as AccountHit[]).map((r) => ({ ...r, areaSf: r.areaSf === null ? null : Number(r.areaSf) })),
    coverage: {
      companiesChecked: cov.companiesChecked ?? 0, candidates: cov.candidates ?? 0, matched: cov.matched ?? 0,
      areaUnknown: cov.areaUnknown ?? null, eventsUnknown: cov.eventsUnknown ?? null, truncated: !!cov.truncated,
      unresolvedPlaces: unresolved,
    },
  };
}

/**
 * Natural language → typed filter. Deterministic parser first; then the gateway may only FILL fields the parser left
 * empty (typed output, validated by zod; the query is passed as evidence, never executed). Mock returns nothing extra.
 */
export async function nlToFilter(db: Db, ws: string, text: string, opts: { today?: string; useModel?: boolean } = {}): Promise<{ filter: AccountFilter; understood: string[]; modelFilled: string[]; mocked: boolean | null }> {
  const today = opts.today ?? localDate();
  const places = await loadPlaces(db, ws);
  const det = parseAccountQuery(text.slice(0, 500), places, today);
  if (opts.useModel === false) return { ...det, modelFilled: [], mocked: null };
  let modelFilled: string[] = []; let mocked: boolean | null = null;
  try {
    const r = await callStructured({
      workspaceId: ws, workflow: "search.nl_filter", tier: "luna",
      system: "You convert a commercial-real-estate account search request into a typed filter. Only fill fields the request clearly states. Never invent places, numbers or dates. Leave everything else out.",
      input: `Today is ${today}. Fields already understood (do not repeat): ${JSON.stringify(det.filter)}. Known places: ${places.slice(0, 200).map((p) => p.name).join(", ")}.`,
      evidence: text.slice(0, 500),
      schema: accountFilterSchema, schemaName: "account_filter", maxOutputTokens: 400,
      mock: () => ({}),
    });
    mocked = r.mocked;
    const extra = accountFilterSchema.parse(r.data);
    for (const [k, v] of Object.entries(extra) as [keyof AccountFilter, unknown][]) {
      if (v === undefined || (det.filter as any)[k] !== undefined) continue;
      if (k === "places") {  // only places that really exist in the workspace
        const ok = (v as string[]).filter((n) => resolvePlaceIds([n], places).ids.length);
        if (!ok.length) continue;
        (det.filter as any)[k] = ok;
      } else (det.filter as any)[k] = v;
      modelFilled.push(k);
    }
  } catch { modelFilled = []; /* AI unavailable/paused → deterministic result stands (visible: modelFilled empty) */ }
  return { ...det, modelFilled, mocked };
}

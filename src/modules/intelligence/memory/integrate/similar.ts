/**
 * §7.3 "Which companies have similar requirements?" — deterministic comparison of live requirements. Unknown area or
 * location never counts as a match.
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { q } from "../data";

const area = (r: Row): number | null => { const v = r.area_target_sf ?? r.area_max_sf ?? r.area_min_sf; return v == null ? null : Number(v); };

export function similarity(base: Row, other: Row): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  const a = area(base), b = area(other);
  if (a !== null && b !== null && a > 0 && Math.abs(b - a) / a <= 0.25) { score += 2; why.push(`area ${b.toLocaleString("en-IN")} sq ft vs ${a.toLocaleString("en-IN")}`); }
  const geo = (base.preferred_geography_ids ?? []).filter((g: string) => (other.preferred_geography_ids ?? []).includes(g));
  if (geo.length) { score += 2; why.push(`${geo.length} shared preferred location${geo.length === 1 ? "" : "s"}`); }
  if (base.occupation_date && other.occupation_date && Math.abs(Date.parse(base.occupation_date) - Date.parse(other.occupation_date)) <= 120 * 864e5) { score += 1; why.push(`move-in within 4 months (${other.occupation_date})`); }
  return { score, why };
}

export async function findSimilarRequirements(ctx: MemCtx, f: { requirementId?: string; orgId?: string; limit?: number }) {
  const ws = ctx.workspaceId;
  const cols = "id, title, org_id, area_min_sf, area_target_sf, area_max_sf, preferred_geography_ids, occupation_date, status, organisation:org_id(display_name)";
  let base: Row | null = null;
  if (f.requirementId) base = (await ctx.db.from("requirement").select(cols).eq("workspace_id", ws).eq("id", f.requirementId).maybeSingle()).data as Row | null;
  else if (f.orgId) base = (await ctx.db.from("requirement").select(cols).eq("workspace_id", ws).eq("org_id", f.orgId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle()).data as Row | null;
  if (!base) return { base: null, items: [], checked: 0 };
  const others = await q<Row[]>(ctx.db.from("requirement").select(cols).eq("workspace_id", ws).is("archived_at", null).neq("id", base.id).not("status", "in", "(closed,cancelled,lost,won,dropped)").limit(500));
  const items = others.filter((o) => o.org_id !== base!.org_id).map((o) => ({ o, s: similarity(base!, o) })).filter((x) => x.s.score >= 2)
    .sort((a, b) => b.s.score - a.s.score).slice(0, f.limit ?? 8)
    .map(({ o, s }) => ({ id: o.id, title: o.title, orgId: o.org_id, orgName: o.organisation?.display_name ?? null, score: s.score, why: s.why }));
  return { base: { id: base.id, title: base.title, orgName: base.organisation?.display_name ?? null }, items, checked: others.length };
}

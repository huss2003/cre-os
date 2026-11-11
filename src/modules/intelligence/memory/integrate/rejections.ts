/**
 * Previously rejected properties + reasons (Module 13 §5.1 / §17.17; used by Module 8 comparisons, recommendations and
 * the assistant). Explicit client rejections (site-visit feedback with explicit_rejection) are kept apart from
 * shortlist options our own matching marked "rejected" (not a client decision). Reasons are quoted, never invented.
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { q } from "../data";
import type { Rejection } from "../changes/detect";

const REASON_FIELDS: [string, string][] = [["reason", "Reason"], ["parking", "Parking"], ["pricing", "Pricing"], ["location", "Location"], ["commute", "Commute"], ["layout", "Layout"], ["quality", "Building quality"], ["notes", "Notes"]];

/** Normalised reason theme (for "repeatedly rejected because of parking"). Deterministic keyword map. */
export function reasonTheme(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bpark/.test(t)) return "parking";
  if (/\b(price|pricing|rent|expensive|cost|budget|cam)\b/.test(t)) return "pricing";
  if (/\b(location|commute|connectivity|far|distance|metro|traffic)\b/.test(t)) return "location";
  if (/\b(layout|floor ?plate|efficiency|column|size|small|large)\b/.test(t)) return "layout";
  if (/\b(quality|amenit|grade|old|maintenance|lift|power|backup)\b/.test(t)) return "building quality";
  if (/\b(possession|timeline|availability|delay|ready)\b/.test(t)) return "timing";
  return null;
}

export async function loadRejections(ctx: MemCtx, f: { requirementId?: string; orgId?: string }): Promise<Rejection[]> {
  const ws = ctx.workspaceId;
  if (!f.requirementId && !f.orgId) return [];
  let pq = ctx.db.from("meeting_prep").select("id, requirement_id, org_id, opportunity_id, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", ws).is("archived_at", null);
  pq = f.requirementId ? pq.eq("requirement_id", f.requirementId) : pq.eq("org_id", f.orgId!);
  const preps = await q<Row[]>(pq.limit(300));
  const fb = preps.length ? await q<Row[]>(ctx.db.from("meeting_property_feedback").select("id, prep_id, asset_id, fields, updated_at, asset:asset_id(name)").eq("workspace_id", ws).in("prep_id", preps.map((p) => p.id)).is("archived_at", null)) : [];
  const prepOf = new Map(preps.map((p) => [p.id, p]));
  const out: Rejection[] = [];
  for (const x of fb) {
    const fl = (x.fields ?? {}) as Row;
    if (!(fl.explicit_rejection === true || fl.interest === "rejected")) continue;
    const p = prepOf.get(x.prep_id) as Row;
    const reasons = REASON_FIELDS.filter(([k]) => typeof fl[k] === "string" && fl[k].trim()).map(([k, l]) => `${l}: ${String(fl[k]).trim()}`);
    out.push({ assetId: x.asset_id, assetName: x.asset?.name ?? "Building", requirementId: p?.requirement_id ?? null, at: p?.meeting?.start_at ?? x.updated_at, reasons, explicit: fl.explicit_rejection === true,
      source: { type: "meeting_property_feedback", id: x.id, label: `Site-visit feedback — ${p?.meeting?.title ?? "meeting"} ${String(p?.meeting?.start_at ?? x.updated_at).slice(0, 10)}`, href: `/meetings/${x.prep_id}` } });
  }
  let sq = ctx.db.from("shortlist_option").select("id, requirement_id, asset_id, disqualifiers, updated_at, asset:asset_id(name), requirement:requirement_id!inner(org_id)").eq("workspace_id", ws).eq("option_status", "rejected").is("archived_at", null);
  sq = f.requirementId ? sq.eq("requirement_id", f.requirementId) : sq.eq("requirement.org_id", f.orgId!);
  for (const o of await q<Row[]>(sq.order("updated_at", { ascending: false }).limit(200))) {
    if (!o.asset_id || out.some((r) => r.assetId === o.asset_id && r.requirementId === o.requirement_id && r.explicit)) continue;
    out.push({ assetId: o.asset_id, assetName: o.asset?.name ?? "Building", requirementId: o.requirement_id, at: o.updated_at, reasons: (o.disqualifiers ?? []).map((d: string) => `Did not fit: ${d}`), explicit: false,
      source: { type: "shortlist_option", id: o.id, label: "Shortlist option marked rejected (matching / adviser — not a recorded client decision)", href: `/requirements/${o.requirement_id}` } });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Reason themes that recur across ≥ `min` explicit rejections (e.g. parking). */
export function recurringRejectionThemes(rej: Rejection[], min = 2) {
  const by = new Map<string, Rejection[]>();
  for (const r of rej.filter((x) => x.explicit)) {
    const themes = new Set(r.reasons.map(reasonTheme).filter(Boolean) as string[]);
    for (const t of themes) by.set(t, [...(by.get(t) ?? []), r]);
  }
  return [...by].filter(([, l]) => new Set(l.map((x) => x.assetId)).size >= min).map(([theme, l]) => ({ theme, count: new Set(l.map((x) => x.assetId)).size, rejections: l }));
}

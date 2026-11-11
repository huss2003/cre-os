import type { Candidate } from "../extract";
import type { CommercialTerm } from "./commercial";

/**
 * Input Engine matching helpers (spec §5.4, §7). Pure: no database, no AI.
 *  - matchBuildings: building / business-park names (and aliases) inside free-text notes => SUGGESTION links only.
 *  - tieBreakOrg: when several companies share a name, prefer the one related (parent/subsidiary/affiliate) to a
 *    company already linked, or the one whose HQ city is named in the note. Result is "medium" at most (confirm).
 *  - questionable: plausibility bands for commercial numbers => flagged "questionable", never blocked.
 */

// ------------------------------------------------------------------------------------------------ buildings
export interface AssetRef { id: string; name: string; parentName?: string | null; locality?: string | null; aliases?: string[] }
export interface BuildingSuggestion { asset_id: string; label: string; text: string; start: number; end: number; confidence: number; tier: "high" | "medium" | "low"; reason: string }

const GENERIC = new Set(["tower", "towers", "building", "block", "wing", "phase", "park", "it", "tech", "techpark", "business", "plaza", "centre", "center", "the", "one",
  "sez", "campus", "city", "square", "court", "house", "point", "estate", "complex", "zone", "free", "office", "offices", "commercial", "corporate", "hub"]);
const nrm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOWERISH = /^(tower|block|wing|building|bldg)\s+[\p{L}\p{N}]{1,3}$/iu;

function findAll(text: string, phrase: string): { start: number; end: number }[] {
  const p = nrm(phrase);
  if (p.length < 2) return [];
  const words = p.split(" ").map(esc).join(String.raw`[\s\-_.,/]+`);
  return [...text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])${words}(?![\p{L}\p{N}])`, "giu"))].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}
const tierOf = (c: number): BuildingSuggestion["tier"] => (c >= 0.85 ? "high" : c >= 0.6 ? "medium" : "low");

export function matchBuildings(text: string, assets: AssetRef[]): BuildingSuggestion[] {
  const best = new Map<string, BuildingSuggestion>();
  const put = (s: Omit<BuildingSuggestion, "tier">) => {
    const prev = best.get(s.asset_id);
    if (!prev || s.confidence > prev.confidence) best.set(s.asset_id, { ...s, tier: tierOf(s.confidence) });
  };
  for (const a of assets) {
    for (const name of [a.name, ...(a.aliases ?? [])]) {
      const n = nrm(name);
      if (!n || n.split(" ").every((w) => GENERIC.has(w) || w.length < 2)) {
        if (!TOWERISH.test(n)) continue;
      }
      for (const h of findAll(text, name)) {
        if (TOWERISH.test(n)) {
          // "Tower B" is only meaningful with its campus named nearby
          const parentHit = a.parentName ? findAll(text, a.parentName).some((p) => Math.abs(p.start - h.start) <= 80) : false;
          put({ asset_id: a.id, label: a.parentName ? `${a.parentName} — ${a.name}` : a.name, text: text.slice(h.start, h.end), ...h,
            confidence: parentHit ? 0.9 : 0.6, reason: parentHit ? `${a.name} of ${a.parentName} named` : "tower/block name only — confirm the campus" });
        } else put({ asset_id: a.id, label: a.name, text: text.slice(h.start, h.end), ...h, confidence: 0.9, reason: name === a.name ? "building name" : `known alias "${name}"` });
      }
    }
    // "EON Kharadi": first distinctive word of the name + the building's locality
    const lead = nrm(a.name).split(" ").find((w) => w.length >= 3 && !GENERIC.has(w));
    if (lead && !best.has(a.id)) {
      const hits = findAll(text, lead);
      const loc = a.locality ? findAll(text, a.locality) : [];
      const near = hits.find((h) => loc.some((l) => Math.abs(l.start - h.start) <= 40));
      if (near) {
        const l = loc.find((x) => Math.abs(x.start - near.start) <= 40)!;
        const s = Math.min(near.start, l.start), e = Math.max(near.end, l.end);
        put({ asset_id: a.id, label: a.name, text: text.slice(s, e), start: s, end: e, confidence: 0.7, reason: `"${lead}" + locality ${a.locality}` });
      } else if (hits.length) put({ asset_id: a.id, label: a.name, text: text.slice(hits[0].start, hits[0].end), ...hits[0], confidence: 0.4, reason: `partial name "${lead}"` });
    }
  }
  // several buildings fit the same words at the same confidence => all low (the user picks)
  const out = [...best.values()];
  const rivalCount = out.map((s) => out.filter((o) => o !== s && nrm(o.text) === nrm(s.text) && o.confidence === s.confidence).length);
  out.forEach((s, i) => {
    if (rivalCount[i]) { s.confidence = Math.min(s.confidence, 0.35); s.tier = "low"; s.reason = `${rivalCount[i] + 1} buildings fit "${s.text}" — pick one`; }
  });
  return out.sort((a, b) => a.start - b.start || b.confidence - a.confidence);
}

// ------------------------------------------------------------------------------------------------ company tie-breakers
export interface OrgTieContext { text: string; related: Record<string, string>; cityOf: Record<string, string | null> }

/** One winner among equally plausible same-name companies, or null. related: org id -> relation description. */
export function tieBreakOrg(cands: Pick<Candidate, "id" | "label">[], ctx: OrgTieContext): { id: string; label: string; reason: string } | null {
  if (cands.length < 2) return null;
  const rel = cands.filter((c) => ctx.related[c.id]);
  if (rel.length === 1) return { id: rel[0].id, label: rel[0].label, reason: `${ctx.related[rel[0].id]} — confirm` };
  const pool = rel.length > 1 ? rel : cands;
  const local = pool.filter((c) => { const city = ctx.cityOf[c.id]; return !!city && findAll(ctx.text, city).length > 0; });
  if (local.length === 1) return { id: local[0].id, label: local[0].label, reason: `based in ${ctx.cityOf[local[0].id]} (named in the note) — confirm` };
  return null;
}

// ------------------------------------------------------------------------------------------------ outliers
/** Plausibility bands (₹, sq ft, months). Out-of-band => a reason string; the value is still saved. */
export function questionable(t: Pick<CommercialTerm, "key" | "value" | "unit" | "pricing_basis">): string | null {
  const v = t.value;
  if (v == null || !Number.isFinite(v)) return null;
  const perSf = t.pricing_basis === "per_sf_month" || /\/sf/i.test(t.unit ?? "") || t.key === "rent_psf";
  if ((t.key === "rent_psf" || ((t.key === "budget") && perSf)) && (v < 15 || v > 400)) return `₹${v}/sf/month is outside the usual office range (₹15–400) — check`;
  if (t.key === "cam" && perSf && v > 60) return `CAM ₹${v}/sf is above ₹60/sf — check`;
  if (["area", "carpet_area", "chargeable_area", "super_built_up_area"].includes(t.key) && (v < 100 || v > 2_000_000)) return `${v.toLocaleString("en-IN")} sq ft is outside the usual range (100–20,00,000) — check`;
  if (t.key === "security_deposit" && t.unit === "months_rent" && v > 24) return `deposit of ${v} months is above 24 months — check`;
  return null;
}

/*
 * Identity resolution scoring (spec Part I §6). Pure and deterministic.
 *  - Companies: legal id (CIN/GSTIN) or verified domain are hard identifiers; names give context only.
 *    A group and its subsidiary are LINKED (relation), never merged.
 *  - People: verified email / profile URL are hard identifiers. A name alone never permits a merge.
 *  - Buildings: name alias + locality + tower/campus scope + coordinates. Different towers are never collapsed.
 * Decision: >= auto_link only when hard identifiers agree; [review, auto_link) => human review; below => separate.
 * Thresholds are configurable (workspace_setting "imports.identity_thresholds") and are not statistical guarantees.
 */
import type { IdentityThresholds } from "./types";
import { DEFAULT_THRESHOLDS } from "./types";
import { canonicalBuilding, canonicalOrg, exactKey, scopeTokens } from "./normalize";

export type Decision = "auto_link" | "review" | "separate";
export type Suggestion = "link" | "review" | "relate_group" | "relate_campus" | "separate";

export interface Score {
  score: number;
  hardAgree: boolean;
  hardConflict: boolean;
  suggested: Suggestion;
  evidence: Record<string, unknown>;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice on character bigrams (0..1). */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [g, n] of A) { inter += Math.min(n, B.get(g) ?? 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

const tokens = (s: string) => s.split(" ").filter(Boolean);

/** Name similarity: mean of bigram Dice and token-set overlap. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const tokenScore = inter / Math.max(ta.size, tb.size, 1);
  return Math.round(((dice(a, b) + tokenScore) / 2) * 10000) / 10000;
}

export function decide(s: Pick<Score, "score" | "hardAgree" | "hardConflict">, thr: IdentityThresholds = DEFAULT_THRESHOLDS): Decision {
  if (s.hardConflict) return "separate";
  if (s.score >= thr.auto_link && s.hardAgree) return "auto_link";
  if (s.score >= thr.review) return "review";
  return "separate";
}

export interface OrgIdent { name: string; legal_name?: string | null; cin?: string | null; gstin?: string | null; domain?: string | null }

const norm = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : null);

export function scoreOrganisation(a: OrgIdent, b: OrgIdent): Score {
  const hard: [string, string | null, string | null][] = [
    ["cin", norm(a.cin), norm(b.cin)],
    ["gstin", norm(a.gstin), norm(b.gstin)],
    ["domain", norm(a.domain), norm(b.domain)],
  ];
  const agree = hard.filter(([, x, y]) => x && y && x === y).map(([k]) => k);
  const conflict = hard.filter(([, x, y]) => x && y && x !== y).map(([k]) => k);
  const ca = canonicalOrg(a.legal_name || a.name), cb = canonicalOrg(b.legal_name || b.name);
  let score = nameSimilarity(ca, cb);
  let suggested: Suggestion = "review";
  const evidence: Record<string, unknown> = { canonical: [ca, cb], hard_agree: agree, hard_conflict: conflict };
  if (exactKey(a.name) === exactKey(b.name)) score = 1;
  else if (ca && ca === cb) {
    score = 0.9; // only legal-form/punctuation differs: still needs a hard identifier to auto-link
    evidence.legal_form_variant = true;
  } else {
    const ta = tokens(ca), tb = tokens(cb);
    const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (small.length && small.length < big.length && small.every((t) => big.includes(t)) && small[0] === big[0]) {
      // "Acme" vs "Acme Technologies India": plausible group/subsidiary => relate, never merge
      score = Math.max(score, 0.82);
      suggested = "relate_group";
      evidence.group_or_subsidiary = true;
    }
  }
  if (agree.length) score = Math.max(score, 0.95);
  if (conflict.length) score = Math.min(score, 0.5);
  if (suggested !== "relate_group") suggested = agree.length && score >= 0.95 ? "link" : score >= 0.8 ? "review" : "separate";
  return { score: Math.round(score * 10000) / 10000, hardAgree: agree.length > 0, hardConflict: conflict.length > 0, suggested, evidence };
}

export interface PersonIdent { name: string; verified_emails?: string[]; profile_url?: string | null }

export function scorePerson(a: PersonIdent, b: PersonIdent): Score {
  const ea = new Set((a.verified_emails ?? []).map((e) => e.trim().toLowerCase()));
  const shared = (b.verified_emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => ea.has(e));
  const pa = norm(a.profile_url), pb = norm(b.profile_url);
  const profileAgree = !!(pa && pb && pa === pb);
  const profileConflict = !!(pa && pb && pa !== pb);
  const hardAgree = shared.length > 0 || profileAgree;
  const nameScore = nameSimilarity(exactKey(a.name), exactKey(b.name));
  // A name alone never permits a merge: without a hard identifier the score is capped below the review band.
  let score = hardAgree ? Math.max(nameScore, 0.95) : Math.min(nameScore, 0.79);
  if (profileConflict && !shared.length) score = Math.min(score, 0.5);
  const suggested: Suggestion = hardAgree ? (nameScore >= 0.8 ? "link" : "review") : "separate";
  if (hardAgree && nameScore < 0.8) score = Math.min(score, 0.94); // identifiers agree but names conflict => human review
  return {
    score: Math.round(score * 10000) / 10000, hardAgree, hardConflict: profileConflict && !shared.length, suggested,
    evidence: { shared_emails: shared, profile_agree: profileAgree, name_similarity: nameScore },
  };
}

export interface BuildingIdent { name: string; locality: string; lat?: number | null; lon?: number | null }

function metres(a: BuildingIdent, b: BuildingIdent): number | null {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function scoreBuilding(a: BuildingIdent, b: BuildingIdent): Score {
  const sa = scopeTokens(a.name), sb = scopeTokens(b.name);
  const strip = (s: string) => canonicalBuilding(s).replace(/\b(tower|wing|block|phase|building|plot|cluster)\s*(no\s*)?([a-z]?\d+[a-z]?|[a-z]|i{1,3}|iv|v|vi{0,3})\b/g, " ").replace(/\s+/g, " ").trim();
  const campusA = strip(a.name), campusB = strip(b.name);
  const sameLocality = exactKey(a.locality) === exactKey(b.locality);
  const dist = metres(a, b);
  const evidence: Record<string, unknown> = { scope: [sa, sb], same_locality: sameLocality, distance_m: dist };
  let score = nameSimilarity(canonicalBuilding(a.name), canonicalBuilding(b.name));
  let suggested: Suggestion = "review";
  const scopeEq = sa.length === sb.length && sa.every((t) => sb.includes(t));
  if (sa.length && sb.length && !scopeEq) {
    // Two towers of one campus: never collapsed.
    score = Math.min(score, 0.5);
    suggested = "separate";
    evidence.different_towers = true;
  } else if ((sa.length > 0) !== (sb.length > 0)) {
    // campus vs tower: relate (parent/child), never merge
    if (nameSimilarity(campusA, campusB) >= 0.85) {
      score = 0.82;
      suggested = "relate_campus";
      evidence.campus_tower = true;
    } else score = Math.min(score, 0.6);
  }
  if (!sameLocality) score = score * 0.7;
  const hardAgree = dist !== null && dist <= 75 && scopeEq;
  if (dist !== null && dist > 1000) score = Math.min(score, 0.5);
  if (hardAgree) score = Math.max(score, sameLocality && nameSimilarity(campusA, campusB) >= 0.8 ? 0.96 : score);
  if (suggested === "review") suggested = hardAgree && score >= 0.95 ? "link" : score >= 0.8 ? "review" : "separate";
  return { score: Math.round(score * 10000) / 10000, hardAgree, hardConflict: false, suggested, evidence };
}

/** Blocking key to keep candidate search near-linear: first canonical token. */
export const orgBlock = (name: string) => tokens(canonicalOrg(name))[0] ?? "";
export const buildingBlock = (name: string, locality: string) => `${exactKey(locality)}|${tokens(canonicalBuilding(name))[0] ?? ""}`;

export interface Candidate<T> { left: T; right: T; score: Score; decision: Decision }

/** Compare each NEW item against the pool (existing + earlier new) within its block. Returns review/auto-link candidates only. */
export function findCandidates<T extends { id: string }>(
  newItems: T[], pool: T[], scorer: (a: T, b: T) => Score, block: (x: T) => string, thr: IdentityThresholds = DEFAULT_THRESHOLDS,
): Candidate<T>[] {
  const byBlock = new Map<string, T[]>();
  for (const p of pool) {
    const k = block(p);
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k)!.push(p);
  }
  const out: Candidate<T>[] = [];
  const seen = new Set<string>();
  for (const n of newItems) {
    for (const p of byBlock.get(block(n)) ?? []) {
      if (p.id === n.id) continue;
      const pair = [p.id, n.id].sort().join("|");
      if (seen.has(pair)) continue;
      seen.add(pair);
      const s = scorer(p, n);
      const d = decide(s, thr);
      if (d !== "separate" || s.suggested === "relate_campus" || s.suggested === "relate_group") out.push({ left: p, right: n, score: s, decision: d });
    }
  }
  return out;
}

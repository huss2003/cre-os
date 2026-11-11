/**
 * Module 13 §8 — memory consolidation (pure). Groups repeated observations, identifies recurring preferences /
 * objections / commercial requirements and conflicts, while KEEPING every original observation and its source link.
 * Rules: a repeat of the same underlying source is not independent confirmation (§16.12); a recurring preference is
 * never turned into a confirmed requirement (§16.9).
 */
import type { SourceRef } from "../types";

export type ObsKind = "preference" | "objection" | "commercial" | "concern" | "commitment" | "fact";

export interface Obs {
  id: string;
  kind: ObsKind;
  field: string;
  text: string;                 // original wording (kept verbatim)
  value: unknown;               // normalised value (null = unknown)
  at: string | null;
  sourceKey: string;            // underlying source identity (capture source_hash / interaction id / document)
  independent: boolean;         // false = repeat of the same underlying source
  repeatOf: string | null;
  factClass: string | null;     // confirmed | estimate | assumption | hypothesis | preference | ...
  verification: string | null;
  source: SourceRef;
  speaker?: string | null;      // person id / name when known
}

export type Corroboration = "single_source" | "repeated_same_source" | "independently_corroborated";

export interface ConsolidatedItem {
  key: string; kind: ObsKind; field: string; label: string;
  occurrences: number;          // every observation, repeats included
  independentSources: number;   // distinct underlying sources, repeats excluded
  repeats: number;              // observations that only repeat an already-counted source
  corroboration: Corroboration;
  recurring: boolean;           // seen in ≥ 2 independent sources
  firstSeen: string | null; lastSeen: string | null;
  status: string;               // plain-words status (never "confirmed requirement" for a preference)
  isConfirmedRequirement: false;
  originals: Obs[];             // kept verbatim, with source links
}

export interface Conflict { field: string; kind: ObsKind; values: { value: string; observations: Obs[]; latestAt: string | null }[]; note: string }

const STOP = new Set(["the", "a", "an", "of", "in", "with", "and", "or", "to", "for", "they", "we", "prefer", "prefers", "preferred", "want", "wants", "need", "needs", "would", "like", "is", "are", "be", "our", "their", "company", "client", "mentioned", "said", "again", "only"]);
export function normaliseValue(v: unknown, text: string): string {
  if (v !== null && v !== undefined && typeof v !== "object") return String(v).toLowerCase().trim();
  if (v && typeof v === "object") return JSON.stringify(v).toLowerCase();
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).sort().join(" ");
}

const COMMERCIAL_FIELDS = new Set(["rent_psf", "cam", "budget", "area_target", "area_target_sf", "lock_in", "security_deposit", "escalation", "chargeable_area", "carpet_area", "rent_free", "fitout", "tenure", "parking_charges"]);
export function kindOf(o: { intent?: string | null; fact_class?: string | null; field?: string | null }): ObsKind {
  if (o.fact_class === "preference") return "preference";
  if (o.fact_class === "commitment") return "commitment";
  if (/objection/.test(String(o.intent ?? "")) || o.field === "objection") return "objection";
  if (/concern/.test(String(o.field ?? ""))) return "concern";
  if (o.intent === "commercial_quotation" || o.intent === "lease_information" || COMMERCIAL_FIELDS.has(String(o.field))) return "commercial";
  return "fact";
}

const label = (kind: ObsKind, field: string, sample: string) => `${kind === "commercial" ? field.replace(/_/g, " ") + ": " : ""}${sample}`;

/** Independent sources = distinct sourceKey among observations not flagged as repeats. */
export function countIndependent(obs: Obs[]): { independent: number; repeats: number } {
  const keys = new Set<string>();
  let repeats = 0;
  for (const o of obs) {
    if (!o.independent || o.repeatOf || keys.has(o.sourceKey)) { repeats++; continue; }
    keys.add(o.sourceKey);
  }
  return { independent: keys.size, repeats };
}

export function consolidate(obs: Obs[]): { items: ConsolidatedItem[]; recurring: ConsolidatedItem[]; conflicts: Conflict[] } {
  const groups = new Map<string, Obs[]>();
  for (const o of obs) {
    const k = `${o.kind}|${o.field}|${normaliseValue(o.value, o.text)}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const items: ConsolidatedItem[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    const { independent, repeats } = countIndependent(sorted);
    const corroboration: Corroboration = independent >= 2 ? "independently_corroborated" : list.length > 1 ? "repeated_same_source" : "single_source";
    const k = sorted[0].kind;
    const recurring = independent >= 2 && ["preference", "objection", "commercial", "concern"].includes(k);
    const status = k === "preference"
      ? (recurring ? `Recurring preference (${independent} separate sources) — not a confirmed requirement` : corroboration === "repeated_same_source" ? "Preference repeated from the same source — not independent confirmation" : "Stated preference — not a confirmed requirement")
      : k === "objection" ? (recurring ? `Repeated objection (${independent} separate sources)` : "Objection raised once")
        : corroboration === "independently_corroborated" ? `Seen in ${independent} separate sources` : corroboration === "repeated_same_source" ? "Repeated from the same source — counts once" : "Single source";
    items.push({ key, kind: k, field: sorted[0].field, label: label(k, sorted[0].field, sorted[sorted.length - 1].text), occurrences: list.length, independentSources: independent, repeats, corroboration, recurring,
      firstSeen: sorted[0].at, lastSeen: sorted[sorted.length - 1].at, status, isConfirmedRequirement: false, originals: sorted });
  }
  // Conflicts: commercial / fact fields with more than one distinct value (preferences may legitimately differ).
  const byField = new Map<string, ConsolidatedItem[]>();
  for (const i of items.filter((x) => x.kind === "commercial" || x.kind === "fact")) byField.set(`${i.kind}|${i.field}`, [...(byField.get(`${i.kind}|${i.field}`) ?? []), i]);
  const conflicts: Conflict[] = [];
  for (const [, list] of byField) {
    if (list.length < 2) continue;
    conflicts.push({ field: list[0].field, kind: list[0].kind,
      values: list.map((i) => ({ value: i.originals[i.originals.length - 1].text, observations: i.originals, latestAt: i.lastSeen })).sort((a, b) => String(b.latestAt ?? "").localeCompare(String(a.latestAt ?? ""))),
      note: "Conflicting values on record — neither is treated as current until one is confirmed." });
  }
  items.sort((a, b) => Number(b.recurring) - Number(a.recurring) || b.independentSources - a.independentSources || String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));
  return { items, recurring: items.filter((i) => i.recurring), conflicts };
}

export interface NoteIn { id: string; at: string; title: string; text: string; commitments: string[]; objections: string[]; source: SourceRef }

/** Combine several meeting notes into one view: originals kept, commitments/objections pooled with their sources. */
export function consolidateMeetingNotes(notes: NoteIn[]) {
  const s = [...notes].sort((a, b) => a.at.localeCompare(b.at));
  const pool = (k: "commitments" | "objections") => {
    const m = new Map<string, { text: string; sources: SourceRef[]; dates: string[] }>();
    for (const n of s) for (const t of n[k]) { const key = normaliseValue(null, t); const e = m.get(key) ?? { text: t, sources: [], dates: [] }; e.sources.push(n.source); e.dates.push(n.at.slice(0, 10)); m.set(key, e); }
    return [...m.values()].map((e) => ({ ...e, mentions: e.sources.length }));
  };
  return {
    meetings: s.length, from: s[0]?.at ?? null, to: s[s.length - 1]?.at ?? null,
    commitments: pool("commitments"), objections: pool("objections"),
    timeline: s.map((n) => ({ at: n.at, title: n.title, excerpt: n.text.slice(0, 300), source: n.source })),
    originals: s,
  };
}

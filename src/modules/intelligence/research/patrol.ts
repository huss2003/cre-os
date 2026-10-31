/**
 * Evidence conflict & expiry patrol (spec Part I §8 advanced additions, P0).
 * Reports newer quote vs old listing, current contact vs former signatory/stakeholder, changed completion date,
 * conflicting claims and expired evidence. Findings are reports, never automatic canonical changes.
 */
import { expiryFor, isExpired, isoDate } from "../common";

export interface PatrolClaim { id: string; subject_type: string; subject_id: string; claim_type: string; predicate: string | null; value_json: Record<string, unknown> | null; observed_on: string | null; created_at: string; expires_on: string | null; status: string }
export interface Finding { kind: "claim_conflict" | "claim_expired" | "quote_vs_listing" | "former_contact" | "completion_changed" | "availability_expired" | "dossier_stale"; subject_type: string; subject_id: string | null; detail: string; refs: { type: string; id: string }[]; severity: "low" | "medium" | "high"; dedupe_key: string }

function valueKey(v: Record<string, unknown> | null): string {
  if (!v) return "";
  const pick = { ...v };
  delete pick.summary;
  return JSON.stringify(Object.keys(pick).sort().map((k) => [k, pick[k]]));
}

export function detectClaimFindings(claims: PatrolClaim[], today: string): Finding[] {
  const out: Finding[] = [];
  const groups = new Map<string, PatrolClaim[]>();
  for (const c of claims) {
    const exp = expiryFor(c.claim_type, c.observed_on ?? isoDate(c.created_at), c.expires_on);
    if (isExpired(exp, today) && c.status !== "historical_observed") {
      out.push({ kind: "claim_expired", subject_type: c.subject_type, subject_id: c.subject_id, detail: `${c.claim_type.replace(/_/g, " ")} evidence expired on ${exp} — re-verify before use.`, refs: [{ type: "signal_claim", id: c.id }], severity: "low", dedupe_key: `expired:${c.id}:${exp}` });
    }
    if (!c.predicate && !c.value_json) continue;
    const k = `${c.subject_type}:${c.subject_id}:${c.claim_type}:${(c.predicate ?? "").toLowerCase().trim()}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (b.observed_on ?? b.created_at).localeCompare(a.observed_on ?? a.created_at));
    const newest = sorted[0];
    for (const older of sorted.slice(1)) {
      const a = valueKey(newest.value_json), b = valueKey(older.value_json);
      if (a && b && a !== b) {
        const kind = newest.claim_type === "completion_date" ? "completion_changed" : "claim_conflict";
        out.push({
          kind, subject_type: newest.subject_type, subject_id: newest.subject_id,
          detail: `Newer ${newest.claim_type.replace(/_/g, " ")} (${newest.observed_on ?? newest.created_at.slice(0, 10)}) disagrees with older evidence (${older.observed_on ?? older.created_at.slice(0, 10)}). Keep both; confirm which is current.`,
          refs: [{ type: "signal_claim", id: newest.id }, { type: "signal_claim", id: older.id }], severity: "medium", dedupe_key: `conflict:${newest.id}:${older.id}`,
        });
      }
    }
  }
  return out;
}

export interface QuoteLite { id: string; space_id: string | null; created_at: string; rent: number | null }
export interface AvailabilityLite { id: string; space_id: string; as_of: string; asking_rent_min: number | null; asking_rent_max: number | null; status: string; valid_until: string | null }

/** Newer quote vs older listing/brochure for the same space. */
export function detectQuoteVsListing(quotes: QuoteLite[], avail: AvailabilityLite[], today: string): Finding[] {
  const out: Finding[] = [];
  for (const a of avail) {
    if (a.status === "available" && a.valid_until && a.valid_until < today) {
      out.push({ kind: "availability_expired", subject_type: "space", subject_id: a.space_id, detail: `Availability snapshot from ${a.as_of} expired on ${a.valid_until}; recheck before any client send or visit.`, refs: [{ type: "availability", id: a.id }], severity: "medium", dedupe_key: `avail_exp:${a.id}` });
    }
  }
  for (const q of quotes) {
    if (!q.space_id || q.rent === null) continue;
    const older = avail.filter((a) => a.space_id === q.space_id && a.as_of <= q.created_at.slice(0, 10) && (a.asking_rent_min !== null || a.asking_rent_max !== null));
    for (const a of older) {
      const lo = a.asking_rent_min ?? a.asking_rent_max!, hi = a.asking_rent_max ?? a.asking_rent_min!;
      if (q.rent < lo || q.rent > hi) {
        out.push({ kind: "quote_vs_listing", subject_type: "space", subject_id: q.space_id, detail: `Newer quote rent ${q.rent} is outside the older listing range ${lo}–${hi} (as of ${a.as_of}). Use the quote; retire or re-verify the listing.`, refs: [{ type: "quote", id: q.id }, { type: "availability", id: a.id }], severity: "medium", dedupe_key: `qvl:${q.id}:${a.id}` });
      }
    }
  }
  return out;
}

export interface StakeholderEmployment { stakeholder_id: string; requirement_id: string; person_id: string; person_name: string; org_id: string; current_at_org: boolean | null }
export function detectFormerContacts(rows: StakeholderEmployment[]): Finding[] {
  return rows.filter((r) => r.current_at_org === false).map((r) => ({
    kind: "former_contact" as const, subject_type: "requirement", subject_id: r.requirement_id,
    detail: `${r.person_name} is listed as a stakeholder but their employment at the client is no longer current. Confirm who now holds the role.`,
    refs: [{ type: "stakeholder", id: r.stakeholder_id }, { type: "person", id: r.person_id }], severity: "high" as const, dedupe_key: `former:${r.stakeholder_id}`,
  }));
}

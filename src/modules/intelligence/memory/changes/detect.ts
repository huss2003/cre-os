/**
 * Module 13 §5.2 / §6 — deterministic change detectors (pure). Inputs are Module 1 rows; outputs are DetectedChange
 * records that keep BOTH the previous and the latest value, the date and the source. Arithmetic (deltas, %) is done
 * here in code, never by a model (S5). Unknown dates/values stay null (S6).
 */
import { CHANGE_MODULES, hrefFor, type ChangeKind, type ChangeVerification, type DetectedChange, type Difference, type SourceRef } from "./types";

type Row = Record<string, any>;

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const day = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : null);
const DAY = 864e5;

export function numericDiff(prev: number | null, next: number | null, unit = ""): Difference {
  if (prev === null || next === null) return { text: `${prev ?? "unknown"} → ${next ?? "unknown"}${unit}`, delta: null, pct: null };
  const delta = next - prev;
  const pct = prev !== 0 ? Math.round((delta / prev) * 1000) / 10 : null;
  return { text: `${prev.toLocaleString("en-IN")}${unit} → ${next.toLocaleString("en-IN")}${unit} (${delta >= 0 ? "+" : ""}${delta.toLocaleString("en-IN")}${pct !== null ? `, ${pct >= 0 ? "+" : ""}${pct}%` : ""})`, delta, pct };
}

export function setDiff(prev: string[] | null, next: string[] | null, name: (id: string) => string = (x) => x): Difference {
  const a = new Set(prev ?? []), b = new Set(next ?? []);
  const added = [...b].filter((x) => !a.has(x)), removed = [...a].filter((x) => !b.has(x));
  return { text: [added.length ? `added ${added.map(name).join(", ")}` : null, removed.length ? `removed ${removed.map(name).join(", ")}` : null].filter(Boolean).join("; ") || "no change", added, removed };
}

function mk(kind: ChangeKind, x: Omit<DetectedChange, "kind" | "modules" | "affectedRecords" | "affectedOpportunityIds"> & Partial<Pick<DetectedChange, "affectedRecords" | "affectedOpportunityIds">>): DetectedChange {
  return { kind, modules: CHANGE_MODULES[kind], affectedRecords: [], affectedOpportunityIds: [], ...x };
}

// ------------------------------------------------------------------ employment (§3.1, §6.1 employer / promotion)

const SENIORITY = ["intern", "junior", "associate", "senior", "manager", "senior_manager", "lead", "head", "director", "senior_director", "vp", "svp", "c_level", "founder"];
const seniorityRank = (s: string | null | undefined, title?: string | null) => {
  const k = String(s ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const i = SENIORITY.indexOf(k);
  if (i >= 0) return i;
  const t = String(title ?? "").toLowerCase();
  if (/\b(ceo|cfo|coo|cto|chief)\b/.test(t)) return SENIORITY.indexOf("c_level");
  if (/\b(svp|senior vice president)\b/.test(t)) return SENIORITY.indexOf("svp");
  if (/\b(vp|vice president)\b/.test(t)) return SENIORITY.indexOf("vp");
  if (/\bdirector\b/.test(t)) return SENIORITY.indexOf("director");
  if (/\bhead\b/.test(t)) return SENIORITY.indexOf("head");
  if (/\blead\b/.test(t)) return SENIORITY.indexOf("lead");
  if (/\bmanager\b/.test(t)) return SENIORITY.indexOf("manager");
  return -1;
};
const factVerification = (fs: string | null | undefined): ChangeVerification =>
  fs === "currently_confirmed" ? "verified" : fs === "reported" ? "reported" : fs === "ai_inference" ? "inferred" : fs ? "unverified" : "unknown";

/** Employment rows of ONE person (any order). Consecutive pairs → employer change or promotion / designation change. */
export function detectEmploymentChanges(personId: string, personName: string, rows: Row[]): DetectedChange[] {
  const sorted = [...rows].sort((a, b) => String(a.start_date ?? a.created_at).localeCompare(String(b.start_date ?? b.created_at)));
  const out: DetectedChange[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1], n = sorted[i];
    const src: SourceRef = { type: "employment", id: n.id, label: `Employment record${n.org_name ? ` at ${n.org_name}` : ""}`, href: hrefFor("person", personId) };
    const base = { entityType: "person", entityId: personId, changedAt: n.start_date ?? n.created_at ?? null, source: src, verification: factVerification(n.fact_status) };
    if (p.org_id !== n.org_id) {
      out.push(mk("employer_change", { ...base, dedupeKey: `employer_change:${personId}:${p.id}:${n.id}`, field: "employer",
        previous: { orgId: p.org_id, org: p.org_name ?? null, title: p.title ?? null }, latest: { orgId: n.org_id, org: n.org_name ?? null, title: n.title ?? null },
        difference: { text: `${personName}: ${p.org_name ?? "previous employer"} → ${n.org_name ?? "new employer"}. Previous employment kept as history; ${p.org_name ?? "the previous company"}'s opportunities stay with that company.` },
        affectedRecords: [{ type: "organisation", id: p.org_id, label: p.org_name }, { type: "organisation", id: n.org_id, label: n.org_name }], material: true }));
    } else if ((p.title ?? null) !== (n.title ?? null) && n.title) {
      const up = seniorityRank(n.seniority, n.title) > seniorityRank(p.seniority, p.title) && seniorityRank(p.seniority, p.title) >= 0;
      out.push(mk(up ? "promotion" : "designation_change", { ...base, dedupeKey: `designation:${personId}:${p.id}:${n.id}`, field: "designation",
        previous: p.title ?? null, latest: n.title, difference: { text: `${p.title ?? "unknown title"} → ${n.title}${up ? " (more senior)" : ""}` },
        affectedRecords: [{ type: "organisation", id: n.org_id, label: n.org_name }], material: up }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ requirement evolution (§5.2)

export const REQUIREMENT_FIELD_GROUPS: { kind: ChangeKind; field: string; status: string; cols: string[] }[] = [
  { kind: "requirement_area_change", field: "area", status: "area", cols: ["area_min_sf", "area_target_sf", "area_max_sf", "area_basis"] },
  { kind: "requirement_budget_change", field: "budget", status: "budget", cols: ["budget_min", "budget_max", "budget_basis"] },
  { kind: "requirement_location_change", field: "location", status: "preferred_locations", cols: ["preferred_geography_ids", "excluded_geography_ids"] },
  { kind: "requirement_timeline_change", field: "timeline", status: "occupation_date", cols: ["occupation_date", "decision_date"] },
  { kind: "requirement_other_change", field: "seats", status: "seats", cols: ["seats_min", "seats_target", "seats_max"] },
];
const pick = (snap: Row, cols: string[]) => Object.fromEntries(cols.map((c) => [c, snap?.[c] ?? null]));
export const fieldVerification = (s: string | null | undefined): ChangeVerification =>
  s === "client_confirmed" ? "verified" : s === "reported" ? "reported" : s === "estimated" ? "estimated" : "unknown";

/** A requirement change is material when area/seats move ≥10%, or location, timeline or budget changes at all. */
export function requirementDifference(field: string, prev: Row, next: Row, geoName: (id: string) => string = (x) => x): { difference: Difference; material: boolean } {
  if (field === "area" || field === "seats") {
    const k = field === "area" ? "area_target_sf" : "seats_target";
    const lo = field === "area" ? "area_min_sf" : "seats_min", hi = field === "area" ? "area_max_sf" : "seats_max";
    const a = num(prev[k]) ?? num(prev[hi]) ?? num(prev[lo]), b = num(next[k]) ?? num(next[hi]) ?? num(next[lo]);
    const d = numericDiff(a, b, field === "area" ? " sq ft" : " seats");
    const basis = field === "area" && prev.area_basis !== next.area_basis ? `; area basis ${prev.area_basis ?? "unknown"} → ${next.area_basis ?? "unknown"}` : "";
    return { difference: { ...d, text: d.text + basis }, material: d.pct == null ? true : Math.abs(d.pct) >= 10 };
  }
  if (field === "budget") {
    const d = numericDiff(num(prev.budget_max) ?? num(prev.budget_min), num(next.budget_max) ?? num(next.budget_min));
    return { difference: { ...d, text: `budget ${d.text}${prev.budget_basis !== next.budget_basis ? ` (basis ${prev.budget_basis ?? "unknown"} → ${next.budget_basis ?? "unknown"})` : ""}` }, material: true };
  }
  if (field === "location") {
    const d = setDiff(prev.preferred_geography_ids, next.preferred_geography_ids, geoName);
    const ex = setDiff(prev.excluded_geography_ids, next.excluded_geography_ids, geoName);
    return { difference: { ...d, text: `preferred: ${d.text}${ex.text !== "no change" ? `; excluded: ${ex.text}` : ""}` }, material: true };
  }
  if (field === "timeline") {
    return { difference: { text: `move-in ${day(prev.occupation_date) ?? "unknown"} → ${day(next.occupation_date) ?? "unknown"}${prev.decision_date !== next.decision_date ? `; decision ${day(prev.decision_date) ?? "unknown"} → ${day(next.decision_date) ?? "unknown"}` : ""}` }, material: true };
  }
  return { difference: { text: "changed" }, material: false };
}

export interface RequirementVersionRow { id?: string; version: number; snapshot: Row; field_status: Row | null; change_reason: string | null; change_proposal_id: string | null; created_at: string }

/** Consecutive requirement_version snapshots → one change per changed field group (both values kept). */
export function detectRequirementChanges(requirementId: string, versions: RequirementVersionRow[], geoName?: (id: string) => string): DetectedChange[] {
  const v = [...versions].sort((a, b) => a.version - b.version);
  const out: DetectedChange[] = [];
  for (let i = 1; i < v.length; i++) {
    const p = v[i - 1], n = v[i];
    for (const g of REQUIREMENT_FIELD_GROUPS) {
      const a = pick(p.snapshot, g.cols), b = pick(n.snapshot, g.cols);
      if (same(a, b)) continue;
      const { difference, material } = requirementDifference(g.field, a, b, geoName);
      out.push(mk(g.kind, {
        dedupeKey: `${g.kind}:${requirementId}:v${p.version}-v${n.version}`, entityType: "requirement", entityId: requirementId, field: g.field,
        previous: a, latest: b, difference, changedAt: n.created_at,
        source: n.change_proposal_id
          ? { type: "change_proposal", id: n.change_proposal_id, label: `Approved change (version ${n.version})${n.change_reason ? `: ${n.change_reason}` : ""}`, href: "/approvals" }
          : { type: "requirement_version", id: n.id ?? `${requirementId}:${n.version}`, label: `Requirement version ${n.version}${n.change_reason ? `: ${n.change_reason}` : ""}`, href: hrefFor("requirement", requirementId) },
        verification: fieldVerification(n.field_status?.[g.status]), material,
      }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ availability snapshots (rent / CAM / inventory)

/** Availability snapshots of ONE space (append-only). Rent, CAM and status changes between consecutive snapshots. */
export function detectAvailabilityChanges(space: { id: string; assetId: string | null; label: string }, snaps: Row[]): DetectedChange[] {
  const s = [...snaps].sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)) || String(a.created_at).localeCompare(String(b.created_at)));
  const out: DetectedChange[] = [];
  for (let i = 1; i < s.length; i++) {
    const p = s[i - 1], n = s[i];
    const base = { entityType: "space", entityId: space.id, changedAt: n.as_of, verification: factVerification(n.fact_status),
      source: { type: "availability", id: n.id, label: `Availability snapshot ${day(n.as_of)}${n.source_object_id ? "" : " (no source document)"}`, href: space.assetId ? hrefFor("asset", space.assetId) : null } as SourceRef,
      affectedRecords: space.assetId ? [{ type: "asset", id: space.assetId, label: space.label }] : [] };
    const pr = num(p.asking_rent_min) ?? num(p.asking_rent_max), nr = num(n.asking_rent_min) ?? num(n.asking_rent_max);
    if (pr !== nr && (pr !== null || nr !== null)) {
      const d = numericDiff(pr, nr, `/sq ft${n.rent_basis ? ` (${n.rent_basis})` : ""}`);
      out.push(mk("rent_change", { ...base, dedupeKey: `rent_change:${space.id}:${p.id}:${n.id}`, field: "asking_rent", previous: { min: p.asking_rent_min, max: p.asking_rent_max, basis: p.rent_basis ?? null }, latest: { min: n.asking_rent_min, max: n.asking_rent_max, basis: n.rent_basis ?? null }, difference: { ...d, text: `${space.label}: rent ${d.text}${p.rent_basis !== n.rent_basis ? ` — basis changed ${p.rent_basis ?? "unknown"} → ${n.rent_basis ?? "unknown"}, not directly comparable` : ""}` }, material: true }));
    }
    const pc = num(p.cam_psf_month), nc = num(n.cam_psf_month);
    if (pc !== nc && (pc !== null || nc !== null)) {
      const d = numericDiff(pc, nc, "/sq ft/month");
      out.push(mk("cam_change", { ...base, dedupeKey: `cam_change:${space.id}:${p.id}:${n.id}`, field: "cam_psf_month", previous: pc, latest: nc, difference: { ...d, text: `${space.label}: CAM ${d.text}` }, material: true }));
    }
    if ((p.status ?? null) !== (n.status ?? null)) {
      out.push(mk("inventory_change", { ...base, dedupeKey: `inventory_change:${space.id}:${p.id}:${n.id}`, field: "status", previous: p.status ?? null, latest: n.status ?? null, difference: { text: `${space.label}: ${p.status ?? "unknown"} → ${n.status ?? "unknown"}` }, material: true }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ company occupancy (leases)

/** Leases of ONE company. Consecutive leases → office move / expansion / reduction; upcoming expiry within `windowDays`. */
export function detectLeaseChanges(org: { id: string; name: string }, leases: Row[], today: string, windowDays = 180): DetectedChange[] {
  const l = [...leases].filter((x) => x.start_date || x.created_at).sort((a, b) => String(a.start_date ?? a.created_at).localeCompare(String(b.start_date ?? b.created_at)));
  const out: DetectedChange[] = [];
  for (let i = 1; i < l.length; i++) {
    const p = l[i - 1], n = l[i];
    const base = { entityType: "organisation", entityId: org.id, changedAt: n.start_date ?? null, verification: factVerification(n.fact_status),
      source: { type: "lease", id: n.id, label: `Lease${n.asset_name ? ` at ${n.asset_name}` : ""}${n.start_date ? ` from ${day(n.start_date)}` : ""}`, href: hrefFor("organisation", org.id) } as SourceRef };
    if (p.asset_id && n.asset_id && p.asset_id !== n.asset_id && !n.amends_lease_id) {
      out.push(mk("office_location_change", { ...base, dedupeKey: `office_location_change:${org.id}:${p.id}:${n.id}`, field: "office", previous: { assetId: p.asset_id, name: p.asset_name ?? null }, latest: { assetId: n.asset_id, name: n.asset_name ?? null },
        difference: { text: `${org.name}: ${p.asset_name ?? "previous building"} → ${n.asset_name ?? "new building"} (the earlier lease may still be running — confirm)` },
        affectedRecords: [{ type: "asset", id: p.asset_id, label: p.asset_name }, { type: "asset", id: n.asset_id, label: n.asset_name }], material: true }));
    }
    const pa = num(p.area_sf), na = num(n.area_sf);
    if (pa !== null && na !== null && pa !== na && (p.area_basis ?? null) === (n.area_basis ?? null)) {
      const d = numericDiff(pa, na, " sq ft");
      if (d.pct != null && Math.abs(d.pct) >= 5) out.push(mk(na > pa ? "expansion" : "reduction", { ...base, dedupeKey: `${na > pa ? "expansion" : "reduction"}:${org.id}:${p.id}:${n.id}`, field: "area_sf", previous: pa, latest: na, difference: { ...d, text: `${org.name}: leased area ${d.text}` }, material: true }));
    }
  }
  for (const x of leases) {
    const evs = ((x.lease_event ?? []) as Row[]).filter((e) => ["expiry", "lockin_end", "notice_deadline"].includes(e.event_type));
    const dates = [...evs.map((e) => ({ date: e.event_date as string, kind: String(e.event_type), confirmed: !!e.confirmed, id: e.id as string })),
      ...(x.contractual_expiry ? [{ date: x.contractual_expiry as string, kind: "expiry", confirmed: x.fact_status === "currently_confirmed", id: x.id as string }] : [])];
    for (const d of dates) {
      const days = Math.round((Date.parse(`${day(d.date)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
      if (days < 0 || days > windowDays) continue;
      out.push(mk("lease_expiry_approaching", { dedupeKey: `lease_expiry:${x.id}:${d.kind}:${day(d.date)}`, entityType: "organisation", entityId: org.id, field: d.kind,
        previous: null, latest: { date: day(d.date), days, kind: d.kind }, difference: { text: `${org.name}: ${d.kind.replace(/_/g, " ")} on ${day(d.date)} — ${days} days away${d.confirmed ? "" : " (date not confirmed)"}` },
        changedAt: null, verification: d.confirmed ? "verified" : "estimated",
        source: { type: "lease", id: x.id, label: `Lease${x.asset_name ? ` at ${x.asset_name}` : ""}`, href: hrefFor("organisation", org.id) },
        affectedRecords: [{ type: "lease", id: x.id, label: x.asset_name ?? "lease" }], material: days <= 90 }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ decision-maker change (§6.3)

export const DECISION_ROLES = ["approver", "sponsor"];

/**
 * Stakeholders of ONE requirement (including archived rows) with `current_employment` (true/false/null). A decision-maker
 * change = an earlier approver/sponsor who was removed (archived) or left the company, and a different person now in that role.
 */
export function detectDecisionMakerChange(requirementId: string, stakeholders: Row[]): DetectedChange[] {
  const dms = stakeholders.filter((s) => DECISION_ROLES.includes(s.role)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const gone = dms.filter((s) => s.archived_at || s.current_employment === false);
  const active = dms.filter((s) => !s.archived_at && s.current_employment !== false);
  const out: DetectedChange[] = [];
  for (const prev of gone) {
    const next = active.find((a) => a.person_id !== prev.person_id && a.role === prev.role && String(a.created_at) >= String(prev.created_at))
      ?? active.find((a) => a.person_id !== prev.person_id && String(a.created_at) >= String(prev.created_at));
    if (!next) continue;
    out.push(mk("decision_maker_change", {
      dedupeKey: `decision_maker_change:${requirementId}:${prev.id}:${next.id}`, entityType: "requirement", entityId: requirementId, field: prev.role,
      previous: { personId: prev.person_id, name: prev.person_name ?? null, role: prev.role }, latest: { personId: next.person_id, name: next.person_name ?? null, role: next.role },
      difference: { text: `${prev.role}: ${prev.person_name ?? "previous person"} → ${next.person_name ?? "new person"}. The new person's preferences and commercial authority are NOT assumed — confirm them.` },
      changedAt: next.created_at ?? null, source: { type: "stakeholder", id: next.id, label: `Stakeholder record (${next.role})`, href: hrefFor("requirement", requirementId) },
      verification: "unverified", affectedRecords: [{ type: "person", id: prev.person_id, label: prev.person_name }, { type: "person", id: next.person_id, label: next.person_name }], material: true,
    }));
  }
  return out;
}

// ------------------------------------------------------------------ opportunity inactive / rejected property relevant

const CLOSED = ["signed", "collected", "won", "lost", "closed", "closed_won", "closed_lost", "on_hold", "dormant"];
export function detectOpportunityInactive(opp: Row, lastActivityAt: string | null, today: string, days = 60): DetectedChange[] {
  if (CLOSED.includes(String(opp.stage)) || (opp.outcome && opp.outcome !== "open")) return [];
  const last = [lastActivityAt, opp.stage_entered_at, opp.updated_at].filter(Boolean).sort().pop() ?? null;
  if (!last) return [];
  const idle = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(String(last))) / DAY);
  if (idle < days) return [];
  return [mk("opportunity_inactive", {
    dedupeKey: `opportunity_inactive:${opp.id}:${day(last)}`, entityType: "opportunity", entityId: opp.id, field: "activity",
    previous: { lastActivity: day(last) }, latest: { idleDays: idle }, difference: { text: `${opp.name ?? "Opportunity"}: no recorded activity for ${idle} days (last ${day(last)})` },
    changedAt: null, source: { type: "opportunity", id: opp.id, label: opp.name ?? "Opportunity", href: hrefFor("opportunity", opp.id) }, verification: "verified",
    affectedOpportunityIds: [opp.id], material: true,
  })];
}

export interface Rejection { assetId: string; assetName: string; requirementId: string | null; at: string | null; reasons: string[]; explicit: boolean; source: SourceRef }
/** A rejected building with newer commercial/inventory information (availability or quote after the rejection) may be relevant again. */
export function detectRejectedRelevant(rejections: Rejection[], newer: { assetId: string; at: string; id: string; kind: "availability" | "quote"; text: string }[]): DetectedChange[] {
  const out: DetectedChange[] = [];
  for (const r of rejections) {
    if (!r.at) continue;
    const later = newer.filter((n) => n.assetId === r.assetId && n.at > r.at!).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (!later) continue;
    out.push(mk("rejected_property_relevant", {
      dedupeKey: `rejected_relevant:${r.requirementId ?? "none"}:${r.assetId}:${later.id}`, entityType: r.requirementId ? "requirement" : "asset", entityId: r.requirementId ?? r.assetId, field: "rejected_property",
      previous: { rejectedOn: day(r.at), reasons: r.reasons }, latest: { kind: later.kind, on: day(later.at), text: later.text },
      difference: { text: `${r.assetName} was rejected on ${day(r.at)}${r.reasons.length ? ` (${r.reasons.join("; ")})` : " (reason not recorded)"}; newer ${later.kind} on ${day(later.at)}: ${later.text}. Check whether the rejection reason still applies.` },
      changedAt: later.at, source: { type: later.kind, id: later.id, label: `${later.kind === "quote" ? "Quotation" : "Availability"} ${day(later.at)}`, href: hrefFor("asset", r.assetId) },
      verification: "unverified", affectedRecords: [{ type: "asset", id: r.assetId, label: r.assetName }], material: true,
    }));
  }
  return out;
}

// ------------------------------------------------------------------ change impact analysis (§6.3)

export interface DecisionMakerImpactInput {
  previous: { personId: string; name: string | null; role: string } | null;
  next: { personId: string; name: string | null; role: string } | null;
  historyWithPrevious: { interactions: number; lastAt: string | null; sources: SourceRef[] };
  contacts: { personId: string; name: string; title: string | null; current: boolean }[];
  activeOpportunities: { id: string; name: string; stage: string }[];
  historyWithNext: { interactions: number; lastAt: string | null };
}

/** Deterministic §6.3 analysis. Never assumes the new decision-maker shares the previous one's preferences or authority. */
export function decisionMakerImpact(i: DecisionMakerImpactInput) {
  const opps = i.activeOpportunities;
  return {
    previousDecisionMaker: i.previous,
    newDecisionMaker: i.next,
    relationshipWithPrevious: i.historyWithPrevious,
    relationshipWithNew: { ...i.historyWithNext, note: i.historyWithNext.interactions ? null : "No recorded interaction with the new decision-maker." },
    existingContacts: i.contacts,
    activeOpportunities: opps,
    opportunitiesNeedingReassessment: opps.map((o) => ({ ...o, reason: "Buying group changed — relationship and approval path need reassessment" })),
    recommendations: [
      "Update the buying group (stakeholders) on the requirement and confirm who now approves.",
      i.historyWithNext.interactions ? "Re-confirm priorities with the new decision-maker." : "Arrange an introduction to the new decision-maker (draft only — nothing is sent).",
    ],
    notifiedModules: CHANGE_MODULES.decision_maker_change,
    caveats: ["The new decision-maker's preferences and commercial authority are unknown until confirmed — they are not copied from the previous person."],
  };
}

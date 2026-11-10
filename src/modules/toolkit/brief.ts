/**
 * Module 8 — Requirement brief builder (formula "brief-1.0"). Pure assembly of sections A–G from a requirement
 * detail (deals getRequirementDetail), stakeholders and meeting outcomes. Every field carries a label:
 * Confirmed (client_confirmed) / Estimated (our estimate) / Assumption (reported second-hand) / Missing / Not applicable.
 * Nothing is invented: unknown stays "Missing" (S6). No arithmetic on money here (S5).
 */
import { FIELD_BY_KEY, fieldStatus, fieldValue, missingQuestions, stakeholderGaps, type FieldStatus, type MissingQuestion, type RequirementRow } from "@/modules/deals/requirements/contract";

export const BRIEF_FORMULA = "brief-1.0";
export type BriefLabel = "Confirmed" | "Estimated" | "Assumption" | "Missing" | "Not applicable";
export const LABEL_OF: Record<FieldStatus, BriefLabel> = { client_confirmed: "Confirmed", estimated: "Estimated", reported: "Assumption", unknown: "Missing" };

export interface BriefField { key: string; label: string; value: string | null; status: BriefLabel; editable: boolean }
export interface BriefSection { id: string; title: string; fields: BriefField[]; notes?: string[] }
export interface StakeholderSlot { slot: string; roles: string[]; people: string[]; status: BriefLabel }
export interface MeetingOutcomeLine { date: string | null; title: string; outcome: string | null; summary: string | null; decisionProcess: string | null; commitments: string[] }
export interface Brief {
  requirementId: string; title: string; organisation: string | null; rowVersion: number;
  sections: BriefSection[]; stakeholders: StakeholderSlot[]; stakeholderGaps: string[];
  meetings: MeetingOutcomeLine[]; openQuestions: MissingQuestion[]; pendingApprovals: { id: string; state: string; reason: string | null }[];
  missing: string[]; counts: Record<BriefLabel, number>;
}

/** Sections A–G: requirement contract keys per section (order = display order). */
export const BRIEF_SECTIONS: { id: string; title: string; keys: string[] }[] = [
  { id: "A", title: "A. Client and purpose", keys: ["objective", "transaction_kinds", "legal_entity"] },
  { id: "B", title: "B. Timing", keys: ["decision_date", "occupation_date", "current_lease_notice"] },
  { id: "C", title: "C. Space and people", keys: ["area", "area_basis", "seats", "growth_assumption", "attendance_assumption"] },
  { id: "D", title: "D. Budget and terms", keys: ["budget", "budget_basis", "budget_inclusions", "tenure_months", "lockin_months", "expansion", "capex_financing"] },
  { id: "E", title: "E. Location and building", keys: ["preferred_locations", "forbidden_locations", "employee_catchments", "parking", "transit", "power", "working_hours", "security_access", "it_load", "certifications", "fitout_standard"] },
  { id: "F", title: "F. Decision and authority", keys: ["commercial_authority", "procurement_process"] },
  { id: "G", title: "G. Mandate and status", keys: ["mandate_status", "conflict_status"] },
];

/** Brief stakeholder slots → requirement stakeholder roles (deals STAKEHOLDER_ROLES). */
export const STAKEHOLDER_SLOTS: { slot: string; roles: string[] }[] = [
  { slot: "Decision-maker", roles: ["approver", "sponsor"] },
  { slot: "Financial approver", roles: ["finance"] },
  { slot: "Procurement", roles: ["procurement"] },
  { slot: "Facilities", roles: ["technical"] },
  { slot: "Admin / workplace", roles: ["user"] },
  { slot: "Legal", roles: ["legal"] },
];

const present = (v: unknown) => !(v === null || v === undefined || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x === null || x === undefined || x === ""))));

export function formatValue(key: string, v: unknown, geoName: (id: string) => string = (x) => x): string | null {
  if (!present(v)) return null;
  const def = FIELD_BY_KEY.get(key);
  if (def?.kind === "range" && Array.isArray(v)) {
    const parts = key === "seats" || key === "area" ? ["min", "target", "max"] : ["min", "max"];
    return v.map((x, i) => (x === null || x === undefined || x === "" ? null : `${parts[i] ?? i}: ${Number(x).toLocaleString("en-IN")}`)).filter(Boolean).join(" · ");
  }
  if (def?.kind === "geo_list" && Array.isArray(v)) return v.map((id) => geoName(String(id))).join(", ");
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v).replace(/_/g, " ");
}

export interface BriefSource {
  requirement: RequirementRow & Record<string, unknown> & { organisation?: { display_name?: string } | null };
  stakeholders: { role: string; person?: { full_name?: string | null } | null }[];
  pendingProposals: { id: string; state: string; reason?: string | null }[];
  geographies?: { id: string; name: string }[];
  meetings?: { outcome: Record<string, unknown> | null; title?: string | null; start_at?: string | null }[];
}

export function buildBrief(src: BriefSource): Brief {
  const req = src.requirement;
  const na = new Set(req.constraints?.not_applicable ?? []);
  const geoName = (id: string) => src.geographies?.find((g) => g.id === id)?.name ?? `unknown place ${id.slice(0, 8)}`;
  const confirmedReq = req.status === "client_confirmed";
  const counts: Record<BriefLabel, number> = { Confirmed: 0, Estimated: 0, Assumption: 0, Missing: 0, "Not applicable": 0 };
  const sections: BriefSection[] = BRIEF_SECTIONS.map((s) => ({
    id: s.id, title: s.title,
    fields: s.keys.map((key) => {
      const def = FIELD_BY_KEY.get(key)!;
      const value = formatValue(key, fieldValue(req, key), geoName);
      const status: BriefLabel = na.has(key) ? "Not applicable" : value === null ? "Missing" : LABEL_OF[fieldStatus(req, key)];
      counts[status]++;
      return { key, label: def.label, value, status, editable: true };
    }),
  }));
  sections[0].notes = [`Organisation: ${req.organisation?.display_name ?? "not linked"}`, `Requirement status: ${String(req.status ?? "draft").replace(/_/g, " ")}${confirmedReq ? " — every change now needs approval" : ""}`];
  const stakeholders: StakeholderSlot[] = STAKEHOLDER_SLOTS.map(({ slot, roles }) => {
    const people = src.stakeholders.filter((s) => roles.includes(s.role)).map((s) => s.person?.full_name ?? "unnamed person");
    return { slot, roles, people, status: people.length ? "Confirmed" : "Missing" };
  });
  const meetings: MeetingOutcomeLine[] = (src.meetings ?? []).filter((m) => m.outcome).map((m) => {
    const o = m.outcome as Record<string, unknown>;
    const commitments = Array.isArray(o.commitments) ? (o.commitments as { who?: string; what?: string; due?: string | null }[]).map((c) => `${c.who === "us" ? "We" : "Client"}: ${c.what ?? ""}${c.due ? ` (by ${c.due})` : ""}`) : [];
    return { date: m.start_at ? String(m.start_at).slice(0, 10) : null, title: m.title ?? "Meeting", outcome: typeof o.outcome === "string" ? o.outcome : null, summary: typeof o.summary === "string" ? o.summary : null, decisionProcess: typeof o.decision_process === "string" ? o.decision_process : null, commitments };
  });
  const openQuestions = missingQuestions(req);
  const missing = openQuestions.filter((q) => q.priority === "mandatory" && q.reason === "missing").map((q) => q.label);
  return {
    requirementId: String(req.id), title: String(req.title ?? "Requirement"), organisation: req.organisation?.display_name ?? null, rowVersion: Number(req.row_version ?? 0),
    sections, stakeholders, stakeholderGaps: stakeholderGaps(src.stakeholders.map((s) => s.role)), meetings, openQuestions,
    pendingApprovals: src.pendingProposals.map((p) => ({ id: p.id, state: p.state, reason: p.reason ?? null })), missing, counts,
  };
}

/** Parse a form value for a contract field ("min, target, max" for ranges; comma lists for lists). */
export function parseFieldInput(key: string, raw: string): unknown {
  const def = FIELD_BY_KEY.get(key);
  if (!def) throw new Error(`unknown requirement field: ${key}`);
  const t = raw.trim();
  if (def.kind === "range") return t ? t.split(",").map((x) => x.trim()) : [];
  if (def.kind === "list" || def.kind === "geo_list") return t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  return t;
}

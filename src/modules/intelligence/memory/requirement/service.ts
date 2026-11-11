import "server-only";
/** Requirement memory (spec §5.1, §5.3) over requirement + immutable requirement_version snapshots. */
import { REQUIREMENT_FIELDS, fieldStatus, fieldValue, missingQuestions, type RequirementRow } from "@/modules/deals/requirements/contract";
import { labels, q } from "../data";
import { hrefFor, item, type MemCtx, type MemoryItem, type RequirementConfidence, type Row } from "../types";
import { CONFIDENCE_LABEL, requirementConfidence, requirementEvolution, type RequirementChange, type VersionRow } from "./confidence";

const CLOSED = new Set(["closed", "lost", "won", "dormant", "cancelled"]);
export const REQUIREMENT_STALE_DAYS = 180;

export interface RequirementField extends MemoryItem { confidence: number | null; confidenceClass: RequirementConfidence; confidenceLabel: string }
export interface RequirementContext {
  requirement: Row;
  orgName: string | null;
  current: RequirementField[];
  history: VersionRow[];
  changes: RequirementChange[];
  options: { id: string; assetId: string | null; assetName: string | null; status: string; disqualifiers: string[] }[];
  rejections: { assetId: string | null; assetName: string | null; reason: string; explicit: boolean; at: string; source: string }[];
  decisionMakers: { personId: string; name: string; role: string; stillAtCompany: boolean }[];
  outstandingQuestions: { key: string; question: string; priority: string }[];
  isHistorical: boolean;
  stale: boolean;
}

export async function getRequirementContext(ctx: MemCtx, requirementId: string): Promise<RequirementContext | null> {
  const ws = ctx.workspaceId;
  const { data: r } = await ctx.db.from("requirement").select("*").eq("workspace_id", ws).eq("id", requirementId).maybeSingle();
  if (!r) return null;
  const [versions, opts, stake, conflicts, fb] = await Promise.all([
    q(ctx.db.from("requirement_version").select("version, snapshot, field_status, created_at, change_reason, change_proposal_id").eq("workspace_id", ws).eq("requirement_id", requirementId).order("version", { ascending: true }).limit(200)),
    q(ctx.db.from("shortlist_option").select("id, asset_id, option_status, disqualifiers, updated_at").eq("workspace_id", ws).eq("requirement_id", requirementId).is("archived_at", null).limit(300)),
    q(ctx.db.from("stakeholder").select("person_id, role, person:person_id(full_name)").eq("workspace_id", ws).eq("requirement_id", requirementId).is("archived_at", null)),
    q(ctx.db.from("capture_observation").select("id, field, conflict_with, status").eq("workspace_id", ws).eq("subject_type", "requirement").eq("subject_id", requirementId).not("conflict_with", "is", null).is("archived_at", null).limit(100)).catch(() => [] as Row[]),
    q(ctx.db.from("meeting_property_feedback").select("asset_id, fields, updated_at, prep:prep_id!inner(requirement_id)").eq("workspace_id", ws).eq("prep.requirement_id", requirementId).is("archived_at", null).limit(200)).catch(() => [] as Row[]),
  ]);
  const assetNames = await labels(ctx, "asset", [...opts.map((o) => o.asset_id), ...fb.map((f) => f.asset_id)]);
  const orgName = r.org_id ? (await labels(ctx, "organisation", [r.org_id])).get(r.org_id) ?? null : null;
  const pids = stake.map((s) => s.person_id);
  const curEmp = pids.length && r.org_id ? await q(ctx.db.from("employment").select("person_id, is_current, end_date").eq("workspace_id", ws).eq("org_id", r.org_id).in("person_id", pids).is("archived_at", null)) : [];
  const lastChange = versions.at(-1)?.created_at ?? r.updated_at;
  const stale = Date.now() - Date.parse(lastChange) > REQUIREMENT_STALE_DAYS * 86_400_000;
  const isHistorical = CLOSED.has(r.status);
  const conflictFields = new Set(conflicts.filter((c) => !["rejected", "dismissed"].includes(c.status)).map((c) => String(c.field ?? "").split(".")[0]));
  const lastVersionFor = (key: string) => {
    const ch = requirementEvolution(versions as VersionRow[]).filter((c) => c.field === key).at(-1);
    return ch ? { at: ch.at, version: ch.toVersion } : versions[0] ? { at: versions[0].created_at, version: versions[0].version } : null;
  };
  const current: RequirementField[] = REQUIREMENT_FIELDS.map((f) => {
    const value = fieldValue(r as RequirementRow, f.key);
    const st = fieldStatus(r as RequirementRow, f.key);
    const cls = requirementConfidence(st, { value, conflicting: conflictFields.has(f.key), outdated: isHistorical || stale });
    const lv = lastVersionFor(f.key);
    const base = item({ entityId: requirementId, entityType: "requirement", category: `requirement.${f.key}`, label: f.label, value,
      sourceRef: { type: "requirement_version", id: requirementId, label: lv ? `Version ${lv.version}` : "Requirement record", href: hrefFor("requirement", requirementId) },
      observedAt: lv?.at ?? r.created_at, lastVerifiedAt: st === "client_confirmed" ? r.confirmed_at ?? null : null,
      verification: st === "client_confirmed" ? "verified" : st === "reported" ? "reported" : st === "estimated" ? "estimated" : "unknown",
      version: lv?.version ?? null, related: r.org_id ? [{ type: "organisation", id: r.org_id }] : [],
      status: cls === "conflicting" ? "conflicting" : isHistorical ? "historical" : st === "client_confirmed" ? "current" : "unverified" });
    return { ...base, confidenceClass: cls, confidenceLabel: CONFIDENCE_LABEL[cls] };
  });
  const rejections = [
    ...fb.filter((f) => f.fields?.interest === "rejected" && f.fields?.explicit_rejection === true).map((f) => ({ assetId: f.asset_id, assetName: assetNames.get(f.asset_id) ?? null,
      reason: String(f.fields?.notes ?? f.fields?.concerns ?? f.fields?.reason ?? "").trim() || "Reason not recorded", explicit: true, at: f.updated_at, source: "Site-visit feedback" })),
    ...opts.filter((o) => o.option_status === "rejected").map((o) => ({ assetId: o.asset_id, assetName: assetNames.get(o.asset_id) ?? null,
      reason: (o.disqualifiers ?? []).length ? `Did not fit: ${(o.disqualifiers as string[]).join(", ")}` : "Reason not recorded", explicit: false, at: o.updated_at, source: "Shortlist option" })),
  ];
  return {
    requirement: r, orgName, current, history: [...versions].reverse() as VersionRow[], changes: requirementEvolution(versions as VersionRow[]).reverse(),
    options: opts.map((o) => ({ id: o.id, assetId: o.asset_id, assetName: assetNames.get(o.asset_id) ?? null, status: o.option_status ?? "proposed", disqualifiers: o.disqualifiers ?? [] })),
    rejections,
    decisionMakers: stake.map((s) => ({ personId: s.person_id, name: s.person?.full_name ?? "Contact", role: s.role,
      stillAtCompany: curEmp.some((e) => e.person_id === s.person_id && e.is_current && !e.end_date) })),
    outstandingQuestions: missingQuestions(r as RequirementRow).map((m) => ({ key: m.key, question: m.question, priority: m.priority })),
    isHistorical, stale,
  };
}

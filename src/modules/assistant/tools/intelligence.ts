/* eslint-disable @typescript-eslint/no-explicit-any -- memory objects are rendered generically */
import { z } from "zod";
import type { ToolContext, ToolResult, SourceRef } from "../types";
import { defineTool, denied, failed, getOne, HREF, isUuid } from "./shared";
import { getCompanyContext, getPersonContext } from "@/modules/intelligence/memory";
import {
  getRequirementEvolution, listChanges, whatChanged, listRecommendations, loadRejections, consolidateEntity, findSimilarRequirements, memCtxFromTool,
} from "@/modules/intelligence/memory/integrate";

/**
 * Module 13 → Module 12: contextual memory tools (§7.3). Read-only (category A), RLS client, every answer carries
 * source references, and anything not on record is stated as unknown — never invented (§16.3, §16.15).
 */
const mc = (t: ToolContext) => memCtxFromTool(t.ctx);
const src = (s: { label: string; href: string | null } | null | undefined, observedAt?: string | null, status: SourceRef["status"] = "reported"): SourceRef[] =>
  s ? [{ label: s.label, href: s.href ?? undefined, observedAt: observedAt ?? null, status }] : [];
const d10 = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "unknown date");
const unknownLine = (u: string[]) => (u.length ? ` Unknown: ${u.slice(0, 5).join("; ")}.` : "");

const getCompanyContextTool = defineTool({
  id: "get_company_context", module: "database", category: "A",
  description: "Company memory (Intelligence Layer): what we last discussed, current vs historical requirements, decision-makers (with source), people (current/former), active/previous opportunities, open commitments, objections, recent changes and recommended next actions — each with a source. Use for 'what did we last discuss with X', 'who is the actual decision-maker at X', 'what should I know about X'. Unknown items are listed as unknown.",
  input: z.object({ companyId: z.string().describe("organisation id") }),
  async run(i, t): Promise<ToolResult> {
    if (!isUuid(i.companyId) || !(await getOne(t, "organisation", i.companyId, "id"))) return denied(t, "get_company_context", { companyId: i.companyId });
    try {
      const c = await getCompanyContext(mc(t), i.companyId);
      if (!c) return denied(t, "get_company_context", { companyId: i.companyId });
      const [changes, recs] = await Promise.all([listChanges(mc(t), { entityType: "organisation", entityId: i.companyId, limit: 5 }), listRecommendations(mc(t), { orgId: i.companyId, limit: 3 })]);
      const last = c.interactions[0];
      const dms = c.decisionMakers;
      const parts = [
        last ? `Last discussion ${d10(last.occurred_at)} (${last.channel}${last.subject ? `: ${last.subject}` : ""})${last.summary ? ` — ${String(last.summary).slice(0, 160)}` : ""}.` : "No recorded discussion with this company.",
        dms.length ? `Decision-makers on record: ${dms.map((d) => `${d.name} (${d.role}${d.requirementTitle ? `, ${d.requirementTitle}` : ""})`).join("; ")}.` : "Decision-maker: unknown (no approver/sponsor recorded).",
        `${c.currentRequirements.length} current requirement(s), ${c.activeOpportunities.length} active opportunit${c.activeOpportunities.length === 1 ? "y" : "ies"}, ${c.commitments.filter((x) => x.pending).length} pending commitment(s).`,
        changes.length ? `Recent changes: ${changes.slice(0, 3).map((x) => x.difference.text).join(" | ")}.` : "",
        recs.length ? `Recommended: ${recs.map((r) => r.nextAction).join(" | ")}` : "",
      ].filter(Boolean);
      return {
        ok: true, summary: `${c.org.display_name}: ${parts.join(" ")}${unknownLine(c.unknowns)}`,
        data: { company: c.org.display_name, lastDiscussion: last ? { at: last.occurred_at, channel: last.channel, subject: last.subject, summary: last.summary } : null, decisionMakers: dms,
          currentRequirements: c.currentRequirements.map((r: any) => ({ id: r.id, title: r.title })), activeOpportunities: c.activeOpportunities.map((o: any) => ({ id: o.id, name: o.name, stage: o.stage })),
          pendingCommitments: c.commitments.filter((x) => x.pending).slice(0, 8).map((x) => ({ text: x.text, due: x.due, source: x.source.label })), objections: c.objections.slice(0, 8).map((o) => ({ text: o.text, at: o.at, source: o.source.label })),
          changes: changes.map((x) => ({ kind: x.label, text: x.difference.text, at: x.changedAt, verification: x.verification })), recommendations: recs.map((r) => ({ what: r.title, why: r.why, next: r.nextAction, confidence: r.confidence })), unknown: c.unknowns },
        sources: [{ label: `Company record: ${c.org.display_name}`, href: HREF.company(i.companyId), status: "verified" }, ...c.interactions.slice(0, 3).map((x: any) => ({ label: `${x.channel} ${d10(x.occurred_at)}${x.subject ? ` — ${x.subject}` : ""}`, href: HREF.company(i.companyId), observedAt: x.occurred_at, status: "reported" as const }))],
        missing: c.unknowns,
      };
    } catch (e) { return failed("Could not load company memory", e); }
  },
});

const getPersonContextTool = defineTool({
  id: "get_person_context", module: "contacts", category: "A",
  description: "Contact memory: current and previous employers/designations (verified vs inferred), decision role, relationship strength with its evidence, last discussion, pending commitments, objections, preferences (stated vs inferred), next meeting and what to know before meeting them. Use for 'have we spoken to this person before', 'what should I know before meeting X'. Previous employers' opportunities stay with those companies.",
  input: z.object({ personId: z.string().describe("person id") }),
  async run(i, t): Promise<ToolResult> {
    if (!isUuid(i.personId) || !(await getOne(t, "person", i.personId, "id"))) return denied(t, "get_person_context", { personId: i.personId });
    try {
      const p = await getPersonContext(mc(t), i.personId);
      if (!p) return denied(t, "get_person_context", { personId: i.personId });
      const cur = p.currentEmployment[0], last = p.interactions[0];
      const lines = [
        cur ? `Currently ${cur.display} (${cur.verification}).` : "Current employer: unknown.",
        p.previousEmployment.length ? `Previously: ${p.previousEmployment.map((e) => e.display).join("; ")}.` : "",
        last ? `Spoken before: yes — ${p.interactions.length} recorded interaction(s), last ${d10(last.occurred_at)} (${last.channel}${last.subject ? `: ${last.subject}` : ""}).` : "Spoken before: no recorded interaction.",
        `Relationship: ${p.relationship.level}${p.relationship.explanation?.[0] ? ` — ${p.relationship.explanation[0]}` : ""}.`,
        p.commitments.filter((c) => c.pending).length ? `Pending commitments: ${p.commitments.filter((c) => c.pending).slice(0, 3).map((c) => c.text).join("; ")}.` : "No pending commitments recorded.",
        p.objections.length ? `Objections raised: ${p.objections.slice(0, 3).map((o) => o.text).join("; ")}.` : "",
        p.decisionRoles.length ? `Decision role: ${p.decisionRoles.map((r) => r.display).join("; ")}.` : "Decision authority: unknown.",
        p.nextInteraction ? `Next: ${p.nextInteraction.title} on ${d10(p.nextInteraction.at)}.` : "",
      ].filter(Boolean);
      return {
        ok: true, summary: `${p.person.name}: ${lines.join(" ")}${unknownLine(p.unknowns)}`,
        data: { name: p.person.name, current: p.currentEmployment.map((e) => ({ text: e.display, verification: e.verification, source: e.sourceRef?.label ?? null })), previous: p.previousEmployment.map((e) => e.display),
          relationship: { level: p.relationship.level, why: p.relationship.explanation, caveats: p.relationship.caveats }, interactions: p.interactions.length, lastInteraction: last ? { at: last.occurred_at, channel: last.channel, subject: last.subject, summary: last.summary } : null,
          pendingCommitments: p.commitments.filter((c) => c.pending).map((c) => ({ text: c.text, due: c.due, source: c.source.label })), objections: p.objections.map((o) => ({ text: o.text, at: o.at })),
          preferences: p.preferences.map((x) => ({ text: x.display, verification: x.verification })), next: p.nextInteraction, unknown: p.unknowns },
        sources: [{ label: `Contact: ${p.person.name}`, href: HREF.person(i.personId), status: "verified" }, ...p.interactions.slice(0, 3).map((x: any) => ({ label: `${x.channel} ${d10(x.occurred_at)}`, href: HREF.person(i.personId), observedAt: x.occurred_at, status: "reported" as const })),
          ...p.currentEmployment.flatMap((e) => src(e.sourceRef, e.observedAt, e.verification === "verified" ? "verified" : e.verification === "inferred" ? "inferred" : "reported"))],
        missing: p.unknowns,
      };
    } catch (e) { return failed("Could not load contact memory", e); }
  },
});

const getRequirementHistoryTool = defineTool({
  id: "get_requirement_history", module: "database", category: "A",
  description: "Requirement evolution: the original requirement, every change (area, budget, location, timeline) with when, source and whether the old value is obsolete; previously rejected properties with the recorded reasons (explicit client rejections vs our own matching); recurring preferences (never treated as confirmed requirements). Use for 'has their requirement changed', 'which properties have they rejected and why'. Pass requirementId, or companyId to use the company's latest requirement.",
  input: z.object({ requirementId: z.string().optional(), companyId: z.string().optional() }),
  async run(i, t): Promise<ToolResult> {
    let reqId = i.requirementId;
    if (!reqId && i.companyId && isUuid(i.companyId)) {
      const { data } = await (t.ctx.db as any).from("requirement").select("id").eq("workspace_id", t.ctx.workspaceId).eq("org_id", i.companyId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      reqId = data?.id;
      if (!reqId) return { ok: true, summary: "No requirement on record for this company — their requirement is unknown.", data: { requirement: null }, missing: ["Requirement"] };
    }
    const reqRow = reqId && isUuid(reqId) ? await getOne(t, "requirement", reqId, "id, org_id") : null;
    if (!reqId || !reqRow) return denied(t, "get_requirement_history", { requirementId: reqId ?? null });
    try {
      // Preferences may be recorded on the company or on the requirement: consolidate both (repeats still count once).
      const [ev, rej, cons] = await Promise.all([getRequirementEvolution(mc(t), reqId), loadRejections(mc(t), { requirementId: reqId }), consolidateEntity(mc(t), { requirementId: reqId, orgId: reqRow.org_id ?? undefined })]);
      const changed = ev.steps.length
        ? `Changed ${ev.steps.length} time(s): ${ev.steps.slice(-3).map((s) => `${d10(s.at)} — ${s.changes.map((c) => c.text).join("; ")} [source: ${s.source.label}; ${s.changes.some((c) => c.previousObsolete) ? "old value obsolete" : "not client-confirmed yet"}]`).join(" | ")}.`
        : "No change recorded since the original requirement.";
      const explicit = rej.filter((r) => r.explicit), other = rej.filter((r) => !r.explicit);
      const rejLine = explicit.length ? `Rejected by the client: ${explicit.map((r) => `${r.assetName} (${r.reasons.join("; ") || "reason not recorded"}, ${d10(r.at)})`).join("; ")}.` : "No explicit client rejection recorded.";
      const prefs = cons.recurring.filter((x) => x.kind === "preference");
      return {
        ok: true, summary: `${ev.title ?? "Requirement"}: ${changed} ${rejLine}${other.length ? ` ${other.length} option(s) were ruled out by our matching (not a client decision).` : ""}${prefs.length ? ` Recurring preferences (not confirmed requirements): ${prefs.map((p) => p.label).join("; ")}.` : ""}${unknownLine(ev.unknown)}`,
        data: { original: ev.original, current: ev.current, changes: ev.steps, rejections: rej.map((r) => ({ building: r.assetName, reasons: r.reasons, at: r.at, explicitClientRejection: r.explicit, source: r.source.label })),
          recurringPreferences: prefs.map((p) => ({ text: p.label, independentSources: p.independentSources, status: p.status })), conflicts: cons.conflicts.map((c) => ({ field: c.field, values: c.values.map((v) => v.value) })) },
        sources: [{ label: `Requirement: ${ev.title ?? reqId}`, href: HREF.requirement(reqId), status: "verified" }, ...ev.steps.slice(-3).map((s) => ({ label: s.source.label, href: s.source.href ?? undefined, observedAt: s.at, status: "reported" as const })),
          ...rej.slice(0, 5).map((r) => ({ label: r.source.label, href: r.source.href ?? undefined, observedAt: r.at, status: r.explicit ? "reported" as const : "inferred" as const }))],
        missing: ev.unknown,
      };
    } catch (e) { return failed("Could not load requirement history", e); }
  },
});

const whatChangedTool = defineTool({
  id: "what_changed", module: "database", category: "A",
  description: "What changed for a company, contact, requirement, building or deal: previous vs latest value, difference, date, source, verification and affected opportunities (employer moves, promotions, decision-maker changes, requirement area/budget/location/timeline changes, rent/CAM/inventory changes, lease expiry approaching, inactive deals, rejected buildings now relevant).",
  input: z.object({ entityType: z.enum(["company", "person", "requirement", "asset", "opportunity"]), entityId: z.string(), sinceDays: z.number().int().min(1).max(3650).optional() }),
  async run(i, t): Promise<ToolResult> {
    const table = { company: "organisation", person: "person", requirement: "requirement", asset: "asset", opportunity: "opportunity" }[i.entityType];
    if (!isUuid(i.entityId) || !(await getOne(t, table, i.entityId, "id"))) return denied(t, "what_changed", { entityType: i.entityType });
    try {
      const scope = i.entityType === "company" ? { orgId: i.entityId } : i.entityType === "person" ? { personId: i.entityId } : i.entityType === "requirement" ? { requirementId: i.entityId } : i.entityType === "asset" ? { assetId: i.entityId } : { opportunityId: i.entityId };
      const since = i.sinceDays ? new Date(Date.now() - i.sinceDays * 864e5).toISOString() : undefined;
      const items = await whatChanged(mc(t), scope, { since, persist: false });
      return {
        ok: true, summary: items.length ? `${items.length} change(s): ${items.slice(0, 4).map((c) => `${c.difference.text} (${d10(c.changedAt)}, ${c.verification})`).join(" | ")}` : "No changes found in the records for this item.",
        data: { items: items.slice(0, 15).map((c) => ({ kind: c.kind, previous: c.previous, latest: c.latest, difference: c.difference.text, at: c.changedAt, verification: c.verification, source: c.source?.label ?? null, affectedOpportunities: c.affectedOpportunityIds.length, modules: c.modules })) },
        sources: items.slice(0, 6).flatMap((c) => src(c.source, c.changedAt, c.verification === "verified" ? "verified" : c.verification === "inferred" ? "inferred" : "reported")),
      };
    } catch (e) { return failed("Could not check changes", e); }
  },
});

const recommendationsTool = defineTool({
  id: "get_recommendations", module: "database", category: "A",
  description: "Intelligence recommendations (what was identified, why it matters, supporting information, sources, confidence, suggested next action) for a company, contact, requirement or deal — or the whole workspace when no id is given. Suggestions only; nothing is executed.",
  input: z.object({ companyId: z.string().optional(), personId: z.string().optional(), requirementId: z.string().optional(), opportunityId: z.string().optional(), limit: z.number().int().min(1).max(20).default(5) }),
  async run(i, t): Promise<ToolResult> {
    for (const [k, tb] of [["companyId", "organisation"], ["personId", "person"], ["requirementId", "requirement"], ["opportunityId", "opportunity"]] as const) {
      const v = i[k]; if (v && (!isUuid(v) || !(await getOne(t, tb, v, "id")))) return denied(t, "get_recommendations", { [k]: v });
    }
    try {
      const recs = await listRecommendations(mc(t), { orgId: i.companyId, personId: i.personId, requirementId: i.requirementId, opportunityId: i.opportunityId, limit: i.limit });
      return {
        ok: true, summary: recs.length ? recs.map((r) => `${r.title} — ${r.nextAction} (${r.confidence} confidence)`).join(" | ") : "No recommendations from the current records.",
        data: { items: recs.map((r) => ({ what: r.title, why: r.why, supporting: r.supporting, confidence: r.confidence, next: r.nextAction, href: r.href })) },
        sources: recs.flatMap((r) => r.sourceRefs.slice(0, 2).map((s) => ({ label: s.label, href: s.href ?? undefined, status: "reported" as const }))).slice(0, 10),
      };
    } catch (e) { return failed("Could not load recommendations", e); }
  },
});

const similarTool = defineTool({
  id: "find_similar_requirements", module: "database", category: "A",
  description: "Which companies have similar requirements: compares area (±25%), preferred locations and move-in timing of other live requirements with a given requirement (or a company's latest). Deterministic; only records in CRE OS.",
  input: z.object({ requirementId: z.string().optional(), companyId: z.string().optional(), limit: z.number().int().min(1).max(20).default(8) }),
  async run(i, t): Promise<ToolResult> {
    try {
      const r = await findSimilarRequirements(mc(t), { requirementId: i.requirementId, orgId: i.companyId, limit: i.limit });
      if (!r.base) return { ok: true, summary: "No requirement on record to compare with — unknown.", data: { items: [] }, missing: ["Requirement"] };
      return {
        ok: true, summary: r.items.length ? `${r.items.length} similar requirement(s) to ${r.base.title}: ${r.items.map((x) => `${x.orgName ?? "company unknown"} — ${x.title} (${x.why.join(", ")})`).join("; ")}` : `No other live requirement is similar to ${r.base.title}.`,
        data: r, sources: r.items.map((x) => ({ label: `Requirement: ${x.title}`, href: HREF.requirement(x.id), status: "verified" as const })),
        coverage: { checked: r.checked, withData: r.items.length, note: "Only requirements recorded in CRE OS; missing area or location counts as unknown, not as a match." },
      };
    } catch (e) { return failed("Could not compare requirements", e); }
  },
});

export const intelligenceTools = [getCompanyContextTool, getPersonContextTool, getRequirementHistoryTool, whatChangedTool, recommendationsTool, similarTool];

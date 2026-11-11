import "server-only";
/** Meeting preparation context (spec §7.2) for Module 7. Deterministic assembly; AI only for an optional labelled summary. */
import type { Commitment, Objection } from "../data";
import { q } from "../data";
import { getCompanyContext } from "../entity/company";
import { getPersonContext } from "../entity/person";
import { getRequirementContext } from "../requirement/service";
import type { MemCtx, Row } from "../types";

export interface MeetingAttendee { personId: string; name: string; designation: string | null; company: string | null; previousInteractions: number; lastDiscussion: { at: string; subject: string | null; summary: string | null } | null; relationship: string; unknowns: string[] }
export interface MeetingContext {
  meeting: Row;
  orgId: string | null; orgName: string | null;
  attendees: MeetingAttendee[];
  unmatchedAttendees: string[];
  lastDiscussion: { at: string; subject: string | null; summary: string | null; sourceId: string } | null;
  pendingCommitments: Commitment[];
  requirements: { id: string; title: string; summary: string }[];
  objections: Objection[];
  commercialDiscussions: { asset: string | null; text: string; at: string }[];
  pendingQuestions: string[];
  developments: { title: string; at: string; verified: boolean }[];
  suggestedPoints: string[];
}

export async function getMeetingContext(ctx: MemCtx, meetingId: string): Promise<MeetingContext | null> {
  const ws = ctx.workspaceId;
  const { data: m } = await ctx.db.from("meeting_visit").select("id, title, start_at, end_at, location, kind, status, opportunity_id, linked_entity_type, linked_entity_id").eq("workspace_id", ws).eq("id", meetingId).maybeSingle();
  if (!m) return null;
  const preps = await q(ctx.db.from("meeting_prep").select("id, org_id, requirement_id, opportunity_id, meeting_prep_attendee(person_id, raw_name, side)").eq("workspace_id", ws).eq("meeting_visit_id", meetingId).is("archived_at", null).limit(1));
  const prep = preps[0] ?? null;
  let orgId: string | null = prep?.org_id ?? (m.linked_entity_type === "organisation" ? m.linked_entity_id : null);
  const oppId = prep?.opportunity_id ?? m.opportunity_id;
  let reqId: string | null = prep?.requirement_id ?? null;
  if (oppId && (!orgId || !reqId)) {
    const { data: o } = await ctx.db.from("opportunity").select("org_id, requirement_id").eq("workspace_id", ws).eq("id", oppId).maybeSingle();
    orgId = orgId ?? o?.org_id ?? null; reqId = reqId ?? o?.requirement_id ?? null;
  }
  const pids = new Set<string>();
  const unmatched: string[] = [];
  for (const a of (prep?.meeting_prep_attendee ?? []) as Row[]) { if (a.side === "internal") continue; if (a.person_id) pids.add(a.person_id); else if (a.raw_name) unmatched.push(a.raw_name); }
  if (m.linked_entity_type === "person") pids.add(m.linked_entity_id);
  const people = (await Promise.all([...pids].map((p) => getPersonContext(ctx, p)))).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getPersonContext>>>[];
  if (!orgId) orgId = people[0]?.currentEmployment[0]?.related[0]?.id ?? null;
  const company = orgId ? await getCompanyContext(ctx, orgId) : null;
  const reqCtxs = (await Promise.all((reqId ? [reqId] : (company?.currentRequirements ?? []).slice(0, 3).map((r) => r.id)).map((r) => getRequirementContext(ctx, r)))).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getRequirementContext>>>[];

  const allInts = new Map<string, Row>();
  for (const p of people) for (const i of p.interactions) allInts.set(i.id, i);
  for (const i of company?.interactions ?? []) allInts.set(i.id, i);
  const ints = [...allInts.values()].filter((i) => String(i.occurred_at) < String(m.start_at ?? "9999")).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
  const seen = new Set<string>();
  const dedupe = <T extends { text: string; source: { id: string } }>(xs: T[]) => xs.filter((x) => { const k = `${x.source.id}:${x.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const pending = dedupe([...people.flatMap((p) => p.commitments), ...(company?.commitments ?? [])].filter((c) => c.pending));
  const objections = dedupe([...people.flatMap((p) => p.objections), ...(company?.objections ?? [])]);
  const rejections = reqCtxs.flatMap((r) => r.rejections);
  const commercial: MeetingContext["commercialDiscussions"] = [];
  if (reqCtxs.length) {
    const qs = await q(ctx.db.from("quote").select("id, terms_json, offer, kind, created_at, space:space_id(asset:asset_id(name))").eq("workspace_id", ws).in("requirement_id", reqCtxs.map((r) => r.requirement.id)).is("archived_at", null).order("created_at", { ascending: false }).limit(10));
    for (const x of qs) { const tj = (x.terms_json ?? x.offer ?? {}) as Row; commercial.push({ asset: x.space?.asset?.name ?? null, at: x.created_at, text: `${x.kind === "landlord_offer" ? "Landlord offer" : "Quote"} ${String(x.created_at).slice(0, 10)}: rent ${tj.rent ?? "unknown"} ${tj.rent_basis ?? ""}, CAM ${tj.cam_per_sf ?? "unknown"} (historical)` }); }
  }
  const pendingQuestions = reqCtxs.flatMap((r) => r.outstandingQuestions.filter((x) => x.priority === "mandatory").slice(0, 5).map((x) => x.question));
  const developments = (company?.developments ?? []).slice(0, 5).map((s) => ({ title: s.title, at: s.event_date ?? s.created_at, verified: s.verification === "fact" }));

  // Suggested discussion points — deterministic, each traceable to a record above.
  const pts: string[] = [];
  for (const c of pending.slice(0, 3)) pts.push(`Close out your commitment: “${c.text}”${c.overdue ? " (overdue)" : ""}.`);
  for (const q2 of pendingQuestions.slice(0, 3)) pts.push(`Ask: ${q2}`);
  for (const r of reqCtxs) for (const ch of r.changes.slice(0, 2)) pts.push(`Confirm the change to ${ch.label.toLowerCase()} on “${r.requirement.title}”.`);
  for (const o of objections.slice(0, 2)) pts.push(`Address the earlier concern: “${o.text}”.`);
  if (rejections.length) pts.push(`Avoid re-proposing rejected buildings (${[...new Set(rejections.map((r) => r.assetName).filter(Boolean))].slice(0, 3).join(", ") || "see list"}).`);
  for (const p of people) if (!p.decisionRoles.some((d) => d.status === "current")) pts.push(`Find out ${p.person.name}'s role in the decision (unknown).`);
  if (!people.length) pts.push("No attendee is linked to a contact record — link attendees to see their history.");

  const last = ints[0];
  return {
    meeting: m, orgId, orgName: company?.org.display_name ?? null,
    attendees: people.map((p) => {
      const li = p.interactions.find((i) => String(i.occurred_at) < String(m.start_at ?? "9999"));
      return { personId: p.person.id, name: p.person.name, designation: p.currentEmployment[0] ? (p.currentEmployment[0].value as Row).title ?? null : null,
        company: p.currentEmployment[0]?.label ?? null, previousInteractions: p.interactions.length,
        lastDiscussion: li ? { at: li.occurred_at, subject: li.subject, summary: li.summary } : null, relationship: p.relationship.level, unknowns: p.unknowns };
    }),
    unmatchedAttendees: unmatched,
    lastDiscussion: last ? { at: last.occurred_at, subject: last.subject, summary: last.summary, sourceId: last.id } : null,
    pendingCommitments: pending, requirements: reqCtxs.map((r) => ({ id: r.requirement.id, title: r.requirement.title, summary: r.current.filter((f) => ["area", "budget", "preferred_locations", "occupation_date"].includes(f.category.split(".")[1])).map((f) => `${f.label}: ${f.display} (${f.confidenceLabel})`).join("; ") })),
    objections, commercialDiscussions: commercial, pendingQuestions, developments, suggestedPoints: pts.slice(0, 10),
  };
}

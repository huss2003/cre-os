/**
 * Module 13 §11 — small hooks other modules call (each never throws into its caller; failures return null / []):
 *  - Module 7 meetings: memory context for the meeting brief (getMeetingContext + changes + recommendations).
 *  - Module 5 outreach: repetition check using completed interactions with the person's company.
 *  - Module 2 signals: "previously known" check so known information is not treated as a new development.
 *  - Module 8 toolkit: previously rejected properties + reasons for a requirement comparison.
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { q } from "../data";
import { getMeetingContext } from "../context/meeting";
import { listChanges } from "../changes/service";
import { listRecommendations } from "../recommend/service";
import { loadRejections, recurringRejectionThemes } from "./rejections";

type Db = MemCtx["db"];
const ago = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);

/** Compact memory block stored inside the meeting brief (source-linked; unknowns stated). */
export async function meetingMemoryForBrief(db: Db, ws: string, userId: string, meetingVisitId: string) {
  try {
    const ctx: MemCtx = { db, workspaceId: ws, userId };
    const m = await getMeetingContext(ctx, meetingVisitId);
    if (!m) return null;
    const [changes, recs] = m.orgId
      ? await Promise.all([listChanges(ctx, { entityType: "organisation", entityId: m.orgId, limit: 5 }).catch(() => []), listRecommendations(ctx, { orgId: m.orgId, limit: 3 }).catch(() => [])])
      : [[], []];
    const orgHref = m.orgId ? `/companies/${m.orgId}` : null;
    const tl = m.orgId ? `/intelligence/timeline?org=${m.orgId}` : m.attendees[0] ? `/intelligence/timeline?person=${m.attendees[0].personId}` : null;
    const reqHref = m.requirements[0] ? `/requirements/${m.requirements[0].id}` : null;
    return {
      generated_at: new Date().toISOString(),
      orgId: m.orgId, orgName: m.orgName,
      attendees: m.attendees.map((a) => ({ personId: a.personId, href: `/people/${a.personId}`, name: a.name, designation: a.designation ?? "Designation unknown", company: a.company, previousInteractions: a.previousInteractions, lastDiscussion: a.lastDiscussion, relationship: a.relationship, unknowns: a.unknowns })),
      unmatchedAttendees: m.unmatchedAttendees,
      lastDiscussion: m.lastDiscussion ? { ...m.lastDiscussion, href: tl } : null,
      pendingCommitments: m.pendingCommitments.map((c) => ({ text: c.text, due: c.due, overdue: c.overdue, source: c.source })),
      requirements: m.requirements.map((r) => ({ ...r, href: `/requirements/${r.id}` })),
      objections: m.objections.map((o) => ({ text: o.text, at: o.at, source: o.source })),
      commercialDiscussions: m.commercialDiscussions.map((c) => ({ ...c, href: reqHref })),
      pendingQuestions: m.pendingQuestions.map((text) => ({ text, href: reqHref })),
      developments: m.developments.map((x) => ({ ...x, href: orgHref })),
      suggestedPoints: m.suggestedPoints.map((text) => ({ text, href: tl })),
      changes: (changes as Awaited<ReturnType<typeof listChanges>>).map((c) => ({ text: c.difference.text, at: c.changedAt, verification: c.verification, source: c.source })),
      recommendations: (recs as Awaited<ReturnType<typeof listRecommendations>>).map((r) => ({ what: r.title, next: r.nextAction, confidence: r.confidence, href: r.href })),
      note: "From recorded history only. Anything not listed is unknown.",
    };
  } catch { return null; }
}

export interface RepetitionWarning { kind: "company_recent_interaction" | "company_recent_reply"; text: string; date: string | null }

/** Module 5: a colleague at the same company was spoken to / replied recently — avoid repeating the same approach. */
export async function outreachRepetitionWarnings(db: Db, ws: string, personId: string, days = 14): Promise<RepetitionWarning[]> {
  try {
    const emp = await q<Row[]>(db.from("employment").select("org_id").eq("workspace_id", ws).eq("person_id", personId).eq("is_current", true).is("archived_at", null).limit(3));
    const orgIds = emp.map((e) => e.org_id).filter(Boolean);
    if (!orgIds.length) return [];
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const out: RepetitionWarning[] = [];
    const links = await q<Row[]>(db.from("interaction_link").select("interaction:interaction_id!inner(id, occurred_at, channel, subject)").eq("workspace_id", ws).eq("entity_type", "organisation").in("entity_id", orgIds)
      .gte("interaction.occurred_at", since).is("archived_at", null).limit(20));
    const own = new Set((await q<Row[]>(db.from("interaction_link").select("interaction_id").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).limit(200))).map((l) => l.interaction_id));
    const recent = links.map((l) => l.interaction).filter((i) => i && !own.has(i.id)).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));
    if (recent[0]) out.push({ kind: "company_recent_interaction", date: recent[0].occurred_at,
      text: `Someone at this company was contacted ${ago(recent[0].occurred_at)} day(s) ago (${recent[0].channel}${recent[0].subject ? `: ${recent[0].subject}` : ""}) — reference that conversation rather than repeating the same pitch.` });
    const replies = await q<Row[]>(db.from("outreach_item").select("id, responded_at, person_id, status").eq("workspace_id", ws).in("org_id", orgIds).neq("person_id", personId).in("status", ["replied", "meeting"]).gte("responded_at", since).limit(5)).catch(() => [] as Row[]);
    if (replies[0]) out.push({ kind: "company_recent_reply", date: replies[0].responded_at, text: `A colleague of this person replied to outreach ${ago(replies[0].responded_at)} day(s) ago — coordinate before writing again.` });
    return out;
  } catch { return []; }
}

/** Module 2: the same kind of development was already recorded for this company (different month) — not new. */
export async function knownBeforeSignal(db: Db, ws: string, s: { orgId: string | null | undefined; kind: string; dedupeKey: string }): Promise<{ id: string; title: string; detectedAt: string } | null> {
  if (!s.orgId) return null;
  try {
    const { data } = await db.from("signal").select("id, title, detected_at").eq("workspace_id", ws).eq("org_id", s.orgId).eq("kind", s.kind).neq("dedupe_key", s.dedupeKey).is("archived_at", null)
      .order("detected_at", { ascending: true }).limit(1).maybeSingle();
    return data ? { id: data.id, title: data.title, detectedAt: data.detected_at } : null;
  } catch { return null; }
}

/** Module 8: previously rejected properties (with reasons and whether the CLIENT rejected them) for a requirement. */
export async function comparisonRejections(db: Db, ws: string, userId: string, requirementId: string) {
  try {
    const rej = await loadRejections({ db, workspaceId: ws, userId }, { requirementId });
    return {
      items: rej.map((r) => ({ assetId: r.assetId, building: r.assetName, reasons: r.reasons, date: r.at ? String(r.at).slice(0, 10) : null, clientRejected: r.explicit, source: r.source })),
      recurringThemes: recurringRejectionThemes(rej).map((t) => ({ theme: t.theme, count: t.count })),
    };
  } catch { return { items: [], recurringThemes: [] }; }
}

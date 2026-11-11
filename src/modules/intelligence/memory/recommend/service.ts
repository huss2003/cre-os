/**
 * Module 13 §9 — recommendation feed for panels, the Today planner and the assistant. Combines persisted
 * recommendations (emitted when changes are detected) with live rules over current records. Read-only apart from
 * the user's own dismiss/done state on persisted rows.
 */
import "server-only";
import type { MemCtx, Row } from "../types";
import { q, today as todayIso } from "../data";
import { liveRecommendations, rankRecommendations, toPlannerRec, type Recommendation, type RuleInputs } from "./rules";
import { loadRejections, recurringRejectionThemes } from "../integrate/rejections";

const DAY = 864e5;
const daysSince = (iso: string, today: string) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(iso)) / DAY);

export interface RecFilter { orgId?: string; personId?: string; requirementId?: string; opportunityId?: string; assetId?: string; limit?: number; today?: string }

async function gather(ctx: MemCtx, f: RecFilter, today: string): Promise<RuleInputs> {
  const ws = ctx.workspaceId;
  const scoped = !!(f.orgId || f.requirementId || f.opportunityId || f.personId);
  // Requirements in scope.
  let rq = ctx.db.from("requirement").select("id, title, org_id, updated_at, status, organisation:org_id(display_name)").eq("workspace_id", ws).is("archived_at", null).not("status", "in", "(closed,cancelled,lost,won,dropped)");
  if (f.requirementId) rq = rq.eq("id", f.requirementId);
  else if (f.orgId) rq = rq.eq("org_id", f.orgId);
  const reqs = f.personId || f.opportunityId ? [] : await q<Row[]>(rq.order("updated_at").limit(scoped ? 50 : 200)).catch(() => [] as Row[]);
  let oq = ctx.db.from("opportunity").select("id, name, stage, outcome, org_id, requirement_id, updated_at").eq("workspace_id", ws).is("archived_at", null).or("outcome.is.null,outcome.eq.open").not("stage", "in", "(signed,collected)");
  if (f.opportunityId) oq = oq.eq("id", f.opportunityId); else if (f.requirementId) oq = oq.eq("requirement_id", f.requirementId); else if (f.orgId) oq = oq.eq("org_id", f.orgId);
  const opps = f.personId ? [] : await q<Row[]>(oq.limit(200));
  const oppIds = opps.map((o) => o.id);
  const lastContact = new Map<string, string>();
  if (oppIds.length) for (const i of await q<Row[]>(ctx.db.from("interaction").select("opportunity_id, occurred_at").eq("workspace_id", ws).in("opportunity_id", oppIds).order("occurred_at", { ascending: false }).limit(2000)))
    if (!lastContact.has(i.opportunity_id)) lastContact.set(i.opportunity_id, i.occurred_at);

  const staleRequirements = reqs.filter((r) => daysSince(r.updated_at, today) >= 60).map((r) => ({ id: r.id, title: r.title, orgName: r.organisation?.display_name ?? null, lastReviewed: r.updated_at, days: daysSince(r.updated_at, today) }));

  // Meetings completed 3–30 days ago with no later interaction with any attendee.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * DAY).toISOString(), to = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * DAY).toISOString();
  let mq = ctx.db.from("meeting_visit").select("id, title, start_at, status, kind, opportunity_id, linked_entity_type, linked_entity_id").eq("workspace_id", ws).is("archived_at", null).gte("start_at", from).lte("start_at", to).neq("status", "cancelled");
  if (f.opportunityId) mq = mq.eq("opportunity_id", f.opportunityId); else if (f.orgId) mq = mq.eq("linked_entity_type", "organisation").eq("linked_entity_id", f.orgId);
  const meetings = (f.requirementId || f.personId) ? [] : (await q<Row[]>(mq.limit(50))).filter((m) => m.kind !== "internal");
  const meetingsWithoutFollowup: RuleInputs["meetingsWithoutFollowup"] = [];
  if (meetings.length) {
    const preps = await q<Row[]>(ctx.db.from("meeting_prep").select("id, meeting_visit_id").eq("workspace_id", ws).in("meeting_visit_id", meetings.map((m) => m.id)));
    const att = preps.length ? await q<Row[]>(ctx.db.from("meeting_prep_attendee").select("prep_id, person_id, side").eq("workspace_id", ws).in("prep_id", preps.map((p) => p.id)).not("person_id", "is", null)) : [];
    for (const m of meetings) {
      const pIds = preps.filter((p) => p.meeting_visit_id === m.id).map((p) => p.id);
      const people = [...new Set(att.filter((a) => pIds.includes(a.prep_id) && a.side !== "internal").map((a) => a.person_id))];
      if (!people.length) continue;
      const later = await q<Row[]>(ctx.db.from("interaction_link").select("interaction:interaction_id!inner(occurred_at)").eq("workspace_id", ws).eq("entity_type", "person").in("entity_id", people).gt("interaction.occurred_at", m.start_at).limit(1));
      if (!later.length) meetingsWithoutFollowup.push({ meetingId: m.id, title: m.title ?? "Meeting", at: m.start_at, days: daysSince(m.start_at, today), personIds: people, href: pIds[0] ? `/meetings/${pIds[0]}` : "/meetings" });
    }
  }

  // Repeated rejection reasons per requirement (explicit client rejections only).
  const repeatedRejections: RuleInputs["repeatedRejections"] = [];
  for (const r of reqs.slice(0, scoped ? 20 : 30)) {
    const themes = recurringRejectionThemes(await loadRejections(ctx, { requirementId: r.id }));
    for (const t of themes) repeatedRejections.push({ requirementId: r.id, title: r.title, theme: t.theme, count: t.count, sources: t.rejections.map((x) => x.source) });
  }

  // Outdated quotations on live requirements: past validity, or older than 90 days with no validity date.
  const reqIds = reqs.map((r) => r.id);
  const quotes = reqIds.length ? await q<Row[]>(ctx.db.from("quote").select("id, requirement_id, created_at, valid_until, version, kind, superseded_by, space:space_id(asset:asset_id(name))").eq("workspace_id", ws).in("requirement_id", reqIds).is("archived_at", null).is("superseded_by", null).limit(500)) : [];
  const outdatedQuotes = quotes.filter((x) => (x.valid_until ? x.valid_until < today : daysSince(x.created_at, today) > 90))
    .map((x) => ({ id: x.id, requirementId: x.requirement_id, label: `${x.space?.asset?.name ?? "Building"} ${x.kind ?? "quote"} v${x.version ?? 1}`, createdAt: x.created_at, validUntil: x.valid_until ?? null, days: daysSince(x.created_at, today) }));

  const relationshipBeforeTransaction = opps.map((o) => { const l = lastContact.get(o.id) ?? null; return { opportunityId: o.id, name: o.name, stage: o.stage, lastContact: l, days: l ? daysSince(l, today) : null }; })
    .filter((o) => o.days === null || o.days > 21);

  // Inactive opportunities (no contact ≥ 60 days) whose company got a new signal in the last 14 days.
  const inactive = opps.filter((o) => { const l = lastContact.get(o.id) ?? o.updated_at; return daysSince(l, today) >= 60 && o.org_id; });
  const inactiveWithSignal: RuleInputs["inactiveWithSignal"] = [];
  if (inactive.length) {
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * DAY).toISOString();
    const sigs = await q<Row[]>(ctx.db.from("signal").select("id, org_id, title, detected_at, verification, status").eq("workspace_id", ws).in("org_id", [...new Set(inactive.map((o) => o.org_id))]).gte("detected_at", since).is("archived_at", null).limit(200)).catch(() => [] as Row[]);
    for (const o of inactive) { const s = sigs.filter((x) => x.org_id === o.org_id && !["rejected", "dismissed"].includes(x.status)).sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)))[0];
      if (s) inactiveWithSignal.push({ opportunityId: o.id, name: o.name, signalId: s.id, signalTitle: s.title, detectedAt: s.detected_at, verification: s.verification }); }
  }
  return { today, staleRequirements, meetingsWithoutFollowup, repeatedRejections, outdatedQuotes, relationshipBeforeTransaction, inactiveWithSignal };
}

/** Persisted (event-emitted) open recommendations in scope. */
async function persisted(ctx: MemCtx, f: RecFilter): Promise<Recommendation[]> {
  let qy = ctx.db.from("memory_recommendation").select("*").eq("workspace_id", ctx.workspaceId).eq("state", "open").is("archived_at", null);
  const ids = [f.orgId, f.personId, f.requirementId, f.opportunityId, f.assetId].filter(Boolean) as string[];
  if (f.orgId) ids.push(...(await q<Row[]>(ctx.db.from("requirement").select("id").eq("workspace_id", ctx.workspaceId).eq("org_id", f.orgId).limit(100))).map((r) => r.id));
  if (ids.length) qy = qy.in("entity_id", ids);
  return (await q<Row[]>(qy.order("created_at", { ascending: false }).limit(100))).map((r) => ({
    ref: r.dedupe_key, kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, title: r.title, why: r.why, supporting: r.supporting ?? [], sourceRefs: r.source_refs ?? [],
    confidence: r.confidence, nextAction: r.next_action, href: r.href, persistedId: r.id,
  }));
}

/** Exported for panels / assistant: recommendations for a record (or the whole workspace), ranked by confidence. */
export async function listRecommendations(ctx: MemCtx, f: RecFilter = {}): Promise<Recommendation[]> {
  const today = f.today ?? todayIso();
  const [p, live] = await Promise.all([persisted(ctx, f), gather(ctx, f, today).then(liveRecommendations)]);
  return rankRecommendations([...p, ...live]).slice(0, f.limit ?? 20);
}

/** Source hook for the Today planner's "Recommended next actions" (orchestrator Rec shape). Never throws. */
export async function plannerRecommendations(ctx: MemCtx, limit = 5) {
  try { return (await listRecommendations(ctx, { limit })).map(toPlannerRec); } catch { return []; }
}

export async function setRecommendationState(ctx: MemCtx, id: string, state: "done" | "dismissed" | "open") {
  const { error } = await ctx.db.from("memory_recommendation").update({ state, decided_at: state === "open" ? null : new Date().toISOString() }).eq("workspace_id", ctx.workspaceId).eq("id", id);
  if (error) throw new Error(error.message);
}

import "server-only";
import type { Db } from "@/lib/supabase/server";
import { proposeChange } from "@/lib/services/changes";
import { localDate } from "@/lib/util/time";
import { buildContext, pauseItem, OutreachError } from "@/modules/outreach/service";
import { plusDays } from "@/modules/outreach/rules";
import { createMeeting } from "@/modules/meetings/service";
import { draftReconnect } from "@/modules/intelligence/network/service";
import { setOptionStatus } from "@/modules/deals/matching/service";
import { loadRequirement, loadAssetProperties, loadModel } from "@/modules/toolkit/comparison";
import { rateProperties, RATING_FORMULA, type RatingProperty } from "@/modules/toolkit/calc/rating";
import { saveAnalysis } from "@/modules/toolkit/store";
import { Run, refId, type Ref, type StepResult } from "./runner";
import { workspaceOwner, scoreStep, type ChainOpts } from "./service";
import * as R from "./rules";

/**
 * Workflows round 2 — event chains (spec §14.2). Same contract as service.ts: one workflow_run per trigger (unique
 * dedupe key), one workflow_step per step with a plain reason, existing module services only, nothing sent (S3),
 * material changes through proposeChange (S4), unknown times/values stay unknown (S6). Service-role safe: every query
 * filters workspace_id (S2).
 */
type Row = Record<string, any>;
const daysAgoIso = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
const OPEN_OUTREACH = ["planned", "draft", "pending_approval", "approved"];

// ------------------------------------------------------------------ chain 3: outreach reply → meeting (§10.2 Module 5→7)

const REPLY_STEPS = [["meeting", "Meeting record"], ["followups", "Pause planned follow-ups"], ["opportunity", "Opportunity next action"], ["prep", "Meeting preparation"]] as const;

async function upcomingMeeting(db: Db, ws: string, personId: string, orgId: string | null): Promise<{ prepId: string | null; visit: Row } | null> {
  const now = new Date().toISOString();
  const { data: att } = await db.from("meeting_prep_attendee").select("prep:prep_id(id, brief, status, meeting:meeting_visit_id(id, title, start_at, status))").eq("workspace_id", ws).eq("person_id", personId).limit(50);
  const viaPrep = ((att ?? []) as Row[]).map((a) => a.prep).filter((p) => p?.meeting && p.status !== "cancelled" && p.meeting.status !== "cancelled" && p.meeting.start_at >= now)
    .sort((a, b) => a.meeting.start_at.localeCompare(b.meeting.start_at))[0];
  if (viaPrep) return { prepId: viaPrep.id, visit: { ...viaPrep.meeting, brief: viaPrep.brief } };
  const targets = [{ t: "person", id: personId }, ...(orgId ? [{ t: "organisation", id: orgId }] : [])];
  for (const x of targets) {
    const { data: mv } = await db.from("meeting_visit").select("id, title, start_at, end_at, status").eq("workspace_id", ws).eq("linked_entity_type", x.t).eq("linked_entity_id", x.id)
      .neq("status", "cancelled").gte("start_at", now).is("archived_at", null).order("start_at").limit(1).maybeSingle();
    if (mv) {
      const { data: prep } = await db.from("meeting_prep").select("id, brief").eq("workspace_id", ws).eq("meeting_visit_id", mv.id).is("archived_at", null).limit(1).maybeSingle();
      return { prepId: prep?.id ?? null, visit: { ...mv, brief: prep?.brief ?? null } };
    }
  }
  return null;
}

export async function runReplyChain(db: Db, ws: string, itemId: string, _opts: ChainOpts = {}) {
  const { data: it } = await db.from("outreach_item").select("id, person_id, org_id, opportunity_id, requirement_id, status, response, responded_at, assigned_user_id, owner_user_id, person:person_id(full_name), org:org_id(display_name)")
    .eq("workspace_id", ws).eq("id", itemId).maybeSingle();
  if (!it || !R.replyWantsMeeting(it as Row)) return null;
  const pName = (it as Row).person?.full_name as string | undefined; const oName = (it as Row).org?.display_name as string | undefined;
  const actor = it.assigned_user_id ?? it.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "reply_chain", subjectType: "outreach_item", subjectId: it.id, orgId: it.org_id, dedupeKey: R.replyDedupeKey(it.id), actor });
  if (!run) return null;
  const who = `${pName ?? "the contact"}${oName ? ` (${oName})` : ""}`;
  const replied = String(it.responded_at ?? new Date().toISOString()).slice(0, 10);
  const today = localDate();

  const found = await upcomingMeeting(db, ws, it.person_id, it.org_id);
  const a = await run.step("meeting", REPLY_STEPS[0][1], async () => {
    if (found) {
      let prepId = found.prepId;
      if (!prepId) {
        // Calendar meeting with no prep yet: attach a prep to it (the meeting's own time — nothing invented).
        const m = await createMeeting(db, ws, actor, { title: found.visit.title ?? `Meeting with ${who}`, start: found.visit.start_at, end: found.visit.end_at, meetingVisitId: found.visit.id, orgId: it.org_id, opportunityId: it.opportunity_id, requirementId: it.requirement_id, personIds: [it.person_id], purpose: "Follow-up to outreach reply", ownerUserId: actor });
        prepId = m.id;
      }
      return { status: "done", reason: `Linked to the meeting already on record for ${String(found.visit.start_at).slice(0, 16).replace("T", " ")} UTC.`, refs: [{ type: "meeting_prep", id: prepId, label: found.visit.title ?? undefined }] };
    }
    // No time agreed: a meeting record needs a start time, so we keep a "to schedule" task instead of inventing one.
    const key = `workflows:reply:${it.id}:schedule`;
    const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (ex) return { status: "done", reason: "To schedule — task already exists.", refs: [{ type: "task", id: ex.id }] };
    const { data: t, error } = await db.from("task").insert({
      workspace_id: ws, title: `Schedule meeting with ${who}`.slice(0, 200), status: "open", priority: 2,
      description: `Reply on ${replied} asked for a meeting (${String(it.response?.outcome ?? it.status).replace(/_/g, " ")}). No time agreed yet — status: to schedule. Once a time is agreed, add it in Meetings; preparation starts automatically.`,
      due_at: `${plusDays(today, 1)}T09:00:00+05:30`, assigned_user_id: actor, owner_user_id: actor, source: "workflow",
      linked_entity_type: "person", linked_entity_id: it.person_id, idempotency_key: key,
      related_entities: [{ type: "outreach_item", id: it.id }, ...(it.org_id ? [{ type: "organisation", id: it.org_id }] : []), ...(it.opportunity_id ? [{ type: "opportunity", id: it.opportunity_id }] : [])],
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { status: "done", reason: "No meeting time in the reply or calendar — marked to schedule (task created). No time was invented.", refs: [{ type: "task", id: t.id, label: "To schedule" }] };
  });

  const b = await run.step("followups", REPLY_STEPS[1][1], async () => {
    const { data: open } = await db.from("outreach_item").select("id").eq("workspace_id", ws).eq("person_id", it.person_id).in("status", OPEN_OUTREACH).neq("id", it.id).is("archived_at", null);
    for (const o of open ?? []) await pauseItem(db, ws, actor, o.id, "Meeting requested in reply — follow-up paused by workflow");
    return open?.length
      ? { status: "done", reason: `${open.length} planned/draft follow-up(s) paused (outreach pause rules: reply received, meeting requested).`, refs: open.map((o) => ({ type: "outreach_item", id: o.id })) }
      : { status: "skipped", reason: "No planned follow-ups left — outreach already paused them when the reply was recorded." };
  });

  const c = await run.step("opportunity", REPLY_STEPS[2][1], async () => {
    if (!it.opportunity_id) return { status: "skipped", reason: "No opportunity linked to this outreach." };
    const when = found ? String(found.visit.start_at).slice(0, 10) : null;
    const p = await proposeChange(db, ws, {
      targetType: "opportunity", targetId: it.opportunity_id, proposedByKind: "job", actorUserId: actor, ownerUserId: actor,
      patch: [{ op: "replace", path: "/next_action", value: when ? `Meeting with ${who} on ${when}` : `Schedule meeting with ${who}` }, { op: "replace", path: "/next_action_due", value: when ?? plusDays(today, 2) }],
      reason: `Outreach reply on ${replied} asked for a meeting.`, idempotencyKey: `workflows:reply:${it.id}:opp`,
    });
    return { status: p.state === "rejected" ? "skipped" : "done", reason: p.state === "applied" ? "Next action updated." : `Next-action change proposed (${p.state}) — review in Approvals.`, refs: [{ type: "change_proposal", id: p.id }, { type: "opportunity", id: it.opportunity_id }] };
  });

  const d = await run.step("prep", REPLY_STEPS[3][1], async () => {
    const prepId = refId(a, "meeting_prep");
    if (!prepId || !found) return { status: "skipped", reason: "No meeting time agreed yet — preparation is queued once the meeting is added." };
    if (found.visit.brief) return { status: "skipped", reason: "A brief already exists for this meeting.", refs: [{ type: "meeting_prep", id: prepId }] };
    return { status: "done", reason: "Preparation queued: the brief is generated automatically 60–75 minutes before the start (or open the meeting to generate it now).", refs: [{ type: "meeting_prep", id: prepId }] };
  });
  const failed = [a, b, c, d].some((s) => s.status === "failed");
  // Opportunity proposal waiting is informational: the run itself is complete.
  return run.finish(failed ? "failed" : "done", found ? `Meeting linked for ${who}.` : `Meeting with ${who} to schedule.`);
}

// ------------------------------------------------------------------ chain 4: employer change → re-engagement (Workflow G)

const EMP_STEPS = [["history", "Keep employment history"], ["company", "Match new employer"], ["signals", "Signals at new employer"], ["scores", "Recalculate scores"], ["draft", "Re-engagement draft"]] as const;

export async function runEmployerChain(db: Db, ws: string, employmentId: string, opts: ChainOpts = {}) {
  const { data: e } = await db.from("employment").select("id, person_id, org_id, title, is_current, archived_at, owner_user_id").eq("workspace_id", ws).eq("id", employmentId).maybeSingle();
  if (!e || !e.is_current || e.archived_at) return null;
  const { data: prior } = await db.from("employment").select("id, org_id, is_current, end_date, org:org_id(display_name)").eq("workspace_id", ws).eq("person_id", e.person_id).neq("org_id", e.org_id).is("archived_at", null).limit(20);
  if (!prior?.length) return null; // first employment, not a move
  const { data: org } = await db.from("organisation").select("id, display_name, owner_user_id, archived_at").eq("workspace_id", ws).eq("id", e.org_id).maybeSingle();
  const { data: person } = await db.from("person").select("id, full_name, do_not_contact").eq("workspace_id", ws).eq("id", e.person_id).maybeSingle();
  if (!person) return null;
  const actor = e.owner_user_id ?? org?.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "employer_chain", subjectType: "employment", subjectId: e.id, orgId: org?.id ?? null, dedupeKey: R.employerDedupeKey(e.id), actor });
  if (!run) return null;

  await run.step("history", EMP_STEPS[0][1], async () => {
    return { status: "done", reason: `Previous employment kept: ${prior.map((p) => `${(p.org as Row)?.display_name ?? "company"}${p.is_current ? " (still marked current — closing it awaits approval)" : p.end_date ? ` (ended ${p.end_date})` : " (ended)"}`).join(", ")}.`, refs: prior.map((p) => ({ type: "organisation", id: p.org_id })) };
  });
  const b = await run.step("company", EMP_STEPS[1][1], async () => {
    if (!org || org.archived_at) return { status: "skipped", reason: "New employer is not an active company in this workspace — link it via the job-move proposal (companies are never created automatically)." };
    return { status: "done", reason: `New employer ${org.display_name} matched to an existing company record (via the approved move).`, refs: [{ type: "organisation", id: org.id }] };
  });
  if (b.status !== "done") {
    for (const [k, l] of EMP_STEPS.slice(2)) await run.skip(k, l, "No company for the new employer.");
    return run.finish("skipped", b.reason);
  }
  const orgId = org!.id as string;
  await run.step("signals", EMP_STEPS[2][1], async () => {
    const { data: sig } = await db.from("signal").select("id, title").eq("workspace_id", ws).eq("org_id", orgId).not("status", "in", "(rejected,dismissed)").is("archived_at", null).order("detected_at", { ascending: false }).limit(5);
    return sig?.length
      ? { status: "done", reason: `${sig.length} open signal(s) at ${org!.display_name}: ${sig.slice(0, 2).map((s) => s.title).join("; ")}.`, refs: sig.map((s) => ({ type: "signal", id: s.id })) }
      : { status: "done", reason: `No open signals at ${org!.display_name}.` };
  });
  const c = await run.step("scores", EMP_STEPS[3][1], () => scoreStep(db, ws, orgId));
  const d = await run.step("draft", EMP_STEPS[4][1], async () => {
    if (person.do_not_contact) return { status: "skipped", reason: `${person.full_name} is marked do-not-contact.` };
    let level: string | null = null; let blocked: string | null = null; let email: string | null = null;
    try { const ctx = await buildContext(db, ws, person.id); level = ctx.level; blocked = ctx.blocked.all; email = ctx.channels.email; }
    catch (err) { if (err instanceof OutreachError) return { status: "skipped", reason: err.message }; throw err; }
    if (blocked) return { status: "skipped", reason: `Can't contact: ${blocked}.` };
    const { count } = await db.from("relationship_edge").select("id", { count: "exact", head: true }).eq("workspace_id", ws).or(`from_person_id.eq.${person.id},to_person_id.eq.${person.id}`).is("archived_at", null);
    const rel = R.priorRelationship(level, count ?? 0);
    if (!rel.prior) return { status: "skipped", reason: rel.reason };
    const since = daysAgoIso(R.OUTREACH_QUIET_DAYS);
    const [{ data: oi }, { data: dr }] = await Promise.all([
      db.from("outreach_item").select("id, created_at").eq("workspace_id", ws).eq("person_id", person.id).gte("created_at", since).limit(1).maybeSingle(),
      db.from("draft").select("id, created_at").eq("workspace_id", ws).eq("recipient_person_id", person.id).gte("created_at", since).is("archived_at", null).limit(1).maybeSingle(),
    ]);
    const recent = oi ?? dr;
    if (recent) return { status: "skipped", reason: `Outreach to ${person.full_name} already prepared on ${String(recent.created_at).slice(0, 10)} (quiet period ${R.OUTREACH_QUIET_DAYS} days).` };
    // draftReconnect uses only name, new employer and new title — nothing from the old employer's account.
    const dft = await draftReconnect(db, ws, { personId: person.id, orgId, channel: email ? "email" : "linkedin", ai: opts.ai as never, userId: actor });
    return { status: "done", reason: `${rel.reason} One congratulation/re-engagement draft prepared (new employer and title only; nothing from the previous employer) — awaiting your approval; nothing was sent.`, refs: [{ type: "draft", id: dft.id, label: person.full_name }] };
  });
  const failed = [c, d].some((s) => s.status === "failed");
  return run.finish(failed ? "failed" : "done", `${person.full_name} → ${org!.display_name}${d.status === "done" ? ": draft ready" : `: no draft (${d.reason})`}`);
}

// ------------------------------------------------------------------ chain 5: visit feedback → comparison (Workflow E)

const FB_STEPS = [["option", "Link feedback to shortlist option"], ["comparison", "Update saved comparison"], ["task", "Review task"]] as const;

export async function runFeedbackChain(db: Db, ws: string, feedbackId: string, _opts: ChainOpts = {}) {
  const { data: fb } = await db.from("meeting_property_feedback").select("id, prep_id, asset_id, fields, row_version, archived_at, owner_user_id, asset:asset_id(name), prep:prep_id(id, requirement_id, org_id, owner_user_id)")
    .eq("workspace_id", ws).eq("id", feedbackId).maybeSingle();
  if (!fb || fb.archived_at) return null;
  const prep = (fb as Row).prep as Row | null; const assetName = (fb as Row).asset?.name as string | undefined;
  const reqId: string | null = prep?.requirement_id ?? null;
  const actor = fb.owner_user_id ?? prep?.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "feedback_chain", subjectType: "meeting_property_feedback", subjectId: fb.id, orgId: prep?.org_id ?? null, dedupeKey: R.feedbackDedupeKey(fb.id, fb.row_version), actor });
  if (!run) return null;
  const f = (fb.fields ?? {}) as Row;
  const building = assetName ?? "building";
  if (!reqId) {
    for (const [k, l] of FB_STEPS) await run.skip(k, l, "Meeting is not linked to a requirement.");
    return run.finish("skipped", "Meeting is not linked to a requirement.");
  }
  const ctx = { db, workspaceId: ws, userId: actor };

  const a = await run.step("option", FB_STEPS[0][1], async () => {
    const { data: opt } = await db.from("shortlist_option").select("id, option_status, version, fit_score").eq("workspace_id", ws).eq("requirement_id", reqId).eq("asset_id", fb.asset_id).is("archived_at", null).order("version", { ascending: false }).limit(1).maybeSingle();
    if (!opt) return { status: "skipped", reason: `${building} is not on this requirement's shortlist — feedback kept on the meeting only.` };
    const next = R.optionStatusFromFeedback(f, opt.option_status);
    if (next.status) await setOptionStatus(ctx, opt.id, next.status as "visited" | "rejected");
    const note = R.feedbackNote(f);
    const score = f.overall != null ? `overall ${f.overall}/5` : "no overall score";
    const why = next.rejected
      ? `Client explicitly rejected ${building}${note ? ` — reason: ${note}` : ""}. Option marked rejected.`
      : `${building}: ${score}, interest ${f.interest ?? "unknown"}${note ? ` (${note})` : ""}. ${next.status ? `Option marked ${next.status}.` : `Option stays ${opt.option_status}.`} Negative comments are feedback, not a rejection.`;
    return { status: "done", reason: why, refs: [{ type: "shortlist_option", id: opt.id, label: next.status ?? opt.option_status }, { type: "requirement", id: reqId }] };
  });

  const b = await run.step("comparison", FB_STEPS[1][1], async () => {
    const { data: an } = await db.from("deal_analysis").select("id, title, asset_ids, inputs, org_id").eq("workspace_id", ws).eq("kind", "property_comparison").eq("requirement_id", reqId).is("archived_at", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!an) return { status: "skipped", reason: "No saved property comparison for this requirement." };
    // All visit feedback for this requirement, latest per building.
    const { data: preps } = await db.from("meeting_prep").select("id").eq("workspace_id", ws).eq("requirement_id", reqId).is("archived_at", null).limit(200);
    const { data: fbs } = await db.from("meeting_property_feedback").select("asset_id, fields, updated_at").eq("workspace_id", ws).in("prep_id", (preps ?? []).map((p) => p.id)).is("archived_at", null).order("updated_at", { ascending: true });
    const byAsset = new Map<string, Row>(); for (const x of fbs ?? []) byAsset.set(x.asset_id, x.fields ?? {});
    const prevAssets = (an.asset_ids ?? []) as string[];
    const rejected = prevAssets.filter((id) => { const x = byAsset.get(id); return x?.interest === "rejected" && x?.explicit_rejection === true; });
    const assetIds = prevAssets.filter((id) => !rejected.includes(id));
    const inputs = (an.inputs ?? {}) as Row;
    const req = await loadRequirement(db, ws, reqId);
    if (inputs.requirement?.termMonths) req.termMonths = inputs.requirement.termMonths;
    const { props, quoteRefs } = await loadAssetProperties(db, ws, assetIds, req.areaBasis ?? null);
    const scored = props.map((p): RatingProperty => {
      const s = R.feedbackScore(byAsset.get(p.key)?.overall);
      return s === undefined ? p : { ...p, customScores: { ...(p.customScores ?? {}), [R.FEEDBACK_FACTOR]: s } };
    });
    const manual = ((inputs.properties ?? []) as RatingProperty[]).filter((p) => p.source === "manual");
    const properties = [...scored, ...manual];
    if (!properties.length) return { status: "skipped", reason: "Every building in the comparison was explicitly rejected — nothing left to compare." };
    const model = await loadModel(db, ws, inputs.modelId ?? null);
    const asOf = localDate();
    const outputs = rateProperties(model, req, properties, { asOf });
    const hasFactor = model.factors.some((x) => x.key === R.FEEDBACK_FACTOR);
    const fbCount = scored.filter((p) => p.customScores?.[R.FEEDBACK_FACTOR] !== undefined).length;
    const note = `Updated by the visit-feedback workflow. ${rejected.length ? `Removed after explicit client rejection: ${rejected.length} building(s). ` : ""}${fbCount} building(s) carry a visit score (factor "${R.FEEDBACK_FACTOR}"${hasFactor ? "" : " — not in the rating model, so it does not change the score; add it to the model to weigh feedback"}). Other comments are feedback only.`;
    const saved = await saveAnalysis(db, ws, actor, {
      id: an.id, kind: "property_comparison", title: an.title, orgId: an.org_id ?? null, requirementId: reqId, assetIds, quoteRefs,
      inputs: { requirement: req, properties, model, modelId: model.id, asOf, visit_feedback: Object.fromEntries([...byAsset].filter(([k]) => prevAssets.includes(k))), removed_rejected: rejected },
      outputs, formulaVersion: RATING_FORMULA, missing: outputs.recommendation.key ? [] : ["No eligible property to recommend"], note,
    });
    return { status: "done", reason: `Comparison re-run as version ${saved.version}. ${note}`, refs: [{ type: "property_comparison", id: saved.id, label: `v${saved.version}` }] };
  });

  const c = await run.step("task", FB_STEPS[2][1], async () => {
    const anId = refId(b, "property_comparison");
    if (!anId) return { status: "skipped", reason: "No comparison was updated." };
    const ver = b.refs?.find((r) => r.type === "property_comparison")?.label ?? "";
    const key = `workflows:feedback:${anId}:${ver}`;
    const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (ex) return { status: "done", reason: "Task already exists.", refs: [{ type: "task", id: ex.id }] };
    const { data: t, error } = await db.from("task").insert({
      workspace_id: ws, title: "Review updated comparison", status: "open", priority: 2,
      description: `Site-visit feedback on ${building} changed the saved property comparison (${ver}). Check the ranking before sharing it with the client.`,
      due_at: `${plusDays(localDate(), 1)}T09:00:00+05:30`, assigned_user_id: actor, owner_user_id: actor, source: "workflow",
      linked_entity_type: "requirement", linked_entity_id: reqId, related_entities: [{ type: "deal_analysis", id: anId }, { type: "meeting_property_feedback", id: fb.id }], idempotency_key: key,
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { status: "done", reason: "Task 'Review updated comparison' created.", refs: [{ type: "task", id: t.id }] };
  });
  const failed = [a, b, c].some((s) => s.status === "failed");
  return run.finish(failed ? "failed" : "done", `${building}: ${a.status === "done" ? "option updated" : "not on shortlist"}, ${b.status === "done" ? "comparison updated" : "no comparison"}.`);
}

// ------------------------------------------------------------------ chain 6: meeting completed → rescore + follow-ups

const MTG_STEPS = [["scores", "Recalculate scores"], ["followups", "Follow-ups from the outcome"]] as const;

/**
 * meetings.applyOutcome already creates commitment tasks and (if chosen) a meeting_followup draft, but does not rescore:
 * its interaction_link insert enqueues scoring.recalc without an org, which scores nothing. This chain rescores the
 * company and reports the follow-ups applyOutcome made (it creates none of its own).
 */
export async function runMeetingChain(db: Db, ws: string, prepId: string, _opts: ChainOpts = {}) {
  const { data: p } = await db.from("meeting_prep").select("id, org_id, status, outcome, owner_user_id").eq("workspace_id", ws).eq("id", prepId).maybeSingle();
  const applied = p?.outcome?.applied as Row | undefined;
  if (!p || p.status !== "completed" || !applied) return null;
  const actor = applied.by ?? p.owner_user_id ?? (await workspaceOwner(db, ws));
  if (!actor) return null;
  const run = await Run.start(db, ws, { kind: "meeting_chain", subjectType: "meeting_prep", subjectId: p.id, orgId: p.org_id, dedupeKey: R.meetingDedupeKey(p.id), actor });
  if (!run) return null;
  const a = await run.step("scores", MTG_STEPS[0][1], () => p.org_id ? scoreStep(db, ws, p.org_id) : Promise.resolve({ status: "skipped" as const, reason: "Meeting is not linked to a company." }));
  const b = await run.step("followups", MTG_STEPS[1][1], async () => {
    const { data: tasks } = await db.from("task").select("id").eq("workspace_id", ws).like("idempotency_key", `meeting:${p.id}:%`).limit(50);
    const refs: Ref[] = [...(tasks ?? []).map((t) => ({ type: "task", id: t.id })), ...(applied.draft ? [{ type: "outreach_item", id: applied.draft as string, label: "Follow-up" }] : [])];
    const parts = [`${tasks?.length ?? 0} task(s) from our commitments`, applied.draft ? "follow-up draft awaiting approval" : "no follow-up draft (not selected when the outcome was applied)", `${applied.proposals ?? 0} change proposal(s) in Approvals`];
    return { status: "done", reason: `${parts.join("; ")}. Nothing was sent.`, refs };
  });
  return run.finish([a, b].some((s) => s.status === "failed") ? "failed" : "done", "Meeting outcome: rescored and follow-ups checked.");
}

// ------------------------------------------------------------------ sweep for the event chains

export async function sweepEvents(db: Db, ws: string, s: R.WorkflowSettings, opts: ChainOpts & { limit?: number; lookbackDays?: number } = {}) {
  const limit = opts.limit ?? 25; const since = daysAgoIso(opts.lookbackDays ?? 14);
  const out = { replies: 0, employers: 0, feedback: 0, meetings: 0 };
  const fresh = async (keyed: { id: string; key: string }[]) => {
    if (!keyed.length) return [];
    const { data } = await db.from("workflow_run").select("dedupe_key").eq("workspace_id", ws).in("dedupe_key", keyed.map((k) => k.key));
    const seen = new Set((data ?? []).map((r) => r.dedupe_key as string));
    return keyed.filter((k) => !seen.has(k.key)).slice(0, limit);
  };
  if (s.reply_chain) {
    const { data } = await db.from("outreach_item").select("id, status, response").eq("workspace_id", ws).gte("responded_at", since).in("status", ["meeting", "replied"]).is("archived_at", null).limit(300);
    for (const k of await fresh((data ?? []).filter((i) => R.replyWantsMeeting(i)).map((i) => ({ id: i.id, key: R.replyDedupeKey(i.id) })))) if (await runReplyChain(db, ws, k.id, opts)) out.replies++;
  }
  if (s.employer_chain) {
    const { data } = await db.from("employment").select("id").eq("workspace_id", ws).eq("is_current", true).gte("created_at", since).is("archived_at", null).limit(300);
    for (const k of await fresh((data ?? []).map((e) => ({ id: e.id, key: R.employerDedupeKey(e.id) })))) if (await runEmployerChain(db, ws, k.id, opts)) out.employers++;
  }
  if (s.feedback_chain) {
    const { data } = await db.from("meeting_property_feedback").select("id, row_version").eq("workspace_id", ws).gte("updated_at", since).is("archived_at", null).limit(300);
    for (const k of await fresh((data ?? []).map((f) => ({ id: f.id, key: R.feedbackDedupeKey(f.id, f.row_version) })))) if (await runFeedbackChain(db, ws, k.id, opts)) out.feedback++;
  }
  if (s.meeting_chain) {
    const { data } = await db.from("meeting_prep").select("id").eq("workspace_id", ws).eq("status", "completed").gte("updated_at", since).not("outcome->applied", "is", null).limit(300);
    for (const k of await fresh((data ?? []).map((m) => ({ id: m.id, key: R.meetingDedupeKey(m.id) })))) if (await runMeetingChain(db, ws, k.id, opts)) out.meetings++;
  }
  return out;
}

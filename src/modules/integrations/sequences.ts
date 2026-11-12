import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import { assertNotSuppressed, createDraft, discardDraft, setDraftPaused, SuppressedRecipientError, type DraftChannel, type DraftRow } from "@/lib/services/drafts";
import { checkCollision, collisionsDirect, currentOrgForPerson, recordTouch, touchChannelForDraft, type CollisionReport } from "./touches";

/**
 * Outreach sequences (spec §8 Workflow contracts -> Outreach): proposed 3-touch / 21-day default, channel caps,
 * pause on reply / opt-out / wrong contact / active negotiation / new contrary info. Every step is a DRAFT that the
 * user approves and sends manually. No bulk personal WhatsApp/LinkedIn automation: one draft per person per step.
 */
export type PauseReason = "reply" | "opt_out" | "wrong_contact" | "active_negotiation" | "contrary_info" | "suppressed" | "collision" | "manual";

export interface SequenceStep { step: number; day_offset: number; channel: DraftChannel; purpose: string }
export interface ChannelCap { max: number; per_days: number }
export interface SequenceCaps { email?: ChannelCap; linkedin?: ChannelCap; whatsapp?: ChannelCap; account_per_week?: number }

export const DEFAULT_SEQUENCE_NAME = "Default 3-touch / 21-day";
export const DEFAULT_STEPS: SequenceStep[] = [
  { step: 1, day_offset: 0, channel: "email", purpose: "Introduce one relevant, evidence-based proposition with a clear ask" },
  { step: 2, day_offset: 9, channel: "linkedin", purpose: "Short personal follow-up referencing the first note" },
  { step: 3, day_offset: 21, channel: "email", purpose: "Final useful note (market data point) and an easy yes/no ask" },
];
export const DEFAULT_CAPS: SequenceCaps = {
  email: { max: 3, per_days: 21 },
  linkedin: { max: 2, per_days: 21 },
  whatsapp: { max: 1, per_days: 14 },
  account_per_week: 2,
};
export const NEGOTIATION_STAGES = ["proposal_negotiation", "loi", "documentation", "signed", "possession"];

/** Sequence templates the user can choose when enrolling. WhatsApp is a manual channel: one draft, opened via wa.me. */
export const WHATSAPP_SEQUENCE_NAME = "3-touch / 21-day with WhatsApp follow-up";
export const SEQUENCE_TEMPLATES: Record<string, { name: string; steps: SequenceStep[] }> = {
  default: { name: DEFAULT_SEQUENCE_NAME, steps: DEFAULT_STEPS },
  whatsapp: {
    name: WHATSAPP_SEQUENCE_NAME,
    steps: [
      DEFAULT_STEPS[0],
      { step: 2, day_offset: 9, channel: "whatsapp", purpose: "Short personal WhatsApp follow-up (only where the contact shared this number for work)" },
      DEFAULT_STEPS[2],
    ],
  },
};

/** Signals that contradict the outreach premise for a person / organisation (recorded after enrolment). */
export const CONTRARY_CLAIM_TYPES = ["job_move", "contrary_info", "not_in_market", "lease_renewed", "relocation_completed", "deal_signed_elsewhere"];
const CONTRARY_PREDICATE = /(already (moved|relocated|signed|renewed)|not in (the )?market|no requirement|renewed (the )?lease|signed elsewhere|hiring freeze|on hold|left the (company|organisation|organization))/i;

export function sequenceKey(enrollmentId: string) {
  return `enr:${enrollmentId}`;
}

/** Pure: is another touch on `channel` allowed given previous sent times? */
export function withinChannelCap(sentAt: string[], cap: ChannelCap | undefined, now: Date): boolean {
  if (!cap) return true;
  const since = now.getTime() - cap.per_days * 86_400_000;
  return sentAt.filter((t) => Date.parse(t) >= since).length < cap.max;
}

/** Pure: next due time after `step` was sent at `sentAt`. Null when the sequence is finished. */
export function nextDueAfter(steps: SequenceStep[], step: number, sentAt: Date): { step: SequenceStep; dueAt: Date } | null {
  const cur = steps.find((s) => s.step === step);
  const next = steps.filter((s) => s.step > step).sort((a, b) => a.step - b.step)[0];
  if (!next) return null;
  const gap = next.day_offset - (cur?.day_offset ?? 0);
  return { step: next, dueAt: new Date(sentAt.getTime() + Math.max(1, gap) * 86_400_000) };
}

export async function ensureDefaultSequence(db: Db, workspaceId: string, ownerUserId: string | null) {
  return ensureSequenceTemplate(db, workspaceId, "default", ownerUserId);
}

export async function ensureSequenceTemplate(db: Db, workspaceId: string, template: keyof typeof SEQUENCE_TEMPLATES | string, ownerUserId: string | null) {
  const t = SEQUENCE_TEMPLATES[template] ?? SEQUENCE_TEMPLATES.default;
  const { data: existing } = await db.from("outreach_sequence").select("*").eq("workspace_id", workspaceId).eq("name", t.name).eq("status", "active").limit(1);
  if (existing?.[0]) return existing[0];
  const { data, error } = await db.from("outreach_sequence").insert({
    workspace_id: workspaceId, name: t.name, steps: t.steps, caps: DEFAULT_CAPS, owner_user_id: ownerUserId,
  }).select().single();
  if (error) throw error;
  return data;
}

// ------------------------------------------------------------------ persona drafts (gateway; deterministic mock)
const DraftSchema = z.object({ subject: z.string().nullable(), body: z.string().min(1).max(4000) });

const PERSONA_ANGLE: Record<string, string> = {
  cfo: "all-in occupancy cost and cash flow (rent, CAM, fit-out capex and lock-in exposure)",
  finance: "all-in occupancy cost and cash flow (rent, CAM, fit-out capex and lock-in exposure)",
  admin: "day-to-day operations: power back-up, parking, fit-out timelines and landlord responsiveness",
  facilities: "day-to-day operations: power back-up, parking, fit-out timelines and landlord responsiveness",
  hr: "employee commute catchments and hiring-friendly locations",
  real_estate: "portfolio timing: lease events, notice windows and consolidation options",
};

export function mockOutreachDraft(p: { channel: DraftChannel; step: number; persona: string | null; firstName: string; orgName: string | null; proposition: string | null; purpose: string }) {
  const angle = PERSONA_ANGLE[(p.persona ?? "").toLowerCase()] ?? "office options that fit your current plans in Pune";
  const prop = p.proposition?.trim() || `a short, sourced view of ${angle}`;
  const org = p.orgName ? ` for ${p.orgName}` : "";
  if (p.channel === "linkedin" || p.channel === "whatsapp") {
    return { subject: null, body: `Hi ${p.firstName}, following up on my note${org}. Happy to share ${prop} — would a 15-minute call next week be useful?` };
  }
  if (p.step >= 3) {
    return {
      subject: `One last note${org}`,
      body: `Hi ${p.firstName},\n\nI won't keep following up. If useful, I can send ${prop}.\nA simple yes/no is perfectly fine.\n\nBest regards`,
    };
  }
  if (p.step === 2) {
    return {
      subject: `Following up${org}`,
      body: `Hi ${p.firstName},\n\nA quick follow-up on my earlier note. For teams like yours the useful starting point is usually ${angle}. I can send ${prop}.\n\nWould that be helpful, or is there a better person to speak to?\n\nBest regards`,
    };
  }
  return {
    subject: `Pune office planning${org}`,
    body: `Hi ${p.firstName},\n\nI advise occupiers on office space in Pune. I can share ${prop}.\n\nWould a 15-minute call next week be useful?\n\nBest regards`,
  };
}

async function recipientFor(db: Db, workspaceId: string, personId: string, channel: DraftChannel): Promise<string | null> {
  const types = channel === "email" || channel === "introduction" || channel === "calendar_invite" ? ["email"]
    : channel === "whatsapp" ? ["whatsapp", "phone"] : channel === "linkedin" ? ["linkedin"] : [];
  if (!types.length) return null;
  const { data } = await db.from("contact_method").select("value, method_type, preferred, verified_on").eq("workspace_id", workspaceId)
    .eq("person_id", personId).in("method_type", types).eq("suppressed", false);
  const ranked = (data ?? []).sort((a, b) => Number(!!b.verified_on) - Number(!!a.verified_on) || Number(b.preferred) - Number(a.preferred));
  if (ranked[0]) return ranked[0].value;
  if (channel === "linkedin") {
    const { data: p } = await db.from("person").select("public_profile_url").eq("workspace_id", workspaceId).eq("id", personId).maybeSingle();
    return p?.public_profile_url ?? null;
  }
  return null;
}

export async function generateStepDraft(db: Db, workspaceId: string, args: {
  enrollment: { id: string; person_id: string; org_id: string | null; opportunity_id: string | null; value_proposition: string | null };
  step: SequenceStep; persona: string | null; ownerUserId: string | null; createdByKind: "user" | "job"; mode?: AiMode;
}): Promise<DraftRow> {
  const { enrollment, step } = args;
  const { data: person } = await db.from("person").select("full_name").eq("workspace_id", workspaceId).eq("id", enrollment.person_id).single();
  const org = enrollment.org_id ? (await db.from("organisation").select("display_name").eq("workspace_id", workspaceId).eq("id", enrollment.org_id).maybeSingle()).data : null;
  const firstName = String(person?.full_name ?? "there").split(/\s+/)[0];
  const mockArgs = { channel: step.channel, step: step.step, persona: args.persona, firstName, orgName: org?.display_name ?? null, proposition: enrollment.value_proposition, purpose: step.purpose };
  const code = () => mockOutreachDraft(mockArgs);
  const pol = await runWithPolicy<{ subject: string | null; body: string }>({ mode: args.mode ?? await getAiMode(db, workspaceId, "integrations.outreach_draft"), code, ai: async () => (await callStructured({
    workspaceId, workflow: "integrations.outreach_draft", tier: "luna",
    system: "You draft short, individual, persona-specific B2B outreach for a commercial real estate adviser in Pune. " +
      "One useful proposition, one clear ask. No invented facts, numbers, names or claims. Plain text. The user sends manually.",
    input: JSON.stringify({ channel: step.channel, step: step.step, of_steps: 3, purpose: step.purpose, persona: args.persona, recipient_first_name: firstName,
      organisation: org?.display_name ?? null, approved_proposition: enrollment.value_proposition }),
    schema: DraftSchema, schemaName: "outreach_draft", maxOutputTokens: 600,
    mock: code,
  })).data });
  const res = { data: pol.value ?? code() };
  const draft = await createDraft(db, workspaceId, {
    channel: step.channel, recipientPersonId: enrollment.person_id, recipientDisplay: person?.full_name ?? null,
    recipientAddress: await recipientFor(db, workspaceId, enrollment.person_id, step.channel),
    subject: step.channel === "email" ? res.data.subject : null, body: res.data.body,
    orgId: enrollment.org_id, opportunityId: enrollment.opportunity_id, purpose: `sequence step ${step.step}: ${step.purpose}`,
    sequenceKey: sequenceKey(enrollment.id), sequenceStep: step.step, createdByKind: args.createdByKind, ownerUserId: args.ownerUserId,
  });
  await recordTouch(db, workspaceId, {
    orgId: enrollment.org_id, personId: enrollment.person_id, userId: args.ownerUserId, channel: touchChannelForDraft(step.channel), kind: "drafted",
    draftId: draft.id, enrollmentId: enrollment.id, dedupeKey: `draft:${draft.id}:drafted`,
  });
  return draft;
}

// ------------------------------------------------------------------ enrollment lifecycle
export class CollisionError extends Error {
  constructor(public report: CollisionReport) {
    super("Another colleague is already approaching this account/person, or the account touch cap is reached");
  }
}

export async function proposeEnrollment(db: Db, workspaceId: string, p: {
  personId: string; orgId?: string | null; opportunityId?: string | null; persona?: string | null; valueProposition?: string | null;
  sequenceId?: string; template?: string; userId: string; overrideCollision?: boolean;
}) {
  await assertNotSuppressed(db, workspaceId, p.personId, "email");
  const orgId = p.orgId ?? (await currentOrgForPerson(db, workspaceId, p.personId));
  const report = await checkCollision(db, workspaceId, { orgId, personId: p.personId, userId: p.userId });
  if ((report.collisions.length > 0 || report.saturated) && !p.overrideCollision) throw new CollisionError(report);
  const seq = p.sequenceId
    ? (await db.from("outreach_sequence").select("*").eq("workspace_id", workspaceId).eq("id", p.sequenceId).single()).data
    : await ensureSequenceTemplate(db, workspaceId, p.template ?? "default", p.userId);
  if (!seq) throw new Error("sequence not found");
  const { data: enr, error } = await db.from("sequence_enrollment").insert({
    workspace_id: workspaceId, sequence_id: seq.id, person_id: p.personId, org_id: orgId, opportunity_id: p.opportunityId ?? null,
    status: "proposed", value_proposition: p.valueProposition ?? null, owner_user_id: p.userId,
  }).select().single();
  if (error) {
    if (error.code === "23505") {
      const { data: existing } = await db.from("sequence_enrollment").select("*").eq("workspace_id", workspaceId).eq("sequence_id", seq.id)
        .eq("person_id", p.personId).in("status", ["proposed", "active", "paused"]).single();
      return { enrollment: existing, draft: null, report, existing: true };
    }
    throw error;
  }
  const steps = (seq.steps as SequenceStep[]).sort((a, b) => a.step - b.step);
  const draft = await generateStepDraft(db, workspaceId, { enrollment: enr, step: steps[0], persona: p.persona ?? seq.persona ?? null, ownerUserId: p.userId, createdByKind: "user" });
  await recordTouch(db, workspaceId, { orgId, personId: p.personId, userId: p.userId, channel: steps[0].channel === "email" ? "email" : touchChannelForDraft(steps[0].channel), kind: "planned", enrollmentId: enr.id, dedupeKey: `enr:${enr.id}:planned` });
  return { enrollment: enr, draft, report, existing: false };
}

export class ActiveNegotiationError extends Error {
  constructor(public opportunity: { id: string; name: string; stage: string }) {
    super(`"${opportunity.name}" is in ${opportunity.stage.replace(/_/g, " ")} — outreach stays paused during active negotiation`);
  }
}

/**
 * Active negotiation for an enrollment: its own opportunity, else any open opportunity of the person's organisation, else
 * any open opportunity where the person is a stakeholder — at proposal_negotiation or later.
 */
export async function negotiationFor(db: Db, workspaceId: string, enr: { person_id: string; org_id: string | null; opportunity_id: string | null }) {
  const sel = "id, name, stage";
  if (enr.opportunity_id) {
    const { data } = await db.from("opportunity").select(sel).eq("workspace_id", workspaceId).eq("id", enr.opportunity_id).eq("outcome", "open").in("stage", NEGOTIATION_STAGES).maybeSingle();
    if (data) return data as { id: string; name: string; stage: string };
  }
  if (enr.org_id) {
    const { data } = await db.from("opportunity").select(sel).eq("workspace_id", workspaceId).eq("org_id", enr.org_id).eq("outcome", "open").in("stage", NEGOTIATION_STAGES).is("archived_at", null).limit(1);
    if (data?.[0]) return data[0] as { id: string; name: string; stage: string };
  }
  const { data: st } = await db.from("stakeholder").select("requirement_id").eq("workspace_id", workspaceId).eq("person_id", enr.person_id).is("archived_at", null);
  const reqs = (st ?? []).map((s) => s.requirement_id as string).filter(Boolean);
  if (reqs.length) {
    const { data } = await db.from("opportunity").select(sel).eq("workspace_id", workspaceId).in("requirement_id", reqs).eq("outcome", "open").in("stage", NEGOTIATION_STAGES).is("archived_at", null).limit(1);
    if (data?.[0]) return data[0] as { id: string; name: string; stage: string };
  }
  return null;
}

/** A contradicting signal recorded for the person or organisation after `since` (enrolment time). */
export async function contrarySignalFor(db: Db, workspaceId: string, enr: { person_id: string; org_id: string | null }, since: string) {
  const subjects = [`and(subject_type.eq.person,subject_id.eq.${enr.person_id})`, ...(enr.org_id ? [`and(subject_type.eq.organisation,subject_id.eq.${enr.org_id})`] : [])];
  const { data } = await db.from("signal_claim").select("id, subject_type, claim_type, predicate, evidence_excerpt, created_at").eq("workspace_id", workspaceId)
    .or(subjects.join(",")).gte("created_at", since).is("archived_at", null).order("created_at", { ascending: false }).limit(50);
  const hit = (data ?? []).find((c) => CONTRARY_CLAIM_TYPES.includes(c.claim_type) || CONTRARY_PREDICATE.test(`${c.predicate ?? ""} ${c.evidence_excerpt ?? ""}`));
  return hit ? { id: hit.id as string, detail: `Signal on ${hit.subject_type}: ${String(hit.claim_type).replace(/_/g, " ")}${hit.predicate ? ` — ${hit.predicate}` : ""}${hit.evidence_excerpt ? ` (“${String(hit.evidence_excerpt).slice(0, 160)}”)` : ""}` } : null;
}

/**
 * Exported for other modules (documented in README): a contradicting fact was recorded for a person or organisation.
 * Pauses their live enrollments with reason contrary_info and records the detail.
 */
export async function onContrarySignal(db: Db, workspaceId: string, s: { subjectType: "person" | "organisation"; subjectId: string; detail: string }) {
  return s.subjectType === "person"
    ? pauseForPerson(db, workspaceId, s.subjectId, "contrary_info", undefined, s.detail)
    : pauseForOrg(db, workspaceId, s.subjectId, "contrary_info", s.detail);
}

export async function activateEnrollment(db: Db, workspaceId: string, id: string) {
  const { data: cur } = await db.from("sequence_enrollment").select("person_id, org_id, opportunity_id").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (cur) {
    const neg = await negotiationFor(db, workspaceId, cur);
    if (neg) {
      await pauseEnrollment(db, workspaceId, id, "active_negotiation", null, `Opportunity “${neg.name}” is at ${neg.stage.replace(/_/g, " ")}`);
      throw new ActiveNegotiationError(neg);
    }
  }
  const { data, error } = await db.from("sequence_enrollment").update({ status: "active", activated_at: new Date().toISOString(), pause_reason: null, paused_at: null, pause_detail: null })
    .eq("workspace_id", workspaceId).eq("id", id).in("status", ["proposed", "paused"]).select().maybeSingle();
  if (error) throw error;
  if (data) {
    const { data: drafts } = await db.from("draft").select("id").eq("workspace_id", workspaceId).eq("sequence_key", sequenceKey(id)).eq("state", "paused");
    for (const d of drafts ?? []) await setDraftPaused(db, workspaceId, d.id, false, null);
  }
  return data;
}

/** Pause an enrollment and park its unsent drafts (they cannot be opened to send while paused). */
export async function pauseEnrollment(db: Db, workspaceId: string, id: string, reason: PauseReason, actorUserId?: string | null, detail?: string | null) {
  const { data, error } = await db.from("sequence_enrollment").update({ status: "paused", pause_reason: reason, paused_at: new Date().toISOString(), pause_detail: detail ? detail.slice(0, 500) : null })
    .eq("workspace_id", workspaceId).eq("id", id).in("status", ["proposed", "active"]).select().maybeSingle();
  if (error) throw error;
  const { data: drafts } = await db.from("draft").select("id").eq("workspace_id", workspaceId).eq("sequence_key", sequenceKey(id))
    .in("state", ["drafted", "approved", "opened_for_send"]);
  for (const d of drafts ?? []) await setDraftPaused(db, workspaceId, d.id, true, reason, actorUserId);
  return data;
}

export async function cancelEnrollment(db: Db, workspaceId: string, id: string, reason: PauseReason, actorUserId?: string | null) {
  await pauseEnrollment(db, workspaceId, id, reason, actorUserId);
  await db.from("sequence_enrollment").update({ status: "cancelled", pause_reason: reason }).eq("workspace_id", workspaceId).eq("id", id);
  const { data: drafts } = await db.from("draft").select("id").eq("workspace_id", workspaceId).eq("sequence_key", sequenceKey(id)).eq("state", "paused");
  for (const d of drafts ?? []) await discardDraft(db, workspaceId, d.id, actorUserId ?? null, `sequence cancelled (${reason})`);
}

/**
 * Pause all live enrollments for a person (reply / opt-out / wrong contact / contrary info).
 * `occurredAt`: only enrollments that started before the triggering message are paused — old backfilled mail
 * neither pauses nor re-triggers anything newer.
 */
export async function pauseForPerson(db: Db, workspaceId: string, personId: string, reason: PauseReason, occurredAt?: string, detail?: string | null) {
  let q = db.from("sequence_enrollment").select("id, enrolled_at").eq("workspace_id", workspaceId).eq("person_id", personId).in("status", ["proposed", "active"]);
  if (occurredAt) q = q.lte("enrolled_at", occurredAt);
  const { data } = await q;
  for (const e of data ?? []) await pauseEnrollment(db, workspaceId, e.id, reason, null, detail);
  return (data ?? []).map((e) => e.id);
}

/** Pause all live enrollments targeting an organisation (contrary information about the account). */
export async function pauseForOrg(db: Db, workspaceId: string, orgId: string, reason: PauseReason, detail: string | null, occurredAt?: string) {
  let q = db.from("sequence_enrollment").select("id").eq("workspace_id", workspaceId).eq("org_id", orgId).in("status", ["proposed", "active"]);
  if (occurredAt) q = q.lte("enrolled_at", occurredAt);
  const { data } = await q;
  for (const e of data ?? []) await pauseEnrollment(db, workspaceId, e.id, reason, null, detail);
  return (data ?? []).map((e) => e.id as string);
}

/** Called after a sequence draft is marked/reconciled sent: advance step and schedule the next touch. */
export async function onSequenceDraftSent(db: Db, workspaceId: string, draft: Pick<DraftRow, "sequence_key" | "sequence_step">, sentAt = new Date()) {
  if (!draft.sequence_key?.startsWith("enr:") || !draft.sequence_step) return null;
  const id = draft.sequence_key.slice(4);
  const { data: enr } = await db.from("sequence_enrollment").select("*, outreach_sequence(steps)").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
  if (!enr || enr.current_step >= draft.sequence_step) return enr;
  const steps = ((enr.outreach_sequence as { steps: SequenceStep[] } | null)?.steps ?? DEFAULT_STEPS);
  const next = nextDueAfter(steps, draft.sequence_step, sentAt);
  const patch = next
    ? { current_step: draft.sequence_step, next_due_at: next.dueAt.toISOString(), status: enr.status === "proposed" ? "active" : enr.status, activated_at: enr.activated_at ?? sentAt.toISOString() }
    : { current_step: draft.sequence_step, next_due_at: null, status: "completed", completed_at: sentAt.toISOString() };
  const { data } = await db.from("sequence_enrollment").update(patch).eq("workspace_id", workspaceId).eq("id", id).select().maybeSingle();
  return data;
}

/**
 * Job: create the next step draft for due, active enrollments (service-role client, explicit workspace filter).
 * Guards: suppression, active negotiation, recent reply, channel caps, account saturation / colleague collision.
 */
export async function sequenceTick(admin: Db, workspaceId: string, now = new Date()) {
  const { data: due } = await admin.from("sequence_enrollment").select("*, outreach_sequence(steps, caps, persona)")
    .eq("workspace_id", workspaceId).eq("status", "active").lte("next_due_at", now.toISOString()).limit(50);
  const out = { drafted: 0, paused: 0, deferred: 0 };
  for (const enr of due ?? []) {
    const seq = enr.outreach_sequence as { steps: SequenceStep[]; caps: SequenceCaps; persona: string | null } | null;
    const steps = (seq?.steps ?? DEFAULT_STEPS).sort((a, b) => a.step - b.step);
    const step = steps.find((s) => s.step > enr.current_step);
    if (!step) {
      await admin.from("sequence_enrollment").update({ status: "completed", completed_at: now.toISOString(), next_due_at: null }).eq("workspace_id", workspaceId).eq("id", enr.id);
      continue;
    }
    try {
      await assertNotSuppressed(admin, workspaceId, enr.person_id, step.channel);
    } catch (e) {
      if (e instanceof SuppressedRecipientError) { await pauseEnrollment(admin, workspaceId, enr.id, "suppressed"); out.paused++; continue; }
      throw e;
    }
    const neg = await negotiationFor(admin, workspaceId, enr);
    if (neg) { await pauseEnrollment(admin, workspaceId, enr.id, "active_negotiation", null, `Opportunity “${neg.name}” is at ${neg.stage.replace(/_/g, " ")}`); out.paused++; continue; }
    const contrary = await contrarySignalFor(admin, workspaceId, enr, enr.enrolled_at);
    if (contrary) { await pauseEnrollment(admin, workspaceId, enr.id, "contrary_info", null, contrary.detail); out.paused++; continue; }
    const report = await collisionsDirect(admin, workspaceId, { orgId: enr.org_id, personId: enr.person_id, userId: enr.owner_user_id, accountPerWeek: seq?.caps?.account_per_week, now });
    if (report.recentInbound) { await pauseEnrollment(admin, workspaceId, enr.id, "reply"); out.paused++; continue; }
    if (report.collisions.length > 0) { await pauseEnrollment(admin, workspaceId, enr.id, "collision"); out.paused++; continue; }
    const { data: sentSame } = await admin.from("draft").select("marked_sent_at").eq("workspace_id", workspaceId).eq("recipient_person_id", enr.person_id)
      .eq("channel", step.channel).in("state", ["marked_sent", "reconciled_sent"]);
    const capOk = withinChannelCap((sentSame ?? []).map((d) => d.marked_sent_at).filter(Boolean) as string[], seq?.caps?.[step.channel as "email" | "linkedin" | "whatsapp"], now);
    if (report.saturated || !capOk) {
      await admin.from("sequence_enrollment").update({ next_due_at: new Date(now.getTime() + 86_400_000).toISOString() }).eq("workspace_id", workspaceId).eq("id", enr.id);
      out.deferred++;
      continue;
    }
    const { data: existing } = await admin.from("draft").select("id").eq("workspace_id", workspaceId).eq("sequence_key", sequenceKey(enr.id)).eq("sequence_step", step.step).limit(1);
    if (!existing?.length) {
      await generateStepDraft(admin, workspaceId, { enrollment: enr, step, persona: seq?.persona ?? null, ownerUserId: enr.owner_user_id, createdByKind: "job" });
      out.drafted++;
    }
    // wait for the user to send this step; onSequenceDraftSent schedules the next one
    await admin.from("sequence_enrollment").update({ next_due_at: null }).eq("workspace_id", workspaceId).eq("id", enr.id);
  }
  return out;
}

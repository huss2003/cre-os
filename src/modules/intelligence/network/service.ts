import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { proposeChange } from "@/lib/services/changes";
import { createDraft } from "@/lib/services/drafts";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { type AiCall, isoDate, expiryFor } from "../common";
import { detectThreadingGaps, type ThreadingGap, stageIndex } from "./graph";
import { introPathSummaries, nameMap } from "../research/service";
import { verifyTaskKey, jobMoveVerified } from "./consent";

type Row = Record<string, unknown>;

/**
 * LinkedIn-compliant job-move workflow (spec §9): alert/manual observation -> person identity candidate -> employment change
 * with source/date -> human confirmation (proposeChange) -> prior employment preserved -> warm intro path -> draft reconnect.
 * No scraping, no automation: inputs are a native alert the user saw, a press release/appointment URL or a manual note.
 */
export const JobMoveInput = z.object({
  personId: z.string().uuid().optional().nullable(),
  personName: z.string().min(2).max(160).optional().nullable(),
  fromOrgId: z.string().uuid().optional().nullable(),
  toOrgId: z.string().uuid(),
  newTitle: z.string().max(160).optional().nullable(),
  effectiveOn: z.string().date().optional().nullable(),
  observedOn: z.string().date().optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
  sourceNote: z.string().max(2000).optional().nullable(),
  sourceKind: z.enum(["native_alert", "press_release", "company_page", "appointment_notice", "conversation", "user_export", "other"]).default("other"),
});

export interface PersonCandidate { id: string; full_name: string; current_orgs: string[]; similarity: "exact" | "partial" }

/** Identity candidates only — a name alone never permits a merge or a silent pick. */
export async function personCandidates(db: Db, workspaceId: string, name: string): Promise<PersonCandidate[]> {
  const q = name.trim();
  const { data, error } = await db.from("person").select("id, full_name").eq("workspace_id", workspaceId).ilike("full_name", `%${q.replace(/[%_]/g, "")}%`).is("archived_at", null).limit(20);
  if (error) throw error;
  const ids = (data ?? []).map((p) => String(p.id));
  const emps = ids.length ? (await db.from("employment").select("person_id, org_id").eq("workspace_id", workspaceId).eq("is_current", true).in("person_id", ids)).data ?? [] : [];
  const orgs = await nameMap(db, workspaceId, "organisation", emps.map((e) => String(e.org_id)));
  return (data ?? []).map((p) => ({
    id: String(p.id), full_name: String(p.full_name),
    current_orgs: emps.filter((e) => e.person_id === p.id).map((e) => orgs.get(String(e.org_id)) ?? "(restricted)"),
    similarity: String(p.full_name).toLowerCase() === q.toLowerCase() ? "exact" as const : "partial" as const,
  }));
}

export interface JobMoveResult {
  status: "needs_identity" | "proposed";
  candidates?: PersonCandidate[];
  claim?: Row;
  proposals?: Row[];
  flags?: string[];
  task?: Row | null;
  verified?: boolean;
}

export async function recordJobMove(db: Db, workspaceId: string, raw: z.input<typeof JobMoveInput>, userId?: string | null): Promise<JobMoveResult> {
  const input = JobMoveInput.parse(raw);
  if (!input.personId) {
    const candidates = input.personName ? await personCandidates(db, workspaceId, input.personName) : [];
    return { status: "needs_identity", candidates };
  }
  const observed = input.observedOn ?? isoDate(new Date())!;
  // Replay-safe: an open (unconfirmed) candidate move for the same person and new employer is reused, not duplicated.
  const { data: openClaims } = await db.from("signal_claim").select("*").eq("workspace_id", workspaceId).eq("subject_type", "person").eq("subject_id", input.personId)
    .eq("claim_type", "job_move").eq("value_json->>to_org_id", input.toOrgId).eq("status", "reported").is("archived_at", null).order("created_at", { ascending: false }).limit(1);
  const reused = openClaims?.[0] ?? null;
  const { data: claim, error } = reused ? { data: reused, error: null } : await db.from("signal_claim").insert({
    workspace_id: workspaceId, subject_type: "person", subject_id: input.personId, claim_type: "job_move",
    predicate: "moved_to", value_json: { from_org_id: input.fromOrgId ?? null, to_org_id: input.toOrgId, title: input.newTitle ?? null, source_kind: input.sourceKind },
    status: "reported", evidence_tier: input.sourceKind === "press_release" || input.sourceKind === "appointment_notice" || input.sourceKind === "company_page" ? "credible_reported" : "single_unverified",
    evidence_excerpt: input.sourceNote ?? null, source_url: input.sourceUrl ?? null, source_locator: input.sourceUrl ? null : input.sourceKind,
    observed_on: observed, effective_on: input.effectiveOn ?? null, expires_on: expiryFor("job_move", observed), owner_user_id: userId ?? undefined,
  }).select().single();
  if (error) throw error;

  const proposals: Row[] = [];
  // Close the old episode — preserve it (replace end fields), never remove.
  let oldQ = db.from("employment").select("id, org_id, row_version").eq("workspace_id", workspaceId).eq("person_id", input.personId).eq("is_current", true).is("archived_at", null);
  if (input.fromOrgId) oldQ = oldQ.eq("org_id", input.fromOrgId);
  const { data: olds } = await oldQ;
  for (const old of (olds ?? []).filter((o) => o.org_id !== input.toOrgId)) {
    proposals.push(await proposeChange(db, workspaceId, {
      targetType: "employment", targetId: String(old.id), operation: "update", expectedVersion: Number(old.row_version),
      patch: [
        { op: "replace", path: "/is_current", value: false },
        { op: "replace", path: "/end_date", value: input.effectiveOn ?? null },
        { op: "replace", path: "/end_precision", value: input.effectiveOn ? "day" : "unknown" },
      ],
      reason: `Job move observed (${input.sourceKind}${input.sourceUrl ? `: ${input.sourceUrl}` : ""}). Prior employment is preserved as history.`,
      evidenceIds: [String(claim.id)], proposedByKind: "user", idempotencyKey: `jobmove:${claim.id}:close:${old.id}`,
    }));
  }
  // Open the new episode at the new employer.
  const { data: existingNew } = await db.from("employment").select("id").eq("workspace_id", workspaceId).eq("person_id", input.personId).eq("org_id", input.toOrgId).eq("is_current", true).limit(1);
  if (!existingNew?.length) {
    proposals.push(await proposeChange(db, workspaceId, {
      targetType: "employment", targetId: null, operation: "create",
      patch: [
        { op: "add", path: "/person_id", value: input.personId },
        { op: "add", path: "/org_id", value: input.toOrgId },
        { op: "add", path: "/title", value: input.newTitle ?? null },
        { op: "add", path: "/start_date", value: input.effectiveOn ?? null },
        { op: "add", path: "/start_precision", value: input.effectiveOn ? "day" : "unknown" },
        { op: "add", path: "/is_current", value: true },
        { op: "add", path: "/fact_status", value: "reported" },
      ],
      reason: `New employer from job-move observation (${input.sourceKind}).`, evidenceIds: [String(claim.id)], proposedByKind: "user",
      idempotencyKey: `jobmove:${claim.id}:open`,
    }));
  }
  const orgs = await nameMap(db, workspaceId, "organisation", [input.fromOrgId, input.toOrgId, ...(olds ?? []).map((o) => String(o.org_id))]);
  const flags = [
    `Possible opportunity at ${orgs.get(input.toOrgId) ?? "the new employer"}: a new leader may review the workplace — verify; do not assume authority to decide.`,
    ...[...new Set((olds ?? []).map((o) => String(o.org_id)))].filter((o) => o !== input.toOrgId).map((o) => `Re-map the decision committee at ${orgs.get(o) ?? "the former employer"}: a contact has left. Old-company deal notes stay with that account.`),
  ];
  const task = await ensureVerificationTask(db, workspaceId, { personId: input.personId, toOrgId: input.toOrgId, claimId: String(claim.id), userId: userId ?? null,
    personName: (await nameMap(db, workspaceId, "person", [input.personId])).get(input.personId) ?? "Contact", toOrgName: orgs.get(input.toOrgId) ?? "the new employer" });
  return { status: "proposed", claim, proposals, flags, task, verified: false };
}

/**
 * Dedicated verification task for a candidate job move (in addition to the approval proposals). One per person + new
 * employer (deterministic idempotency key), so re-recording the same move never creates a second task.
 */
export async function ensureVerificationTask(db: Db, workspaceId: string, p: { personId: string; toOrgId: string; claimId: string; userId: string | null; personName: string; toOrgName: string }) {
  const key = verifyTaskKey(p.personId, p.toOrgId);
  const { data: existing } = await db.from("task").select("*").eq("workspace_id", workspaceId).eq("idempotency_key", key).limit(1);
  if (existing?.length) return existing[0] as Row;
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const { data, error } = await db.from("task").insert({
    workspace_id: workspaceId, title: `Verify job move: ${p.personName} → ${p.toOrgName}`,
    description: `Unverified candidate move (evidence signal_claim ${p.claimId}). Confirm with a second source or the person before treating it as fact; do not assume authority at the new employer. Approve or reject the employment proposals in Approvals.`,
    due_at: due, status: "open", priority: 60, assigned_user_id: p.userId, linked_entity_type: "person", linked_entity_id: p.personId,
    source: "workflow", idempotency_key: key, owner_user_id: p.userId ?? undefined,
  }).select().single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const { data: again } = await db.from("task").select("*").eq("workspace_id", workspaceId).eq("idempotency_key", key).limit(1);
      return (again?.[0] as Row) ?? null;
    }
    throw error;
  }
  return data as Row;
}

/** Human confirmation of a candidate move: claim -> currently_confirmed, verification task done (with the evidence note). */
export async function verifyJobMove(db: Db, workspaceId: string, claimId: string, note: string | null) {
  const { data: claim, error } = await db.from("signal_claim").select("id, subject_id, value_json, status, row_version").eq("workspace_id", workspaceId).eq("id", claimId).eq("claim_type", "job_move").maybeSingle();
  if (error) throw error;
  if (!claim) throw new Error("Job move not found.");
  if (claim.status !== "currently_confirmed") {
    const { data: upd, error: e1 } = await db.from("signal_claim").update({ status: "currently_confirmed", evidence_tier: "corroborated_public" }).eq("workspace_id", workspaceId).eq("id", claimId).eq("row_version", claim.row_version).select("id").maybeSingle();
    if (e1) throw e1;
    if (!upd) throw new Error("This job move changed meanwhile — reload and try again.");
  }
  const toOrg = String(((claim.value_json ?? {}) as Row).to_org_id ?? "");
  const { data: task } = await db.from("task").update({ status: "done", completed_at: new Date().toISOString(), completion_evidence: (note ?? "Confirmed by user").slice(0, 1000) })
    .eq("workspace_id", workspaceId).eq("idempotency_key", verifyTaskKey(String(claim.subject_id), toOrg)).in("status", ["open", "snoozed", "stale"]).select("id").maybeSingle();
  return { claimId, verified: true, taskClosed: !!task };
}

/** Verification state of job-move claims (claim confirmed, or all employment proposals applied). */
export async function jobMoveStates(db: Db, workspaceId: string, claims: { id: string; status: string }[]) {
  const out = new Map<string, boolean>();
  if (!claims.length) return out;
  // The "open new employment" proposal is the one that turns the move into a fact.
  const { data } = await db.from("change_proposal").select("idempotency_key, state").eq("workspace_id", workspaceId).in("idempotency_key", claims.map((c) => `jobmove:${c.id}:open`)).limit(1000);
  for (const c of claims) {
    const states = ((data ?? []) as Row[]).filter((p) => String(p.idempotency_key).startsWith(`jobmove:${c.id}:`)).map((p) => String(p.state));
    out.set(c.id, jobMoveVerified(c.status, states));
  }
  return out;
}

const ReconnectSchema = z.object({ subject: z.string(), body: z.string() });

/**
 * Personal reconnect DRAFT (never sent). Uses only the person's name, new employer and title — no notes from the old
 * company, no scraped private context. Blocked if the person is suppressed.
 */
export async function draftReconnect(db: Db, workspaceId: string, input: { personId: string; orgId: string; channel?: "email" | "linkedin"; ai?: AiCall; userId?: string | null }) {
  const [{ data: person }, { data: org }, { data: emp }] = await Promise.all([
    db.from("person").select("id, full_name").eq("workspace_id", workspaceId).eq("id", input.personId).single(),
    db.from("organisation").select("id, display_name").eq("workspace_id", workspaceId).eq("id", input.orgId).single(),
    db.from("employment").select("title").eq("workspace_id", workspaceId).eq("person_id", input.personId).eq("org_id", input.orgId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!person || !org) throw new Error("person or organisation not visible");
  const first = String(person.full_name).split(/\s+/)[0];
  const title = emp?.title ? String(emp.title) : null;
  const mock = () => ({
    subject: `Congratulations on the move to ${org.display_name}`,
    body: `Hi ${first},\n\nCongratulations on your new role${title ? ` as ${title}` : ""} at ${org.display_name}. Hope the first weeks are going well.\n\nIf workplace or office plans in Pune come up as you settle in, I'd be glad to share what we're seeing in the market — no agenda, happy to just catch up.\n\nBest,`,
  });
  let draft = mock();
  try {
    const res = await (input.ai ?? (callStructured as AiCall))({
      workspaceId, workflow: "network.reconnect", tier: "luna",
      system: "Write a short, personal, non-salesy congratulation note from a Pune commercial-real-estate adviser. Do not mention any previous employer's confidential matters, prices or deals. No invented facts.",
      input: `First name: ${first}\nNew employer: ${org.display_name}\nTitle: ${title ?? "unknown"}`, schema: ReconnectSchema, schemaName: "reconnect", maxOutputTokens: 400, mock,
    });
    draft = res.data;
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e; // fall back to the template
  }
  return createDraft(db, workspaceId, {
    channel: input.channel ?? "email", recipientPersonId: input.personId, recipientDisplay: String(person.full_name),
    subject: draft.subject, body: draft.body, orgId: input.orgId, purpose: "job_move_reconnect", createdByKind: "model",
  });
}

export async function introPathsForOrg(db: Db, workspaceId: string, orgId: string, me: string) {
  const { data } = await db.from("employment").select("person_id").eq("workspace_id", workspaceId).eq("org_id", orgId).eq("is_current", true).is("archived_at", null);
  const ids = [...new Set((data ?? []).map((e) => String(e.person_id)))];
  if (ids.length === 0) return [];
  return introPathSummaries(db, workspaceId, me, ids, isoDate(new Date())!);
}

export interface OpportunityGaps { opportunity_id: string; name: string; org_id: string; stage: string; gaps: ThreadingGap[] }

/** Multi-threading gap detector across open opportunities. */
export async function threadingGaps(db: Db, workspaceId: string, opportunityId?: string): Promise<OpportunityGaps[]> {
  let q = db.from("opportunity").select("id, name, org_id, stage, requirement_id").eq("workspace_id", workspaceId).eq("outcome", "open").is("archived_at", null).limit(500);
  if (opportunityId) q = q.eq("id", opportunityId);
  const { data: opps, error } = await q;
  if (error) throw error;
  const reqIds = (opps ?? []).map((o) => o.requirement_id).filter(Boolean) as string[];
  const sh = reqIds.length ? ((await db.from("stakeholder").select("requirement_id, person_id, role").eq("workspace_id", workspaceId).in("requirement_id", reqIds).is("archived_at", null)).data ?? []) : [];
  const personIds = [...new Set(sh.map((s) => String(s.person_id)))];
  const emps = personIds.length ? ((await db.from("employment").select("person_id, org_id, is_current").eq("workspace_id", workspaceId).in("person_id", personIds)).data ?? []) : [];
  return (opps ?? []).map((o) => {
    const mine = sh.filter((s) => s.requirement_id === o.requirement_id).map((s) => {
      const atOrg = emps.filter((e) => e.person_id === s.person_id && e.org_id === o.org_id);
      return { person_id: String(s.person_id), role: String(s.role), employment_current: atOrg.length ? atOrg.some((e) => e.is_current) : null };
    });
    return { opportunity_id: String(o.id), name: String(o.name), org_id: String(o.org_id), stage: String(o.stage), gaps: detectThreadingGaps(String(o.stage), mine) };
  }).filter((g) => g.gaps.length > 0).sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage));
}

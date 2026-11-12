/**
 * Category E — leadership / decision-maker changes (spec §3E). When a person changes employer:
 *  - match against existing people (never by name alone — resolvePerson);
 *  - keep the existing person identity and all historical employment / interactions (nothing is ended or deleted here);
 *  - record an UNVERIFIED employment observation (signal_claim job_move, status reported);
 *  - propose the employment update through proposeChange (Review; S4) — never a direct write;
 *  - create relationship-review tasks for the previous and the new organisation (idempotent);
 *  - never transfer opportunities, requirements or confidential company information to the new employer.
 */
import type { Db } from "@/lib/supabase/server";
import { proposeChange } from "@/lib/services/changes";
import { checkHttpUrl } from "@/lib/util/url";
import { localDate } from "@/lib/util/time";
import { dedupeKey, normName } from "./engine";
import { leadershipSubType, CRE_DECISION_SUBTYPES, SUB_TYPES } from "./taxonomy";
import { resolvePerson, resolveOrganisation, type Candidate } from "./resolve";
import { settings, upsertSignal, SignalError, type OrgContext } from "./service";

export interface LeadershipInput {
  personName: string; email?: string | null; title?: string | null; toOrgName?: string | null; toOrgId?: string | null; fromOrgId?: string | null;
  text: string; sourceName?: string | null; sourceUrl?: string | null; publishedOn?: string | null;
}

export async function recordLeadershipChange(db: Db, ws: string, userId: string, i: LeadershipInput) {
  if (!i.personName?.trim()) throw new SignalError("Name the person.");
  if ((i.text ?? "").trim().length < 10) throw new SignalError("Add the evidence text.");
  const link = checkHttpUrl(i.sourceUrl ?? undefined, "Source link"); if (link.error) throw new SignalError(link.error);
  const today = localDate();
  const person = await resolvePerson(db, ws, { name: i.personName, email: i.email, orgId: i.fromOrgId });
  let toOrgId = i.toOrgId ?? null;
  let orgCandidates: Candidate[] = [];
  if (!toOrgId && i.toOrgName) { const r = await resolveOrganisation(db, ws, { name: i.toOrgName }); toOrgId = r.orgId; orgCandidates = r.candidates; }
  // Previous employer: given, or the person's current employment on record.
  let fromOrgId = i.fromOrgId ?? null;
  if (!fromOrgId && person.personId) {
    const { data } = await db.from("employment").select("org_id").eq("workspace_id", ws).eq("person_id", person.personId).eq("is_current", true).neq("org_id", toOrgId ?? "00000000-0000-0000-0000-000000000000").limit(1).maybeSingle();
    fromOrgId = data?.org_id ?? null;
  }
  const sub = leadershipSubType(i.title);
  let claimId: string | null = null;
  if (person.personId) {
    const { data: dup } = await db.from("signal_claim").select("id").eq("workspace_id", ws).eq("subject_id", person.personId).eq("claim_type", "job_move").eq("evidence_excerpt", i.text.slice(0, 1000)).limit(1);
    claimId = dup?.[0]?.id ?? null;
    if (!claimId) {
      const { data, error } = await db.from("signal_claim").insert({
        workspace_id: ws, subject_type: "person", subject_id: person.personId, claim_type: "job_move", predicate: "employment_change_observed",
        value_json: { from_org_id: fromOrgId, to_org_id: toOrgId, to_org_name: i.toOrgName ?? null, title: i.title ?? null, verified: false },
        status: "reported", evidence_tier: "single_unverified", evidence_excerpt: i.text.slice(0, 1000), source_url: link.value, source_locator: i.sourceName ?? "user",
        published_on: i.publishedOn ?? null, observed_on: today, owner_user_id: userId,
      }).select("id").single();
      if (error) throw new SignalError(error.message);
      claimId = data.id;
    }
  }
  const s = await settings(db, ws);
  const who = person.personId ? i.personName : `${i.personName} (unmatched)`;
  const sig = await upsertSignal(db, ws, {
    category: "leadership", kind: "job_move", subType: sub, role: i.title ?? null,
    key: dedupeKey("leadership", "job_move", person.personId ?? `name:${normName(i.personName)}:${normName(i.toOrgName ?? "")}`, i.publishedOn ?? today),
    title: `${who} reported as ${i.title ?? "new role"}${i.toOrgName ? ` at ${i.toOrgName}` : ""}`,
    summary: `Unverified employment observation: ${i.text.slice(0, 300)}`,
    creRelevance: CRE_DECISION_SUBTYPES.has(sub) ? `${SUB_TYPES[sub].label}: can reopen real-estate decisions and creates a relationship path.` : "The role may not influence real-estate decisions.",
    orgId: toOrgId, personId: person.personId, nameRaw: person.personId ? null : i.personName, verification: "inference",
    entityCandidates: person.personId ? orgCandidates : person.candidates, entityResolution: { method: person.method, reasons: person.reasons, raw_name: i.personName, org_candidates: orgCandidates },
    recommended: { text: "Research the person's responsibilities and relationship path; review both organisations' relationships. Confirm the move before updating records.", actionKind: "relationship_follow_up" },
    evidence: [{ role: "support", key: claimId ? `claim:${claimId}` : `leader:${normName(i.personName)}:${link.value ?? i.text.slice(0, 60)}`, claimId: claimId ?? undefined,
      sourceName: i.sourceName ?? "User observation", url: link.value, excerpt: i.text, tier: "single_unverified", status: "reported", published: i.publishedOn ?? null, label: "inference" }],
    processing: person.personId ? "review_required" : "entity_unresolved",
  }, s, today, new Map<string, OrgContext>());

  // Proposal (S4): the employment update is never written directly. Prior employment rows are untouched.
  let proposalId: string | null = null;
  if (person.personId && toOrgId) {
    const p = await proposeChange(db, ws, {
      targetType: "employment", operation: "create", proposedByKind: "user", actorUserId: userId, idempotencyKey: `signals.employment:${person.personId}:${toOrgId}`,
      reason: `Leadership signal (unverified): ${i.personName} → ${i.toOrgName ?? "new employer"}${i.title ? ` as ${i.title}` : ""}`,
      patch: [{ op: "add", path: "/person_id", value: person.personId }, { op: "add", path: "/org_id", value: toOrgId }, { op: "add", path: "/title", value: i.title ?? null },
        { op: "add", path: "/is_current", value: true }, { op: "add", path: "/fact_status", value: "reported" }],
    });
    proposalId = (p as { id?: string } | null)?.id ?? null;
  }
  // Relationship-review tasks for both organisations (idempotent). No data or opportunity moves between them.
  const taskIds: string[] = [];
  for (const [which, orgId, title] of [["prev", fromOrgId, `Review relationship coverage at the previous employer after ${i.personName}'s move`], ["new", toOrgId, `Review the relationship path to ${i.toOrgName ?? "the new employer"} via ${i.personName}`]] as const) {
    if (!orgId && !person.personId) continue;
    const key = `signal:${sig.id}:rel:${which}`;
    const { data: ex } = await db.from("task").select("id").eq("workspace_id", ws).eq("idempotency_key", key).maybeSingle();
    if (ex) { taskIds.push(ex.id); continue; }
    const { data, error } = await db.from("task").insert({ workspace_id: ws, title, description: `Leadership signal ${sig.id}. Confidential information about either company is not shared between them.`,
      due_at: new Date(Date.now() + 14 * 86_400_000).toISOString(), priority: 50, assigned_user_id: userId, linked_entity_type: orgId ? "organisation" : "person",
      linked_entity_id: orgId ?? person.personId, source: "signal", idempotency_key: key, owner_user_id: userId, related_entities: [{ type: "signal", id: sig.id }] }).select("id").single();
    if (error && !/duplicate key/.test(error.message)) throw new SignalError(error.message);
    if (data) taskIds.push(data.id);
  }
  return { signalId: sig.id, created: sig.created, personId: person.personId, personCandidates: person.candidates, orgCandidates, proposalId, taskIds, claimId };
}

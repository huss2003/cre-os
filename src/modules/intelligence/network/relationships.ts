import "server-only";
import { z } from "zod";
import type { Db } from "@/lib/supabase/server";
import { createDraft } from "@/lib/services/drafts";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { type AiCall, isoDate } from "../common";
import { nameMap } from "../research/service";
import { consentIsActive, type ConsentLite } from "./consent";

type Row = Record<string, unknown>;

/**
 * Network intelligence — user-recorded relationships (relationship_edge) and introduction consent (introduction_consent).
 * - Relationships are recorded by the user from their own knowledge; intro_permission is NEVER set here.
 * - Introduction consent records who gave permission, how and when, and who recorded it (owner_user_id, created_at).
 *   Only an active consent sets relationship_edge.intro_permission; revoking clears it when no other consent is active.
 * - An introduction-request draft is only created when the introducer's consent is active (S3: drafts only, never sent).
 */
export const EDGE_TYPES = ["worked_with", "former_colleague", "client_of", "friend", "industry_contact", "introduced_by", "colleague_relationship", "other"] as const;
export const WARMTHS = ["cold", "warm", "hot", "trusted"] as const;

export const RelationshipInput = z.object({
  fromKind: z.enum(["me", "person"]),
  fromPersonId: z.string().uuid().optional().nullable(),
  toPersonId: z.string().uuid(),
  edgeType: z.enum(EDGE_TYPES),
  warmth: z.enum(WARMTHS).optional().nullable(),
  strengthBasis: z.string().trim().max(500).optional().nullable(),
  lastContact: z.string().date().optional().nullable(),
});

export class RelationshipError extends Error {}
export class IntroConsentRequiredError extends Error {}

export async function recordRelationship(db: Db, workspaceId: string, raw: z.input<typeof RelationshipInput>, userId: string) {
  const input = RelationshipInput.parse(raw);
  const today = isoDate(new Date())!;
  if (input.fromKind === "person" && !input.fromPersonId) throw new RelationshipError("Choose who knows this person.");
  if (input.fromKind === "person" && input.fromPersonId === input.toPersonId) throw new RelationshipError("A person cannot have a relationship with themselves.");
  if (input.lastContact && input.lastContact > today) throw new RelationshipError("Last contact cannot be in the future.");
  const fromUser = input.fromKind === "me" ? userId : null;
  const fromPerson = input.fromKind === "person" ? input.fromPersonId! : null;

  // Same (from, to, type) live edge => update it instead of duplicating (replay-safe).
  let q = db.from("relationship_edge").select("id, row_version").eq("workspace_id", workspaceId).eq("to_person_id", input.toPersonId).eq("edge_type", input.edgeType).is("archived_at", null).is("valid_to", null);
  q = fromUser ? q.eq("from_user_id", fromUser) : q.eq("from_person_id", fromPerson!);
  const { data: existing, error: e0 } = await q.limit(1);
  if (e0) throw e0;
  const fields = { warmth: input.warmth ?? null, strength_basis: input.strengthBasis ?? null, last_meaningful_contact: input.lastContact ?? null };
  if (existing?.length) {
    const { data, error } = await db.from("relationship_edge").update(fields).eq("workspace_id", workspaceId).eq("id", existing[0].id).eq("row_version", existing[0].row_version).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new RelationshipError("This relationship changed meanwhile — reload and try again.");
    return { edge: data as Row, created: false };
  }
  const { data, error } = await db.from("relationship_edge").insert({
    workspace_id: workspaceId, from_user_id: fromUser, from_person_id: fromPerson, to_person_id: input.toPersonId, edge_type: input.edgeType,
    ...fields, intro_permission: false, relationship_owner_user_id: userId, owner_user_id: userId, valid_from: today,
  }).select().single();
  if (error) throw error;
  return { edge: data as Row, created: true };
}

/** End a relationship (kept as history with valid_to). */
export async function endRelationship(db: Db, workspaceId: string, edgeId: string, expectedVersion?: number) {
  let q = db.from("relationship_edge").update({ valid_to: isoDate(new Date()) }).eq("workspace_id", workspaceId).eq("id", edgeId);
  if (expectedVersion !== undefined) q = q.eq("row_version", expectedVersion);
  const { data, error } = await q.select().maybeSingle();
  if (error) throw error;
  if (!data) throw new RelationshipError("Relationship not found or changed meanwhile.");
  return data as Row;
}

export const ConsentInput = z.object({
  edgeId: z.string().uuid(),
  givenBy: z.enum(["introducer", "target", "both"]).default("introducer"),
  givenOn: z.string().date(),
  method: z.enum(["conversation", "email", "message", "meeting", "call", "other"]).default("conversation"),
  evidence: z.string().trim().max(1000).optional().nullable(),
  scope: z.string().trim().max(300).optional().nullable(),
  expiresOn: z.string().date().optional().nullable(),
});

/** Record introduction consent for an edge (introducer → target). By whom = owner_user_id; when = given_on + created_at. */
export async function recordIntroConsent(db: Db, workspaceId: string, raw: z.input<typeof ConsentInput>, userId: string) {
  const input = ConsentInput.parse(raw);
  const today = isoDate(new Date())!;
  if (input.givenOn > today) throw new RelationshipError("Consent cannot be dated in the future.");
  if (input.expiresOn && input.expiresOn < input.givenOn) throw new RelationshipError("Expiry must be after the date consent was given.");
  const { data: edge, error } = await db.from("relationship_edge").select("id, from_user_id, from_person_id, to_person_id, row_version, valid_to").eq("workspace_id", workspaceId).eq("id", input.edgeId).is("archived_at", null).maybeSingle();
  if (error) throw error;
  if (!edge) throw new RelationshipError("Relationship not found.");
  if (edge.valid_to && String(edge.valid_to) < today) throw new RelationshipError("This relationship has ended.");
  if (edge.from_user_id && edge.from_user_id === userId) throw new RelationshipError("This is your own relationship — no introduction is needed.");

  // dedupe: an identical active consent already recorded for this edge and date
  const { data: dup } = await db.from("introduction_consent").select("*").eq("workspace_id", workspaceId).eq("edge_id", edge.id).eq("given_on", input.givenOn).eq("given_by", input.givenBy).is("revoked_at", null).limit(1);
  if (dup?.length) return dup[0] as Row;

  const consentPerson = input.givenBy === "target" ? String(edge.to_person_id) : (edge.from_person_id as string | null) ?? String(edge.to_person_id);
  const { data: cp, error: e1 } = await db.from("consent_permission").insert({
    workspace_id: workspaceId, person_id: consentPerson, purpose: "introduction", channel: "introduction", source_label: "introduction_consent",
    evidence: [`Given ${input.givenOn} by ${input.givenBy} via ${input.method}`, input.evidence].filter(Boolean).join(" — ").slice(0, 1000),
    expires_on: input.expiresOn ?? null, suppressed: false, classification: "permitted_personal", owner_user_id: userId,
  }).select("id").single();
  if (e1) throw e1;
  const { data: row, error: e2 } = await db.from("introduction_consent").insert({
    workspace_id: workspaceId, edge_id: edge.id, introducer_person_id: edge.from_person_id ?? null, introducer_user_id: edge.from_user_id ?? null,
    target_person_id: edge.to_person_id, given_by: input.givenBy, given_on: input.givenOn, method: input.method, evidence: input.evidence ?? null,
    scope: input.scope ?? null, expires_on: input.expiresOn ?? null, consent_permission_id: cp.id, owner_user_id: userId, classification: "permitted_personal",
  }).select().single();
  if (e2) throw e2;
  await syncEdgePermission(db, workspaceId, String(edge.id), today);
  return row as Row;
}

export async function revokeIntroConsent(db: Db, workspaceId: string, consentId: string, reason: string | null) {
  const now = new Date().toISOString();
  const { data, error } = await db.from("introduction_consent").update({ revoked_at: now, revoked_reason: reason?.slice(0, 300) ?? null }).eq("workspace_id", workspaceId).eq("id", consentId).is("revoked_at", null).select().maybeSingle();
  if (error) throw error;
  if (!data) throw new RelationshipError("Consent not found or already revoked.");
  // Channel-scoped revocation: blocks introduction drafts only, never other channels.
  if (data.consent_permission_id) await db.from("consent_permission").update({ revoked_at: now }).eq("workspace_id", workspaceId).eq("id", data.consent_permission_id);
  await syncEdgePermission(db, workspaceId, String(data.edge_id), isoDate(new Date())!);
  return data as Row;
}

async function syncEdgePermission(db: Db, workspaceId: string, edgeId: string, today: string) {
  const { data: cs } = await db.from("introduction_consent").select("given_on, expires_on, revoked_at").eq("workspace_id", workspaceId).eq("edge_id", edgeId).is("archived_at", null);
  const active = (cs ?? []).some((c) => consentIsActive(c as ConsentLite, today));
  const { error } = await db.from("relationship_edge").update({ intro_permission: active }).eq("workspace_id", workspaceId).eq("id", edgeId);
  if (error) throw error;
}

export interface EdgeView {
  id: string; row_version: number; direction: "in" | "out"; from_label: string; from_person_id: string | null; from_user_id: string | null;
  to_label: string; to_person_id: string; edge_type: string; warmth: string | null; strength_basis: string | null; last_contact: string | null;
  valid_to: string | null; intro_permission: boolean; mine: boolean;
  consents: (Row & { active: boolean })[];
}

/** Relationships touching a person, with their consent records (who gave it, when, recorded by whom). */
export async function relationshipsForPerson(db: Db, workspaceId: string, personId: string, me: string): Promise<EdgeView[]> {
  const sel = "id, row_version, from_user_id, from_person_id, to_person_id, edge_type, warmth, strength_basis, last_meaningful_contact, valid_to, intro_permission";
  const [inn, out] = await Promise.all([
    db.from("relationship_edge").select(sel).eq("workspace_id", workspaceId).eq("to_person_id", personId).is("archived_at", null).limit(200),
    db.from("relationship_edge").select(sel).eq("workspace_id", workspaceId).eq("from_person_id", personId).is("archived_at", null).limit(200),
  ]);
  if (inn.error) throw inn.error;
  if (out.error) throw out.error;
  const edges = [...(inn.data ?? []).map((e) => ({ ...e, direction: "in" as const })), ...(out.data ?? []).map((e) => ({ ...e, direction: "out" as const }))] as (Row & { direction: "in" | "out" })[];
  const names = await nameMap(db, workspaceId, "person", edges.flatMap((e) => [e.from_person_id as string, e.to_person_id as string]));
  const ids = edges.map((e) => String(e.id));
  const { data: cs } = ids.length ? await db.from("introduction_consent").select("id, edge_id, given_by, given_on, method, evidence, scope, expires_on, revoked_at, revoked_reason, owner_user_id, created_at").eq("workspace_id", workspaceId).in("edge_id", ids).is("archived_at", null).order("created_at", { ascending: false }) : { data: [] };
  const today = isoDate(new Date())!;
  const label = (userId: unknown, personIdX: unknown) => (userId ? (userId === me ? "You" : "A colleague") : names.get(String(personIdX)) ?? "(restricted person)");
  return edges.map((e) => ({
    id: String(e.id), row_version: Number(e.row_version), direction: e.direction,
    from_label: label(e.from_user_id, e.from_person_id), from_person_id: (e.from_person_id as string | null) ?? null, from_user_id: (e.from_user_id as string | null) ?? null,
    to_label: names.get(String(e.to_person_id)) ?? "(restricted person)", to_person_id: String(e.to_person_id), edge_type: String(e.edge_type),
    warmth: (e.warmth as string | null) ?? null, strength_basis: (e.strength_basis as string | null) ?? null, last_contact: (e.last_meaningful_contact as string | null) ?? null,
    valid_to: (e.valid_to as string | null) ?? null, intro_permission: !!e.intro_permission, mine: e.from_user_id === me,
    consents: ((cs ?? []) as Row[]).filter((c) => c.edge_id === e.id).map((c) => ({ ...c, active: consentIsActive(c as unknown as ConsentLite, today) })),
  }));
}

const IntroSchema = z.object({ subject: z.string(), body: z.string() });

/**
 * Draft (never send) a message asking the introducer for an introduction. Requires an ACTIVE introduction consent on the
 * introducer → target edge. Content: names and the target's current employer only — no deal context from any company.
 */
export async function draftIntroRequest(db: Db, workspaceId: string, input: { edgeId: string; userId: string; ai?: AiCall }) {
  const today = isoDate(new Date())!;
  const { data: edge, error } = await db.from("relationship_edge").select("id, from_person_id, from_user_id, to_person_id").eq("workspace_id", workspaceId).eq("id", input.edgeId).is("archived_at", null).maybeSingle();
  if (error) throw error;
  if (!edge) throw new RelationshipError("Relationship not found.");
  if (!edge.from_person_id) throw new RelationshipError("Introductions through a colleague are arranged internally — no draft is created.");
  const { data: cs } = await db.from("introduction_consent").select("given_on, expires_on, revoked_at").eq("workspace_id", workspaceId).eq("edge_id", edge.id).is("archived_at", null);
  if (!(cs ?? []).some((c) => consentIsActive(c as ConsentLite, today))) {
    throw new IntroConsentRequiredError("Record the introducer's consent first — no introduction draft is suggested without it.");
  }
  const names = await nameMap(db, workspaceId, "person", [String(edge.from_person_id), String(edge.to_person_id)]);
  const { data: emp } = await db.from("employment").select("org_id, title").eq("workspace_id", workspaceId).eq("person_id", edge.to_person_id).eq("is_current", true).limit(1).maybeSingle();
  const orgName = emp?.org_id ? (await nameMap(db, workspaceId, "organisation", [String(emp.org_id)])).get(String(emp.org_id)) ?? null : null;
  const introducer = names.get(String(edge.from_person_id)) ?? "there";
  const target = names.get(String(edge.to_person_id)) ?? "your contact";
  const first = introducer.split(/\s+/)[0];
  const mock = () => ({
    subject: `Introduction to ${target}`,
    body: `Hi ${first},\n\nThank you again for offering to introduce me to ${target}${orgName ? ` at ${orgName}` : ""}. Whenever convenient, a short note connecting us would be much appreciated — I'm happy to send a two-line blurb you can forward.\n\nBest,`,
  });
  let draft = mock();
  try {
    const res = await (input.ai ?? (callStructured as AiCall))({
      workspaceId, workflow: "network.intro_request", tier: "luna", classification: "permitted_personal",
      system: "Write a short, courteous note asking a contact (who has already agreed) to make an introduction. No deal details, prices or confidential information about any company. No invented facts.",
      input: `Introducer first name: ${first}\nPerson to be introduced to: ${target}\nTheir employer: ${orgName ?? "unknown"}`, schema: IntroSchema, schemaName: "intro_request", maxOutputTokens: 400, mock,
    });
    draft = res.data;
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e;
  }
  return createDraft(db, workspaceId, {
    channel: "introduction", recipientPersonId: String(edge.from_person_id), recipientDisplay: introducer, subject: draft.subject, body: draft.body,
    orgId: (emp?.org_id as string | null) ?? null, purpose: "intro_request", createdByKind: "model", ownerUserId: input.userId,
  });
}

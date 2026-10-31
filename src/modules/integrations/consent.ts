import "server-only";
import type { Db } from "@/lib/supabase/server";
import { contactValueHash, discardDraft, setDraftPaused } from "@/lib/services/drafts";
import { cancelEnrollment, pauseForPerson, type PauseReason } from "./sequences";

/**
 * Consent & rights operations (spec §8 "Consent and rights ops"): suppression, correction, revocation and deletion
 * propagation. Suppression tombstones store only a hash of the address so they survive erasure and keep blocking
 * re-imports. Every operation also parks unsent drafts and pauses outreach for the person.
 */
export type MethodType = "email" | "phone" | "whatsapp" | "linkedin" | "other";
export type SuppressReason = "opt_out" | "erasure" | "wrong_contact" | "legal" | "other";

const UNSENT = ["drafted", "approved", "opened_for_send"];

export function guessMethodType(value: string): MethodType {
  const v = value.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  if (v.includes("linkedin.com/")) return "linkedin";
  if (/^\+?[\d\s()-]{8,}$/.test(v)) return "phone";
  return "other";
}

async function upsertTombstone(db: Db, ws: string, t: { valueHash: string; methodType: MethodType; reason: SuppressReason; personId?: string | null; note?: string | null; ownerUserId?: string | null }) {
  const { data: existing } = await db.from("suppression_tombstone").select("id").eq("workspace_id", ws).eq("method_type", t.methodType).eq("value_hash", t.valueHash).maybeSingle();
  if (existing) return existing.id as string;
  const { data, error } = await db.from("suppression_tombstone").insert({
    workspace_id: ws, value_hash: t.valueHash, method_type: t.methodType, reason: t.reason, person_id: t.personId ?? null, note: t.note ?? null,
    classification: "permitted_personal", owner_user_id: t.ownerUserId ?? null,
  }).select("id").single();
  if (error && error.code !== "23505") throw error;
  return (data?.id as string | undefined) ?? null;
}

/** Park unsent drafts addressed to a person or an address hash. Returns ids paused. */
export async function pauseDraftsFor(db: Db, ws: string, q: { personId?: string | null; address?: string | null }, reason: string, actorUserId?: string | null) {
  const ids = new Set<string>();
  if (q.personId) {
    const { data } = await db.from("draft").select("id").eq("workspace_id", ws).eq("recipient_person_id", q.personId).in("state", UNSENT);
    for (const d of data ?? []) ids.add(d.id);
  }
  if (q.address) {
    const { data } = await db.from("draft").select("id, recipient_address").eq("workspace_id", ws).ilike("recipient_address", q.address.trim()).in("state", UNSENT);
    for (const d of data ?? []) ids.add(d.id);
  }
  for (const id of ids) await setDraftPaused(db, ws, id, true, reason, actorUserId ?? null);
  return [...ids];
}

/**
 * Suppress an address (opt-out / legal / wrong contact). Idempotent.
 * Effects: tombstone; matching contact_method rows suppressed; consent_permission suppressed for the person;
 * live sequence enrollments paused; unsent drafts parked.
 */
export async function suppressContact(db: Db, ws: string, p: {
  address?: string | null; personId?: string | null; methodType?: MethodType; reason: SuppressReason; note?: string | null; actorUserId?: string | null; evidence?: string | null;
}) {
  const out = { tombstoneId: null as string | null, contactMethods: 0, enrollmentsPaused: [] as string[], draftsPaused: [] as string[] };
  let personId = p.personId ?? null;
  if (p.address && p.address.trim()) {
    const h = contactValueHash(p.address);
    const methodType = p.methodType ?? guessMethodType(p.address);
    const { data: cms } = await db.from("contact_method").select("id, person_id").eq("workspace_id", ws).eq("value_hash", h);
    personId = personId ?? cms?.[0]?.person_id ?? null;
    out.tombstoneId = await upsertTombstone(db, ws, { valueHash: h, methodType, reason: p.reason, personId, note: p.note, ownerUserId: p.actorUserId });
    if (cms?.length) {
      await db.from("contact_method").update({ suppressed: true }).eq("workspace_id", ws).eq("value_hash", h);
      out.contactMethods = cms.length;
    }
  }
  if (personId && (p.reason === "opt_out" || p.reason === "legal" || !p.address)) {
    const { data: existing } = await db.from("consent_permission").select("id").eq("workspace_id", ws).eq("person_id", personId).eq("purpose", "outreach").eq("suppressed", true).limit(1);
    if (!existing?.length) {
      await db.from("consent_permission").insert({
        workspace_id: ws, person_id: personId, purpose: "outreach", channel: null, suppressed: true, revoked_at: new Date().toISOString(),
        source_label: p.reason, evidence: p.evidence?.slice(0, 1000) ?? null, classification: "permitted_personal", owner_user_id: p.actorUserId ?? null,
      });
    }
  }
  const pauseReason: PauseReason = p.reason === "wrong_contact" ? "wrong_contact" : p.reason === "opt_out" ? "opt_out" : "suppressed";
  if (personId) out.enrollmentsPaused = await pauseForPerson(db, ws, personId, pauseReason);
  out.draftsPaused = await pauseDraftsFor(db, ws, { personId: p.reason === "wrong_contact" ? null : personId, address: p.address }, "suppressed", p.actorUserId);
  return out;
}

/** Revoke consent for a channel (null = all channels). Pauses outreach and parks drafts on that channel. */
export async function revokeConsent(db: Db, ws: string, p: { personId: string; channel?: string | null; evidence?: string | null; actorUserId?: string | null }) {
  const now = new Date().toISOString();
  await db.from("consent_permission").insert({
    workspace_id: ws, person_id: p.personId, purpose: "outreach", channel: p.channel ?? null, revoked_at: now, suppressed: false,
    source_label: "revocation", evidence: p.evidence ?? null, classification: "permitted_personal", owner_user_id: p.actorUserId ?? null,
  });
  const paused = await pauseForPerson(db, ws, p.personId, "opt_out");
  let q = db.from("draft").select("id").eq("workspace_id", ws).eq("recipient_person_id", p.personId).in("state", UNSENT);
  if (p.channel) q = q.eq("channel", p.channel);
  const { data } = await q;
  for (const d of data ?? []) await setDraftPaused(db, ws, d.id, true, "consent_revoked", p.actorUserId ?? null);
  return { enrollmentsPaused: paused, draftsPaused: (data ?? []).map((d) => d.id) };
}

/** Correct a wrong contact: old value is tombstoned (wrong_contact), new value added; drafts to the old address parked. */
export async function correctContact(db: Db, ws: string, p: { contactMethodId: string; newValue: string; actorUserId?: string | null }) {
  const { data: old, error } = await db.from("contact_method").select("*").eq("workspace_id", ws).eq("id", p.contactMethodId).single();
  if (error) throw error;
  await suppressContact(db, ws, { address: old.value, personId: old.person_id, methodType: old.method_type, reason: "wrong_contact", actorUserId: p.actorUserId });
  const { data: created, error: e2 } = await db.from("contact_method").insert({
    workspace_id: ws, person_id: old.person_id, method_type: old.method_type, value: p.newValue.trim(), preferred: old.preferred,
    classification: old.classification, owner_user_id: old.owner_user_id ?? p.actorUserId ?? null,
  }).select().single();
  if (e2) throw e2;
  return created;
}

/**
 * Erasure request: tombstone every contact value (hash only), discard unsent drafts, cancel enrollments,
 * redact stored message excerpts that matched the person, delete contact methods and blank the person record.
 * Tombstones keep blocking re-imports of the same address afterwards.
 */
export async function erasePerson(db: Db, ws: string, personId: string, actorUserId: string | null) {
  const { data: cms } = await db.from("contact_method").select("id, value, method_type").eq("workspace_id", ws).eq("person_id", personId);
  for (const c of cms ?? []) {
    await upsertTombstone(db, ws, { valueHash: contactValueHash(c.value), methodType: c.method_type, reason: "erasure", personId: null, ownerUserId: actorUserId });
  }
  const { data: drafts } = await db.from("draft").select("id").eq("workspace_id", ws).eq("recipient_person_id", personId).in("state", [...UNSENT, "paused"]);
  for (const d of drafts ?? []) await discardDraft(db, ws, d.id, actorUserId, "erasure");
  const { data: enr } = await db.from("sequence_enrollment").select("id").eq("workspace_id", ws).eq("person_id", personId).in("status", ["proposed", "active", "paused"]);
  for (const e of enr ?? []) await cancelEnrollment(db, ws, e.id, "opt_out");
  const { data: msgs } = await db.from("inbound_message").select("id").eq("workspace_id", ws).contains("matched_person_ids", [personId]);
  for (const m of msgs ?? []) {
    await db.from("inbound_message").update({ body_excerpt: null, subject: "[erased]", from_name: null, from_address: null, to_addresses: [], cc_addresses: [], triage: null })
      .eq("workspace_id", ws).eq("id", m.id);
  }
  await db.from("contact_method").delete().eq("workspace_id", ws).eq("person_id", personId);
  await db.from("person").update({ full_name: "Erased person", aliases: [], public_profile_url: null, personal_notes: null, contact_restrictions: "erased", archived_at: new Date().toISOString() })
    .eq("workspace_id", ws).eq("id", personId);
  return { tombstones: cms?.length ?? 0, draftsDiscarded: drafts?.length ?? 0, enrollmentsCancelled: enr?.length ?? 0, messagesRedacted: msgs?.length ?? 0 };
}

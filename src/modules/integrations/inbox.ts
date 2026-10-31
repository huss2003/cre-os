import "server-only";
import type { Db } from "@/lib/supabase/server";
import { callStructured } from "@/lib/ai/gateway";
import { sha256 } from "@/lib/util/crypto";
import { contactValueHash, createDraft, SuppressedRecipientError } from "@/lib/services/drafts";
import { createTask } from "@/lib/services/tasks";
import { decideUrgentAlert, urgentDedupeKey, type AlertPrefs } from "./alerts";
import { BACKFILL_AGE_HOURS } from "./config";
import { suppressContact } from "./consent";
import { parseEml } from "./eml";
import { cleanSubject, normaliseAddress, normaliseMessageId, sanitiseBody } from "./sanitize";
import { commitmentKey, commitmentTaskTitle, resolveDueDate } from "./commitments";
import { ensureInteractionLink, resolveLinks, type LinkResult } from "./links";
import { pauseForOrg, pauseForPerson } from "./sequences";
import { refreshThreadSummary } from "./threads";
import { enforceTriageSafety, mockTriage, TRIAGE_SYSTEM, TriageSchema, type Triage } from "./triage";
import { currentOrgForPerson, recordTouch } from "./touches";
import type { MailMessage } from "./types";

/**
 * Inbox ingestion + triage effects. Idempotent end to end: one inbound_message per (provider, message id) and per
 * Internet Message-ID across sources; one interaction / task / reply draft / alert per message (dedupe keys).
 * Backfilled history is logged but never alerts, drafts replies, creates tasks or pauses/re-triggers sequences.
 * Works with the service-role client in jobs (explicit workspace filters) or the user client for manual import.
 */
export type IngestProvider = "microsoft" | "google" | "manual" | "mock";

export interface InboundRow {
  id: string; workspace_id: string; provider: string; provider_message_id: string; internet_message_id: string | null;
  folder: "inbox" | "sent"; from_address: string | null; from_name: string | null; to_addresses: string[]; subject: string | null;
  received_at: string; body_excerpt: string | null; is_backfill: boolean; matched_person_ids: string[]; triage: Triage | null;
  triage_status: string; interaction_id: string | null; owner_user_id: string | null; import_method: string;
  thread_id?: string | null; matched_org_ids?: string[]; matched_opportunity_ids?: string[];
}

export function messageKey(m: Pick<InboundRow, "internet_message_id" | "provider" | "provider_message_id">) {
  return m.internet_message_id ?? `${m.provider}:${m.provider_message_id}`;
}

export function isBackfill(receivedAt: string, now: Date, firstSync: boolean) {
  return firstSync || now.getTime() - Date.parse(receivedAt) > BACKFILL_AGE_HOURS * 3_600_000;
}

/** Person ids whose (unsuppressed or suppressed) contact_method matches any of the addresses (by value_hash). */
export async function matchPersons(db: Db, ws: string, addresses: (string | null | undefined)[]) {
  const hashes = [...new Set(addresses.map((a) => normaliseAddress(a)).filter((a): a is string => !!a).map(contactValueHash))];
  if (!hashes.length) return [];
  const { data } = await db.from("contact_method").select("person_id").eq("workspace_id", ws).in("value_hash", hashes);
  return [...new Set((data ?? []).map((r) => r.person_id as string))];
}

export async function ingestMessage(db: Db, ws: string, p: {
  message: MailMessage; provider: IngestProvider; connectorAccountId?: string | null; importMethod: "sync" | "webhook" | "backfill" | "manual_import";
  backfill: boolean; ownerUserId: string | null;
}): Promise<{ row: InboundRow; inserted: boolean }> {
  const m = p.message;
  const imid = normaliseMessageId(m.internetMessageId);
  if (imid) {
    const { data: dup } = await db.from("inbound_message").select("*").eq("workspace_id", ws).eq("internet_message_id", imid).limit(1);
    if (dup?.[0]) return { row: dup[0] as InboundRow, inserted: false };
  }
  const { data: same } = await db.from("inbound_message").select("*").eq("workspace_id", ws).eq("provider", p.provider).eq("provider_message_id", m.id).maybeSingle();
  if (same) return { row: same as InboundRow, inserted: false };

  const from = normaliseAddress(m.from?.address);
  const to = m.to.map((a) => normaliseAddress(a.address)).filter((a): a is string => !!a);
  const cc = m.cc.map((a) => normaliseAddress(a.address)).filter((a): a is string => !!a);
  const matched = await matchPersons(db, ws, m.folder === "sent" ? [...to, ...cc] : [from]);
  const { data, error } = await db.from("inbound_message").insert({
    workspace_id: ws, connector_account_id: p.connectorAccountId ?? null, provider: p.provider, provider_message_id: m.id,
    internet_message_id: imid, thread_id: m.threadId, folder: m.folder, import_method: p.importMethod,
    from_address: from, from_name: m.from?.name ? cleanSubject(m.from.name) : null, to_addresses: to, cc_addresses: cc,
    subject: cleanSubject(m.subject), received_at: m.receivedAt, body_excerpt: sanitiseBody({ html: m.bodyHtml, text: m.bodyText }),
    attachments: m.attachments.map((a) => ({ name: cleanSubject(a.name), content_type: a.content_type, size: a.size })),
    is_backfill: p.backfill, matched_person_ids: matched, triage_status: m.folder === "sent" ? "skipped" : "pending",
    classification: "corporate_confidential", owner_user_id: p.ownerUserId,
  }).select().single();
  if (error) {
    if (error.code === "23505") {
      const { data: again } = await db.from("inbound_message").select("*").eq("workspace_id", ws).eq("provider", p.provider).eq("provider_message_id", m.id).single();
      return { row: again as InboundRow, inserted: false };
    }
    throw error;
  }
  return { row: data as InboundRow, inserted: true };
}

/** Run the (mock-able) model triage on sanitised evidence, then apply deterministic safety rules. */
export async function runTriage(ws: string, row: Pick<InboundRow, "from_name" | "from_address" | "subject" | "body_excerpt" | "received_at">): Promise<Triage> {
  const body = row.body_excerpt ?? "";
  const res = await callStructured({
    workspaceId: ws, workflow: "integrations.triage", tier: "luna", system: TRIAGE_SYSTEM,
    input: JSON.stringify({ from_name: row.from_name, from_domain: row.from_address?.split("@")[1] ?? null, received_at: row.received_at }),
    evidence: `Subject: ${row.subject ?? ""}\n\n${body}`,
    schema: TriageSchema, schemaName: "inbox_triage", maxOutputTokens: 900,
    mock: () => mockTriage({ fromName: row.from_name, subject: row.subject, body }),
  });
  return enforceTriageSafety(res.data, `${row.subject ?? ""}\n${body}`);
}

const ACTIONABLE = new Set(["near_term_visit", "commercial_decision", "expiring_offer", "critical_deadline", "new_requirement"]);
const MEANINGFUL = new Set([...ACTIONABLE, "reply", "wrong_contact", "opt_out"]);

export interface TriageEffects {
  interactionId: string | null; taskId: string | null; draftId: string | null; alert: string | null; suppressed: boolean; pausedEnrollments: string[];
  commitmentTaskIds: string[]; links: LinkResult | null; threadRefreshed: boolean;
}

/**
 * Apply triage effects for one inbox message. Each effect has its own dedupe key, so re-running is a no-op.
 * `alerts` (outbox) needs the service-role client; manual imports skip alerts (the user is already looking).
 */
export async function processMessage(db: Db, ws: string, row: InboundRow, opts: { now?: Date; tz?: string; allowAlerts?: boolean; threadQueue?: Set<string> } = {}): Promise<TriageEffects> {
  const out: TriageEffects = { interactionId: row.interaction_id, taskId: null, draftId: null, alert: null, suppressed: false, pausedEnrollments: [], commitmentTaskIds: [], links: null, threadRefreshed: false };
  if (row.folder !== "inbox" || row.triage_status === "skipped") return out;
  out.threadRefreshed = !!row.thread_id && !opts.threadQueue;
  try {
    return await applyEffects(db, ws, row, opts, out);
  } finally {
    // thread-level summary: rebuilt only when the thread's message set changed (sync batches per run)
    if (row.thread_id) {
      if (opts.threadQueue) opts.threadQueue.add(row.thread_id);
      else await refreshThreadSummary(db, ws, row.thread_id, { tz: opts.tz });
    }
  }
}

async function applyEffects(db: Db, ws: string, row: InboundRow, opts: { now?: Date; tz?: string; allowAlerts?: boolean }, out: TriageEffects): Promise<TriageEffects> {
  const key = messageKey(row);
  const triage = row.triage ?? (await runTriage(ws, row));
  if (!row.triage) {
    await db.from("inbound_message").update({ triage, triage_status: "triaged", triage_error: null }).eq("workspace_id", ws).eq("id", row.id);
  }
  const persons = row.matched_person_ids ?? [];
  const owner = row.owner_user_id;

  // 0. evidence-backed links to organisations / open opportunities (ambiguous => suggestion only, never linked)
  const links = triage.category === "suspicious" ? null : await resolveLinks(db, ws, { fromAddress: row.from_address, personIds: persons });
  out.links = links;
  if (links) {
    await db.from("inbound_message").update({ matched_org_ids: links.orgIds, matched_opportunity_ids: links.opportunityIds, link_evidence: links.evidence, link_suggestions: links.suggestions })
      .eq("workspace_id", ws).eq("id", row.id);
  }
  const orgIds = links?.orgIds ?? [];
  const oppIds = links?.opportunityIds ?? [];

  // 1. interaction (one per message; suspicious/newsletter mail from unknown senders is not logged as relationship activity)
  if (!out.interactionId && (persons.length > 0 || orgIds.length > 0 || MEANINGFUL.has(triage.category))) {
    const { data: existing } = await db.from("interaction").select("id").eq("workspace_id", ws).eq("source_message_id", key).limit(1);
    let id = existing?.[0]?.id as string | undefined;
    if (!id) {
      const { data: created, error } = await db.from("interaction").insert({
        workspace_id: ws, occurred_at: row.received_at, channel: "email", direction: "inbound", subject: row.subject, summary: triage.summary,
        source_message_id: key, is_meaningful: MEANINGFUL.has(triage.category) && persons.length > 0, classification: "corporate_confidential", owner_user_id: owner,
        opportunity_id: oppIds.length === 1 ? oppIds[0] : null,
      }).select("id").single();
      if (error) throw error;
      id = created.id as string;
      for (const pid of persons) {
        await db.from("interaction_link").insert({ workspace_id: ws, interaction_id: id, entity_type: "person", entity_id: pid, role: "from", owner_user_id: owner });
      }
    }
    out.interactionId = id;
    await db.from("inbound_message").update({ interaction_id: id }).eq("workspace_id", ws).eq("id", row.id);
  }
  if (out.interactionId) {
    for (const oid of orgIds) await ensureInteractionLink(db, ws, { interactionId: out.interactionId, entityType: "organisation", entityId: oid, role: "about", ownerUserId: owner });
    for (const pid of oppIds) await ensureInteractionLink(db, ws, { interactionId: out.interactionId, entityType: "opportunity", entityId: pid, role: "about", ownerUserId: owner });
  }
  for (const pid of persons) {
    await recordTouch(db, ws, { personId: pid, orgId: await currentOrgForPerson(db, ws, pid), userId: owner, channel: "email", kind: "inbound",
      at: row.received_at, interactionId: out.interactionId, dedupeKey: `inbound:${sha256(key).slice(0, 32)}:${pid}` });
  }

  // 2. consent: opt-out is honoured even for backfilled mail
  if (triage.category === "opt_out" && row.from_address) {
    await suppressContact(db, ws, { address: row.from_address, personId: persons[0] ?? null, methodType: "email", reason: "opt_out",
      evidence: `inbound message ${key}`, actorUserId: owner });
    out.suppressed = true;
  }
  if (row.is_backfill || triage.category === "suspicious") return out;

  // 3. a reply pauses outreach (only enrollments that started before the message). Contrary information
  //    (not interested / already moved / wrong timing) is recorded as such and also pauses the account's other enrollments.
  if (triage.category !== "newsletter" && triage.category !== "opt_out") {
    const contrary = triage.contrary_info ?? null;
    const reason = triage.category === "wrong_contact" ? "wrong_contact" : contrary ? "contrary_info" : "reply";
    const detail = contrary ? `Reply from ${row.from_name ?? row.from_address ?? "contact"}: ${contrary.kind.replace(/_/g, " ")} — “${contrary.evidence.slice(0, 200)}”` : null;
    for (const pid of persons) {
      out.pausedEnrollments.push(...(await pauseForPerson(db, ws, pid, reason, row.received_at, detail)));
    }
    if (contrary) for (const oid of orgIds) out.pausedEnrollments.push(...(await pauseForOrg(db, ws, oid, "contrary_info", detail, row.received_at)));
  }
  // 4. next-action task
  if (ACTIONABLE.has(triage.category) && triage.next_actions[0]) {
    const t = await createTask(db, ws, {
      title: `${triage.next_actions[0]} — ${row.from_name ?? row.from_address ?? "email"}`.slice(0, 200),
      description: `${triage.summary}\n\nFrom email: ${row.subject ?? "(no subject)"}`, priority: triage.urgency === "high" ? 80 : 60,
      dueAt: new Date(Date.parse(row.received_at) + (triage.urgency === "high" ? 4 : 24) * 3_600_000).toISOString(),
      linkedEntityType: "inbound_message", linkedEntityId: row.id, source: "connector", idempotencyKey: `integrations.triage:${key}`, ownerUserId: owner,
    });
    out.taskId = t.id;
  }
  // 4b. structured deadlines / commitments => tasks (date resolved in code; unknown dates stay unknown). One task per
  //     commitment per thread, so duplicate notifications and quoted repeats never duplicate tasks.
  const commitments = (triage.commitments ?? []).map((c) => ({ ...c, due_date: resolveDueDate(c.due_text, row.received_at, opts.tz), task_id: null as string | null }));
  const sender = row.from_name ?? row.from_address ?? "sender";
  for (const c of commitments) {
    if (!(c.who === "adviser" || c.kind === "deadline" || (c.who === "sender" && c.due_date))) continue;
    const t = await createTask(db, ws, {
      title: commitmentTaskTitle(c, sender),
      description: `${c.kind === "deadline" ? "Deadline" : "Commitment"} from email “${row.subject ?? "(no subject)"}”.\nEvidence: “${c.evidence}”` +
        `${c.due_text ? `\nDate as written: “${c.due_text}”${c.due_date ? ` → ${c.due_date}` : " (could not be resolved to a date — check)"}` : "\nNo date given."}`,
      priority: c.kind === "deadline" ? 75 : 60, dueAt: c.due_date ? `${c.due_date}T18:00:00+05:30` : null,
      linkedEntityType: "inbound_message", linkedEntityId: row.id, source: "connector", ownerUserId: owner,
      idempotencyKey: `integrations.commitment:${sha256(row.thread_id ?? key).slice(0, 24)}:${sha256(commitmentKey(c)).slice(0, 24)}`,
    });
    c.task_id = t.id;
    out.commitmentTaskIds.push(t.id);
  }
  if (commitments.length) await db.from("inbound_message").update({ commitments }).eq("workspace_id", ws).eq("id", row.id);

  // 5. reply draft (never sent; suppressed senders get none)
  if (triage.draft_reply && row.from_address) {
    const seqKey = `reply:${sha256(key).slice(0, 40)}`;
    const { data: existing } = await db.from("draft").select("id").eq("workspace_id", ws).eq("sequence_key", seqKey).limit(1);
    if (existing?.[0]) out.draftId = existing[0].id;
    else {
      try {
        const subj = row.subject ? (/^re:/i.test(row.subject) ? row.subject : `Re: ${row.subject}`) : null;
        const d = await createDraft(db, ws, { channel: "email", recipientPersonId: persons[0] ?? null, recipientDisplay: row.from_name, recipientAddress: row.from_address,
          subject: subj, body: triage.draft_reply, purpose: `reply to inbound email (${triage.category})`, sequenceKey: seqKey, createdByKind: "model", ownerUserId: owner });
        out.draftId = d.id;
      } catch (e) {
        if (!(e instanceof SuppressedRecipientError)) throw e;
      }
    }
  }
  // 6. urgent private alert (opt-in, DND, never an automatic client response)
  if (opts.allowAlerts && owner) {
    const { data: pref } = await db.from("user_preference").select("prefs").eq("workspace_id", ws).eq("user_id", owner).maybeSingle();
    let activeOpportunity = false;
    if (persons.length) {
      const { data: st } = await db.from("stakeholder").select("requirement_id").eq("workspace_id", ws).in("person_id", persons);
      const reqIds = (st ?? []).map((s) => s.requirement_id);
      if (reqIds.length) {
        const { data: opp } = await db.from("opportunity").select("id").eq("workspace_id", ws).in("requirement_id", reqIds).eq("outcome", "open").limit(1);
        activeOpportunity = !!opp?.length;
      }
    }
    const decision = decideUrgentAlert({ category: triage.category, isBackfill: row.is_backfill, verifiedSender: persons.length > 0, activeOpportunity,
      prefs: (pref?.prefs ?? null) as AlertPrefs | null, now: opts.now ?? new Date(), tz: opts.tz ?? "Asia/Kolkata" });
    if (decision.alert) {
      const dedupe = urgentDedupeKey(row.internet_message_id, row.provider, row.provider_message_id);
      const { error } = await db.from("outbox").insert({ workspace_id: ws, user_id: owner, kind: "urgent_alert", dedupe_key: dedupe,
        payload: { inbound_message_id: row.id, category: triage.category, summary: triage.summary, deliver_after: decision.deliverAfter, reason: decision.reason } });
      if (!error || error.code === "23505") out.alert = dedupe;
    }
  }
  return out;
}

/** Manual selected-thread import (pasted/uploaded .eml) — the default Gmail path; user client, RLS applies. */
export async function importEml(db: Db, ws: string, raw: string, ownerUserId: string) {
  if (raw.length > 2_000_000) throw new Error("message too large (2 MB max)");
  const parsed = parseEml(raw, `eml:${sha256(raw).slice(0, 40)}`);
  const { row, inserted } = await ingestMessage(db, ws, { message: parsed, provider: "manual", importMethod: "manual_import", backfill: isBackfill(parsed.receivedAt, new Date(), false), ownerUserId });
  const effects = await processMessage(db, ws, row, { allowAlerts: false });
  return { id: row.id, inserted, effects };
}

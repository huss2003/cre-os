/**
 * Integrations acceptance tests against the local DB (spec Part III: Inbox replay, Prompt injection, Approval
 * invalidation, Calendar reschedule, plus suppression, sequence pause, token round trip and revoked token).
 * Runs in a private throwaway workspace (deleted afterwards) so connector rows and the kill switch never touch WS1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, tag, userClient, USERS } from "../../../tests/helpers";
import {
  approveDraft, createDraft, DraftConflictError, DraftStateError, getDraft, markDraftSent, openDraftForSend, SuppressedRecipientError, updateDraft,
} from "@/lib/services/drafts";
import { sealTokens, getValidAccessToken, type ConnectorAccountRow } from "./tokens";
import { MockAdapter, defaultMockFixtures } from "./providers/mock";
import { syncResource } from "./sync";
import { ingestMessage, importEml, processMessage } from "./inbox";
import { upsertCalendarEvent } from "./calendar";
import { suppressContact, erasePerson } from "./consent";
import { activateEnrollment, proposeEnrollment } from "./sequences";
import { completeOAuth, OAuthError, startOAuth } from "./oauth";
import { ProviderAuthError, type CalendarEventItem } from "./types";

type Db = SupabaseClient<any, any, any>;
const admin = adminClient();
let ws = "";
let colleague: Db;
let owner: Db;
const people: Record<string, string> = {};

async function person(name: string, email: string) {
  const { data, error } = await admin.from("person").insert({ workspace_id: ws, full_name: name, classification: "permitted_personal", owner_user_id: USERS.colleague.id }).select("id").single();
  if (error) throw error;
  const { error: e2 } = await admin.from("contact_method").insert({ workspace_id: ws, person_id: data.id, method_type: "email", value: email, classification: "permitted_personal", owner_user_id: USERS.colleague.id });
  if (e2) throw e2;
  return data.id as string;
}

async function account(user: "owner" | "colleague", provider: "microsoft" | "google", patch: Record<string, unknown> = {}): Promise<ConnectorAccountRow> {
  const { data, error } = await admin.from("connector_account").upsert({ workspace_id: ws, user_id: USERS[user].id, provider, status: "mock", scopes: [], ...patch },
    { onConflict: "workspace_id,user_id,provider" }).select("*").single();
  if (error) throw error;
  return data as ConnectorAccountRow;
}

const count = async (table: string, f: (q: any) => any = (q) => q) => {
  const { count: n, error } = await f(admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ws));
  if (error) throw error;
  return n ?? 0;
};

beforeAll(async () => {
  const slug = tag("integ-test");
  const { data, error } = await admin.from("workspace").insert({ name: `Integrations ${slug}`, slug }).select("id").single();
  if (error) throw error;
  ws = data.id;
  const all = ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"];
  await admin.from("membership").insert([
    { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true, allowed_classifications: all, display_name: "Owner" },
    { workspace_id: ws, user_id: USERS.colleague.id, role: "editor", see_all_accounts: true, allowed_classifications: all, display_name: "Colleague" },
  ]);
  colleague = await userClient("colleague");
  owner = await userClient("owner");
  people.priya = await person("Priya Shah", "priya.shah@example-occupier.in");
  people.anita = await person("Anita K", "anita.k@example-bank.in");
  people.rahul = await person("Rahul Mehta", "rahul.mehta@example-gcc.com");
});

afterAll(async () => {
  if (ws) await admin.from("workspace").delete().eq("id", ws);
});

describe("inbox sync: replay, injection, opt-out", () => {
  it("re-running sync (incl. a full re-sync after cursor loss) never duplicates messages, interactions, tasks or drafts", async () => {
    const acc = await account("colleague", "microsoft");
    const adapter = new MockAdapter("microsoft");
    const first = await syncResource(admin, acc, "inbox", { adapter });
    expect(first.status).toBe("ok");
    expect(first.counts.inserted).toBe(6);
    const snapshot = async () => ({
      messages: await count("inbound_message"), interactions: await count("interaction"), tasks: await count("task"),
      drafts: await count("draft", (q) => q.like("sequence_key", "reply:%")), touches: await count("account_touch"),
    });
    const before = await snapshot();
    expect(before.drafts).toBeGreaterThanOrEqual(2);       // visit request + requirement get reply drafts
    const again = await syncResource(admin, acc, "inbox", { adapter });
    expect(again.counts.seen).toBe(0);                      // same-day cursor => nothing new
    await admin.from("connector_cursor").delete().eq("workspace_id", ws).eq("connector_account_id", acc.id);
    const resync = await syncResource(admin, acc, "inbox", { adapter });
    expect(resync).toMatchObject({ status: "ok", fullResync: true });
    expect(resync.counts.inserted).toBe(0);
    // the same message arriving through manual import (same Message-ID) is also deduplicated
    const m = defaultMockFixtures("microsoft").messages[0];
    const eml = `From: "Priya Shah" <${m.from!.address}>\r\nTo: me@example.com\r\nSubject: ${m.subject}\r\nMessage-ID: ${m.internetMessageId}\r\nDate: ${new Date(m.receivedAt).toUTCString()}\r\n\r\n${m.bodyText}`;
    const imp = await importEml(colleague, ws, eml, USERS.colleague.id);
    expect(imp.inserted).toBe(false);
    expect(await snapshot()).toEqual(before);
    // one interaction per message key
    const { data: ints } = await admin.from("interaction").select("source_message_id").eq("workspace_id", ws);
    expect(new Set(ints!.map((i) => i.source_message_id)).size).toBe(ints!.length);
  });

  it("backfilled history is logged but creates no task, draft or sequence change", async () => {
    const { data } = await admin.from("inbound_message").select("id, is_backfill, interaction_id").eq("workspace_id", ws).eq("provider_message_id", "mock-ms-msg-006").single();
    expect(data!.is_backfill).toBe(true);
    expect(data!.interaction_id).not.toBeNull();
    expect(await count("task", (q) => q.eq("linked_entity_id", data!.id))).toBe(0);
  });

  it("prompt injection: sanitised, flagged, and nothing is acted on", async () => {
    const { data } = await admin.from("inbound_message").select("id, body_excerpt, triage, interaction_id").eq("workspace_id", ws).eq("provider_message_id", "mock-ms-msg-003").single();
    expect(data!.body_excerpt).not.toMatch(/<script|javascript:|onclick/i);
    expect(data!.triage).toMatchObject({ category: "suspicious", injection_suspected: true, draft_reply: null });
    expect(await count("task", (q) => q.eq("linked_entity_id", data!.id))).toBe(0);
    expect(await count("draft", (q) => q.eq("recipient_address", "it-support@unknown-domain.biz"))).toBe(0);
    const { data: mem } = await admin.from("membership").select("user_id, role").eq("workspace_id", ws).order("role");
    expect(mem).toHaveLength(2);
    expect(await count("outbox")).toBe(0);
  });

  it("an opt-out reply suppresses the address (tombstone + contact) and blocks new drafts", async () => {
    expect(await count("suppression_tombstone", (q) => q.eq("reason", "opt_out"))).toBe(1);
    const { data: cm } = await admin.from("contact_method").select("suppressed").eq("workspace_id", ws).eq("person_id", people.anita).single();
    expect(cm!.suppressed).toBe(true);
    await expect(createDraft(colleague, ws, { channel: "email", recipientAddress: "Anita.K@example-bank.in", body: "Hello", ownerUserId: USERS.colleague.id }))
      .rejects.toBeInstanceOf(SuppressedRecipientError);
  });
});

describe("draft approval binding (service + DB)", () => {
  it("edits invalidate approval; stale reviews conflict; only approved content can be opened and marked sent", async () => {
    const d = await createDraft(colleague, ws, { channel: "email", recipientAddress: "rahul.mehta@example-gcc.com", subject: "Options", body: "Draft v1", ownerUserId: USERS.colleague.id });
    const a = await approveDraft(colleague, ws, d.id, USERS.colleague.id, { reviewedHash: d.content_hash });
    expect(a).toMatchObject({ state: "approved", approved_hash: d.content_hash, approved_by: USERS.colleague.id });
    const e = await updateDraft(colleague, ws, d.id, { body: "Draft v2" }, { actorUserId: USERS.colleague.id });
    expect(e.approvalInvalidated).toBe(true);
    expect(e.draft).toMatchObject({ state: "drafted", approved_hash: null });
    await expect(openDraftForSend(colleague, ws, d.id, USERS.colleague.id)).rejects.toBeInstanceOf(DraftStateError);
    await expect(markDraftSent(colleague, ws, d.id, USERS.colleague.id)).rejects.toBeInstanceOf(DraftStateError);
    await expect(approveDraft(colleague, ws, d.id, USERS.colleague.id, { reviewedHash: d.content_hash })).rejects.toBeInstanceOf(DraftConflictError);
    await approveDraft(colleague, ws, d.id, USERS.colleague.id, { reviewedHash: e.draft.content_hash });
    const opened = await openDraftForSend(colleague, ws, d.id, USERS.colleague.id);
    expect(opened.draft.state).toBe("opened_for_send");
    expect(opened.href).toMatch(/^mailto:rahul\.mehta@example-gcc\.com\?subject=Options&body=Draft%20v2$/);
    const sent = await markDraftSent(colleague, ws, d.id, USERS.colleague.id);
    expect(sent.draft).toMatchObject({ state: "marked_sent", sent_evidence: "user_assertion" });
    const { data: ev } = await admin.from("draft_event").select("event").eq("workspace_id", ws).eq("draft_id", d.id).order("occurred_at");
    expect(ev!.map((x) => x.event)).toEqual(["drafted", "approved", "edited", "approval_invalidated", "approved", "opened_for_send", "marked_sent"]);
    const { data: appr } = await admin.from("approval").select("approved_hash").eq("workspace_id", ws).eq("subject_id", d.id);
    expect(appr!.map((x) => x.approved_hash).sort()).toEqual([d.content_hash, e.draft.content_hash].sort());
  });

  it("a recipient suppressed after approval is caught at open-to-send (draft parked)", async () => {
    const d = await createDraft(colleague, ws, { channel: "email", recipientAddress: "late.optout@example.in", body: "Hello", ownerUserId: USERS.colleague.id });
    await approveDraft(colleague, ws, d.id, USERS.colleague.id, { reviewedHash: d.content_hash });
    // tombstone written directly (e.g. by another colleague's erasure) without parking this draft
    const { error } = await admin.from("suppression_tombstone").insert({ workspace_id: ws, value_hash: (await import("@/lib/services/drafts")).contactValueHash("late.optout@example.in"), method_type: "email", reason: "legal" });
    expect(error).toBeNull();
    await expect(openDraftForSend(colleague, ws, d.id, USERS.colleague.id)).rejects.toBeInstanceOf(SuppressedRecipientError);
    expect(await getDraft(colleague, ws, d.id)).toMatchObject({ state: "paused", pause_reason: "suppressed", approved_hash: null });
  });
});

describe("outreach sequences pause", () => {
  it("a reply from the person pauses their sequence and parks the step draft; consent erasure tombstones the address", async () => {
    const pid = await person("Meera Joshi", `meera.${tag("j")}@example-co.in`);
    const { data: cm } = await admin.from("contact_method").select("value").eq("person_id", pid).single();
    const r = await proposeEnrollment(colleague, ws, { personId: pid, userId: USERS.colleague.id, valueProposition: "a sourced note on Baner rents" });
    expect(r.draft?.sequence_step).toBe(1);
    await activateEnrollment(colleague, ws, r.enrollment.id);
    const { row } = await ingestMessage(admin, ws, { provider: "mock", importMethod: "sync", backfill: false, ownerUserId: USERS.colleague.id, message: {
      id: tag("reply"), internetMessageId: `<${tag("r")}@example-co.in>`, threadId: null, folder: "inbox", from: { address: cm!.value, name: "Meera Joshi" }, to: [], cc: [],
      subject: "Re: Pune office planning", receivedAt: new Date().toISOString(), bodyText: "Thanks, let's talk next month.", attachments: [] } });
    const fx = await processMessage(admin, ws, row);
    expect(fx.pausedEnrollments).toContain(r.enrollment.id);
    const { data: enr } = await admin.from("sequence_enrollment").select("status, pause_reason").eq("id", r.enrollment.id).single();
    expect(enr).toEqual({ status: "paused", pause_reason: "reply" });
    expect(await getDraft(admin, ws, r.draft!.id)).toMatchObject({ state: "paused" });
    const er = await erasePerson(owner, ws, pid, USERS.owner.id);
    expect(er.tombstones).toBe(1);
    await expect(createDraft(colleague, ws, { channel: "email", recipientAddress: cm!.value, body: "Hi again", ownerUserId: USERS.colleague.id })).rejects.toBeInstanceOf(SuppressedRecipientError);
  });

  it("suppressContact is idempotent", async () => {
    const a = await suppressContact(colleague, ws, { address: "x.idem@example.in", reason: "opt_out", actorUserId: USERS.colleague.id });
    const b = await suppressContact(colleague, ws, { address: "x.idem@example.in", reason: "opt_out", actorUserId: USERS.colleague.id });
    expect(b.tombstoneId).toBe(a.tombstoneId);
  });
});

describe("calendar reschedule / cancel", () => {
  const ev = (over: Partial<CalendarEventItem> = {}): CalendarEventItem => ({ id: "evt-r1", iCalUId: "ical-r1", title: "Site visit — Baner", start: "2026-11-05T05:30:00.000Z", end: "2026-11-05T06:30:00.000Z",
    timezone: "Asia/Kolkata", location: "Baner, Pune", organizer: "me@example.com", attendees: [], isCancelled: false, isOnline: false, changeKey: "ck1", ...over });
  it("upsert by external id; reschedule changes version_key; cancel marks cancelled; replays are no-ops", async () => {
    const geos = [{ name: "Baner", aliases: [] }];
    const p = { provider: "microsoft", connectorAccountId: null, ownerUserId: USERS.colleague.id, geos };
    const c1 = await upsertCalendarEvent(admin, ws, { ...p, item: ev() });
    expect(c1.change).toBe("created");
    expect((await upsertCalendarEvent(admin, ws, { ...p, item: ev() })).change).toBe("unchanged");
    const { data: v1 } = await admin.from("meeting_visit").select("version_key, kind, route_group").eq("id", c1.meetingVisitId!).single();
    expect(v1).toMatchObject({ kind: "site_visit", route_group: "2026-11-05:Baner" });
    const moved = await upsertCalendarEvent(admin, ws, { ...p, item: ev({ start: "2026-11-05T09:30:00.000Z", end: "2026-11-05T10:30:00.000Z", changeKey: "ck2" }) });
    expect(moved.change).toBe("rescheduled");
    const { data: v2 } = await admin.from("meeting_visit").select("version_key, start_at, calendar_event(previous_start_at, reschedule_count)").eq("id", c1.meetingVisitId!).single();
    expect(v2!.version_key).not.toBe(v1!.version_key);
    const ce = (Array.isArray(v2!.calendar_event) ? v2!.calendar_event[0] : v2!.calendar_event) as { previous_start_at: string; reschedule_count: number };
    expect(ce.reschedule_count).toBe(1);
    expect(Date.parse(ce.previous_start_at)).toBe(Date.parse("2026-11-05T05:30:00.000Z"));
    expect((await upsertCalendarEvent(admin, ws, { ...p, item: ev({ isCancelled: true, changeKey: "ck3" }) })).change).toBe("cancelled");
    expect((await upsertCalendarEvent(admin, ws, { ...p, item: ev({ removed: true, changeKey: "ck3" }) })).change).toBe("unchanged");
    const { data: v3 } = await admin.from("meeting_visit").select("status").eq("id", c1.meetingVisitId!).single();
    expect(v3!.status).toBe("cancelled");
    expect(await count("meeting_visit", (q) => q.eq("external_calendar_id", "evt-r1"))).toBe(1);
  });

  it("mock calendar sync is idempotent across a full re-sync", async () => {
    const acc = await account("colleague", "microsoft");
    const adapter = new MockAdapter("microsoft");
    const r1 = await syncResource(admin, acc, "calendar", { adapter });
    expect(r1.counts.created + r1.counts.cancelled).toBe(5);
    await admin.from("connector_cursor").delete().eq("workspace_id", ws).eq("connector_account_id", acc.id).eq("resource", "calendar");
    const r2 = await syncResource(admin, acc, "calendar", { adapter });
    expect(r2.counts.created).toBe(0);
    expect(await count("meeting_visit", (q) => q.like("external_calendar_id", "mock-ms-evt-%"))).toBe(5);
  });
});

describe("sent items reconciliation", () => {
  it("a matching Sent Items message upgrades the draft to reconciled_sent", async () => {
    const d = await createDraft(colleague, ws, { channel: "email", recipientAddress: "priya.shah@example-occupier.in", recipientPersonId: people.priya, subject: "Office options in Baner — shortlist", body: "Please find the shortlist attached.", ownerUserId: USERS.colleague.id });
    await approveDraft(colleague, ws, d.id, USERS.colleague.id, { reviewedHash: d.content_hash });
    await openDraftForSend(colleague, ws, d.id, USERS.colleague.id);
    const acc = await account("colleague", "microsoft");
    const fx = defaultMockFixtures("microsoft");
    const adapter = () => new MockAdapter("microsoft", { ...fx, sent: fx.sent.map((m) => ({ ...m, receivedAt: new Date(Date.now() + 1000).toISOString() })) });
    const r = await syncResource(admin, acc, "sent", { adapter: adapter() });
    expect(r.counts.reconciled).toBe(1);
    expect(await getDraft(admin, ws, d.id)).toMatchObject({ state: "reconciled_sent", sent_evidence: expect.stringMatching(/^sent_items:/) });
    // replay is a no-op
    await admin.from("connector_cursor").delete().eq("workspace_id", ws).eq("connector_account_id", acc.id).eq("resource", "sent");
    expect((await syncResource(admin, acc, "sent", { adapter: adapter() })).counts.reconciled).toBe(0);
  });
});

describe("tokens, revocation, OAuth state, kill switch", () => {
  const env = { MICROSOFT_CLIENT_ID: "test-client", MICROSOFT_CLIENT_SECRET: "test-secret", GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret" };
  const withEnv = async <T>(fn: () => Promise<T>) => {
    Object.assign(process.env, env);
    try { return await fn(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("expired access token refreshes and is stored encrypted (round trip)", async () => withEnv(async () => {
    const acc = await account("owner", "microsoft", { status: "connected", token_ciphertext: sealTokens({ access_token: "old", refresh_token: "rt-1", expires_at: new Date(Date.now() - 1000).toISOString() }) });
    const fetchImpl = async () => json(200, { access_token: "new-access", refresh_token: "rt-2", expires_in: 3600 });
    expect(await getValidAccessToken(admin, acc, fetchImpl)).toBe("new-access");
    const { data } = await admin.from("connector_account").select("token_ciphertext, status").eq("id", acc.id).single();
    expect(data!.token_ciphertext).not.toContain("new-access");
    const { openTokens } = await import("./tokens");
    expect(openTokens(data!.token_ciphertext)).toMatchObject({ access_token: "new-access", refresh_token: "rt-2" });
    expect(data!.status).toBe("connected");
  }));

  it("revoked refresh token flips the connector to revoked; sync reports auth_failed and marks the source stale", async () => withEnv(async () => {
    const acc = await account("owner", "microsoft", { status: "connected", token_ciphertext: sealTokens({ access_token: "a", refresh_token: "rt", expires_at: new Date(Date.now() - 1000).toISOString() }) });
    const fetchImpl = async () => json(400, { error: "invalid_grant", error_description: "AADSTS70000: The provided grant has been revoked." });
    await expect(getValidAccessToken(admin, acc, fetchImpl)).rejects.toBeInstanceOf(ProviderAuthError);
    const { data } = await admin.from("connector_account").select("*").eq("id", acc.id).single();
    expect(data!.status).toBe("revoked");
    const r = await syncResource(admin, data as ConnectorAccountRow, "inbox", { fetchImpl });
    expect(r.status).toBe("auth_failed");
    const { data: cur } = await admin.from("connector_cursor").select("last_error, last_success_at").eq("connector_account_id", acc.id).eq("resource", "inbox").single();
    expect(cur!.last_error).toMatch(/reconnect/);
  }));

  it("OAuth state is single-use and bound to the user who started it", async () => withEnv(async () => {
    const s = await startOAuth(admin, { provider: "google", userId: USERS.owner.id, workspaceId: ws });
    const state = new URL(s.url!).searchParams.get("state")!;
    const fetchImpl = async () => json(200, { access_token: "g-at", refresh_token: "g-rt", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" });
    await expect(completeOAuth(admin, { provider: "google", userId: USERS.colleague.id, state, code: "c", fetchImpl })).rejects.toMatchObject({ code: "wrong_user" });
    const ok = await completeOAuth(admin, { provider: "google", userId: USERS.owner.id, state, code: "c", fetchImpl });
    expect(ok.workspaceId).toBe(ws);
    await expect(completeOAuth(admin, { provider: "google", userId: USERS.owner.id, state, code: "c", fetchImpl })).rejects.toBeInstanceOf(OAuthError);
    const { data } = await owner.from("connector_account").select("status, scopes").eq("id", ok.accountId).single();
    expect(data).toMatchObject({ status: "connected" });
    const { data: tok } = await owner.from("connector_account").select("token_ciphertext").eq("id", ok.accountId).maybeSingle();
    expect(tok).toBeNull(); // token column is not selectable by app users
  }));

  it("kill switch: paused workspace skips sync", async () => {
    await admin.from("workspace").update({ ai_paused: true }).eq("id", ws);
    try {
      const acc = await account("colleague", "microsoft");
      const r = await syncResource(admin, acc, "inbox", { adapter: new MockAdapter("microsoft") });
      expect(r.status).toBe("paused");
    } finally {
      await admin.from("workspace").update({ ai_paused: false }).eq("id", ws);
    }
  });
});

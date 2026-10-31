/**
 * Round 2 acceptance tests against the local DB (workflows 04 Inbox Triage, 13 Outreach Editor, 14 Calendar and Visits).
 * Private throwaway workspace (deleted afterwards) so connector rows, outbox alerts and jobs never touch WS1/WS2.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { adminClient, tag, userClient, USERS } from "../../../tests/helpers";
import { approveDraft, getDraft, markDraftSent, openDraftForSend } from "@/lib/services/drafts";
import { sha256 } from "@/lib/util/crypto";
import { createPlannedVisit, detectConflictsAndNotify, saveVisitFeedback, setChecklistItem, updatePlannedVisit, upsertCalendarEvent, VisitInputError } from "./calendar";
import { ingestMessage, processMessage } from "./inbox";
import { MockAdapter } from "./providers/mock";
import { ensureGraphSubscription, handleGmailPush, handleGraphNotifications, type EnqueueFn } from "./push";
import { ActiveNegotiationError, activateEnrollment, onSequenceDraftSent, proposeEnrollment, sequenceTick } from "./sequences";
import { syncResource } from "./sync";
import { sealTokens, type ConnectorAccountRow } from "./tokens";
import type { MailMessage } from "./types";

type Db = SupabaseClient<any, any, any>;
const admin = adminClient();
let ws = "";
let colleague: Db;
const C = USERS.colleague.id;

const ins = async (table: string, row: Record<string, unknown>) => {
  const { data, error } = await admin.from(table).insert({ workspace_id: ws, owner_user_id: C, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
};
async function person(name: string, email: string, extra: { whatsapp?: string } = {}) {
  const id = await ins("person", { full_name: name, classification: "permitted_personal" });
  await ins("contact_method", { person_id: id, method_type: "email", value: email, classification: "permitted_personal" });
  if (extra.whatsapp) await ins("contact_method", { person_id: id, method_type: "whatsapp", value: extra.whatsapp, classification: "permitted_personal" });
  return id;
}
const count = async (table: string, f: (q: any) => any = (q) => q) => {
  const { count: n, error } = await f(admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ws));
  if (error) throw error;
  return n ?? 0;
};
const msg = (over: Partial<MailMessage> & { from: { address: string; name?: string } }): MailMessage => ({
  id: tag("m"), internetMessageId: `<${tag("id")}@example.in>`, threadId: null, folder: "inbox", to: [], cc: [], subject: "Hello", receivedAt: new Date().toISOString(),
  bodyText: "Thanks.", attachments: [], ...over,
});
const deliver = async (m: MailMessage) => {
  const { row, inserted } = await ingestMessage(admin, ws, { message: m, provider: "mock", importMethod: "sync", backfill: false, ownerUserId: C });
  return { row, inserted, fx: await processMessage(admin, ws, row) };
};

beforeAll(async () => {
  const slug = tag("integ-r2");
  const { data, error } = await admin.from("workspace").insert({ name: `Integrations R2 ${slug}`, slug }).select("id").single();
  if (error) throw error;
  ws = data.id;
  const all = ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"];
  await admin.from("membership").insert([
    { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true, allowed_classifications: all, display_name: "Owner" },
    { workspace_id: ws, user_id: C, role: "editor", see_all_accounts: true, allowed_classifications: all, display_name: "Colleague" },
  ]);
  colleague = await userClient("colleague");
});

afterAll(async () => {
  if (ws) await admin.from("workspace").delete().eq("id", ws);
});

// ======================================================================================== 04 Inbox Triage
describe("04 inbox triage: threads, links, commitments", () => {
  it("thread summary covers the whole thread and is refreshed when a new message arrives (replay = no change)", async () => {
    const thread = tag("thr");
    const pid = await person("Kavya Rao", `kavya.${tag("k")}@thread-co.in`);
    const { data: cm } = await admin.from("contact_method").select("value").eq("person_id", pid).single();
    const first = await deliver(msg({ threadId: thread, from: { address: cm!.value, name: "Kavya Rao" }, subject: "Baner options", bodyText: "We are looking for 20,000 sq ft in Baner." }));
    expect(first.fx.threadRefreshed).toBe(true);
    const { data: t1 } = await admin.from("inbound_thread").select("id, message_count, summary, basis_hash, summarised_at").eq("workspace_id", ws).eq("thread_key", thread).single();
    expect(t1).toMatchObject({ message_count: 1 });
    expect(t1!.summary).toMatch(/1 message with Kavya Rao/);
    await deliver(msg({ threadId: thread, from: { address: cm!.value, name: "Kavya Rao" }, subject: "Re: Baner options", bodyText: "Can we do a site visit tomorrow?",
      receivedAt: new Date(Date.now() + 60_000).toISOString() }));
    const { data: t2 } = await admin.from("inbound_thread").select("id, message_count, summary, basis_hash, summarised_at, latest_category").eq("workspace_id", ws).eq("thread_key", thread).single();
    expect(t2).toMatchObject({ id: t1!.id, message_count: 2, latest_category: "near_term_visit" });
    expect(t2!.basis_hash).not.toBe(t1!.basis_hash);
    expect(t2!.summary).toMatch(/2 messages/);
    // replaying the same message is a no-op for the thread
    const { data: row } = await admin.from("inbound_message").select("*").eq("workspace_id", ws).eq("thread_id", thread).order("received_at", { ascending: false }).limit(1).single();
    await processMessage(admin, ws, row);
    const { data: t3 } = await admin.from("inbound_thread").select("summarised_at, row_version").eq("id", t1!.id).single();
    expect(t3!.summarised_at).toBe(t2!.summarised_at);
    expect(await count("inbound_thread", (q) => q.eq("thread_key", thread))).toBe(1);
  });

  it("links a message to the organisation and open opportunity when evidence supports it (employment + domain + stakeholder)", async () => {
    const domain = `${tag("acme")}.example.com`;
    const org = await ins("organisation", { display_name: "Acme GCC", domain });
    const pid = await person("Arjun Nair", `arjun@${domain}`);
    await ins("employment", { person_id: pid, org_id: org, title: "Head of Real Estate" });
    const req = await ins("requirement", { org_id: org, title: "Acme Pune HQ" });
    await ins("stakeholder", { requirement_id: req, person_id: pid, role: "sponsor" });
    const opp = await ins("opportunity", { org_id: org, requirement_id: req, name: "Acme Pune HQ 2027", stage: "options_visits", outcome: "open" });
    await ins("opportunity", { org_id: org, name: "Acme Hinjewadi expansion", stage: "research", outcome: "open" }); // org has two open opps
    const { row, fx } = await deliver(msg({ from: { address: `arjun@${domain}`, name: "Arjun Nair" }, subject: "Shortlist", bodyText: "Please share the shortlist." }));
    expect(fx.links).toMatchObject({ orgIds: [org], opportunityIds: [opp] });
    const { data: m } = await admin.from("inbound_message").select("matched_org_ids, matched_opportunity_ids, link_evidence").eq("id", row.id).single();
    expect(m!.matched_org_ids).toEqual([org]);
    expect((m!.link_evidence as { basis: string }[]).map((e) => e.basis).sort()).toEqual(["email_domain", "employment", "stakeholder"]);
    const { data: links } = await admin.from("interaction_link").select("entity_type, entity_id").eq("workspace_id", ws).eq("interaction_id", fx.interactionId!);
    expect(links).toEqual(expect.arrayContaining([{ entity_type: "organisation", entity_id: org }, { entity_type: "opportunity", entity_id: opp }]));
    const { data: it } = await admin.from("interaction").select("opportunity_id").eq("id", fx.interactionId!).single();
    expect(it!.opportunity_id).toBe(opp);
    // re-processing does not duplicate links
    await processMessage(admin, ws, { ...row, interaction_id: fx.interactionId });
    expect(await count("interaction_link", (q) => q.eq("interaction_id", fx.interactionId!).eq("entity_type", "organisation"))).toBe(1);
  });

  it("ambiguous evidence (two organisations share the sender domain) links nothing and leaves suggestions", async () => {
    const domain = `${tag("shared")}.example.com`;
    await ins("organisation", { display_name: "Shared One", domain });
    await ins("organisation", { display_name: "Shared Two", domain });
    const { row, fx } = await deliver(msg({ from: { address: `someone@${domain}` }, subject: "Office space", bodyText: "We need 300 seats in Kharadi." }));
    expect(fx.links!.orgIds).toEqual([]);
    const { data: m } = await admin.from("inbound_message").select("matched_org_ids, link_suggestions").eq("id", row.id).single();
    expect(m!.matched_org_ids).toEqual([]);
    expect((m!.link_suggestions as { label: string }[]).map((s) => s.label).sort()).toEqual(["Shared One", "Shared Two"]);
  });

  it("structured deadlines/commitments become tasks with code-resolved dates; duplicate events do not duplicate tasks", async () => {
    const thread = tag("thr-c");
    const m = msg({ threadId: thread, from: { address: "meena@commit-co.in", name: "Meena Iyer" }, subject: "Next steps", receivedAt: "2026-11-03T05:00:00.000Z",
      bodyText: "Please send the revised commercials by 15 Nov. I will share our headcount plan by Friday. The LOI offer expires on 20/11." });
    const { ingestMessage: ingest } = await import("./inbox");
    const { row } = await ingest(admin, ws, { message: m, provider: "mock", importMethod: "sync", backfill: false, ownerUserId: C });
    const fx = await processMessage(admin, ws, row);
    expect(fx.commitmentTaskIds).toHaveLength(3);
    const { data: tasks } = await admin.from("task").select("title, due_at").eq("workspace_id", ws).in("id", fx.commitmentTaskIds);
    const due = Object.fromEntries(tasks!.map((t) => [t.title.slice(0, 12), t.due_at?.slice(0, 10)]));
    expect(Object.values(due).sort()).toEqual(["2026-11-06", "2026-11-15", "2026-11-20"]);
    expect(tasks!.some((t) => /^Expect from Meena Iyer/.test(t.title))).toBe(true);
    // the same notification again (same provider id), the same message via another source (same Message-ID), and a re-run
    await ingest(admin, ws, { message: m, provider: "mock", importMethod: "webhook", backfill: false, ownerUserId: C });
    const viaOther = await ingest(admin, ws, { message: { ...m, id: tag("other") }, provider: "microsoft", importMethod: "sync", backfill: false, ownerUserId: C });
    expect(viaOther.inserted).toBe(false);
    await processMessage(admin, ws, { ...row, triage_status: "pending" });
    expect(await count("task", (q) => q.like("idempotency_key", "integrations.commitment:%").eq("linked_entity_id", row.id))).toBe(3);
    const { data: stored } = await admin.from("inbound_message").select("commitments").eq("id", row.id).single();
    expect((stored!.commitments as { due_date: string | null }[]).map((c) => c.due_date).sort()).toEqual(["2026-11-06", "2026-11-15", "2026-11-20"]);
  });
});

describe("04 push sync: Graph change notifications and Gmail Pub/Sub push", () => {
  let acc: ConnectorAccountRow;
  const fakeEnqueue = () => {
    const calls: Parameters<EnqueueFn>[0][] = [];
    const keys = new Map<string, string>();
    const fn: EnqueueFn = async (o) => { calls.push(o); const k = o.dedupeKey ?? crypto.randomUUID(); if (!keys.has(k)) keys.set(k, crypto.randomUUID()); return keys.get(k)!; };
    return { fn, calls, jobs: keys };
  };

  beforeAll(async () => {
    const { data, error } = await admin.from("connector_account").upsert({ workspace_id: ws, user_id: C, provider: "microsoft", status: "connected", scopes: [], account_email: `colleague.${tag("e")}@example.com`,
      token_ciphertext: sealTokens({ access_token: "at-valid", refresh_token: "rt", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) },
      { onConflict: "workspace_id,user_id,provider" }).select("*").single();
    if (error) throw error;
    acc = data as ConnectorAccountRow;
  });

  it("subscription create stores only a hash of clientState; validation handshake echoes the token", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "sub-123", expirationDateTime: new Date(Date.now() + 72 * 3_600_000).toISOString() }), { status: 201 });
    };
    const r = await ensureGraphSubscription(admin, acc, "inbox", { fetchImpl });
    expect(r).toMatchObject({ action: "created", id: "sub-123" });
    expect(seen[0].url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    expect(seen[0].body).toMatchObject({ changeType: "created", resource: "me/mailFolders('inbox')/messages" });
    const secret = String(seen[0].body.clientState);
    const { data: sub } = await admin.from("push_subscription").select("external_id, client_state_hash, status").eq("connector_account_id", acc.id).eq("resource", "inbox").single();
    expect(sub).toMatchObject({ external_id: "sub-123", status: "active", client_state_hash: sha256(secret) });
    expect(JSON.stringify(sub)).not.toContain(secret);
    // still fresh => no call
    expect((await ensureGraphSubscription(admin, acc, "inbox", { fetchImpl: async () => { throw new Error("must not call"); } })).action).toBe("none");
    // Graph's validation request
    const { POST } = await import("@/app/api/webhooks/microsoft/route");
    const res = await POST(new NextRequest("http://localhost/api/webhooks/microsoft?validationToken=Validation%3A%20Testing", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("Validation: Testing");
    (globalThis as { __secret?: string }).__secret = secret;
  });

  it("duplicate notifications do not duplicate anything; a wrong clientState is rejected", async () => {
    const secret = (globalThis as { __secret?: string }).__secret!;
    const body = { value: [{ subscriptionId: "sub-123", clientState: secret, changeType: "created", resource: "Users/x/Messages/AAA", resourceData: { id: "AAA" } }] };
    const q = fakeEnqueue();
    const r1 = await handleGraphNotifications(admin, body, { enqueueFn: q.fn });
    const r2 = await handleGraphNotifications(admin, body, { enqueueFn: q.fn });
    expect(r1).toMatchObject({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(r2).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]).toMatchObject({ type: "integrations.inbox_sync", workspaceId: ws, payload: { account_id: acc.id } });
    expect(await count("webhook_receipt")).toBe(1);
    const bad = await handleGraphNotifications(admin, { value: [{ ...body.value[0], clientState: "forged", resourceData: { id: "ZZZ" } }] }, { enqueueFn: q.fn });
    expect(bad).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await count("webhook_receipt")).toBe(1);
    // the job it enqueues is the normal idempotent sync: running it twice (as a duplicate would) changes nothing
    const adapter = new MockAdapter("microsoft");
    await syncResource(admin, acc, "inbox", { adapter });
    const snap = async () => [await count("inbound_message"), await count("task"), await count("draft"), await count("interaction"), await count("inbound_thread")];
    const before = await snap();
    await admin.from("connector_cursor").delete().eq("workspace_id", ws).eq("connector_account_id", acc.id);
    await syncResource(admin, acc, "inbox", { adapter });
    expect(await snap()).toEqual(before);
  });

  it("Gmail push: bad token 403, unconfigured 503, duplicate Pub/Sub delivery is acknowledged without a second job", async () => {
    const { data: g } = await admin.from("connector_account").upsert({ workspace_id: ws, user_id: C, provider: "google", status: "connected", scopes: [], account_email: "Colleague.Push@Example.com" },
      { onConflict: "workspace_id,user_id,provider" }).select("*").single();
    const body = { message: { data: Buffer.from(JSON.stringify({ emailAddress: "colleague.push@example.com", historyId: 9876 })).toString("base64"), messageId: tag("pubsub") }, subscription: "projects/x/subscriptions/y" };
    const q = fakeEnqueue();
    delete process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
    expect((await handleGmailPush(admin, "anything", body, { enqueueFn: q.fn })).status).toBe(503);
    process.env.GMAIL_PUSH_VERIFICATION_TOKEN = "verify-me-123";
    try {
      expect((await handleGmailPush(admin, "wrong", body, { enqueueFn: q.fn })).status).toBe(403);
      expect(await handleGmailPush(admin, "verify-me-123", body, { enqueueFn: q.fn })).toMatchObject({ status: 204, accepted: 1 });
      expect(await handleGmailPush(admin, "verify-me-123", body, { enqueueFn: q.fn })).toMatchObject({ status: 204, accepted: 0, duplicates: 1 });
      expect(q.calls).toHaveLength(1);
      expect(q.calls[0]).toMatchObject({ type: "integrations.inbox_sync", payload: { account_id: g!.id } });
    } finally {
      delete process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
    }
  });
});

// ======================================================================================== 13 Outreach Editor
describe("13 outreach: contrary info, negotiation via organisation, WhatsApp channel", () => {
  it("a reply saying they already moved pauses the sequence as contrary_info with the reason recorded", async () => {
    const email = `nikhil.${tag("n")}@contrary-co.in`;
    const pid = await person("Nikhil Joshi", email);
    const r = await proposeEnrollment(colleague, ws, { personId: pid, userId: C, valueProposition: "a sourced note on Kharadi rents" });
    await activateEnrollment(colleague, ws, r.enrollment.id);
    const { fx } = await deliver(msg({ from: { address: email, name: "Nikhil Joshi" }, subject: "Re: Pune office planning", bodyText: "Thanks, but we have already signed the lease in Kharadi last month." }));
    expect(fx.pausedEnrollments).toContain(r.enrollment.id);
    const { data: e } = await admin.from("sequence_enrollment").select("status, pause_reason, pause_detail").eq("id", r.enrollment.id).single();
    expect(e).toMatchObject({ status: "paused", pause_reason: "contrary_info" });
    expect(e!.pause_detail).toMatch(/already moved .*signed the lease/);
  });

  it("a contradicting signal recorded for the target pauses the sequence at the next tick", async () => {
    const pid = await person("Sana Kapoor", `sana.${tag("s")}@signal-co.in`);
    const r = await proposeEnrollment(colleague, ws, { personId: pid, userId: C, valueProposition: "Baner options" });
    await activateEnrollment(colleague, ws, r.enrollment.id);
    await admin.from("sequence_enrollment").update({ next_due_at: new Date(Date.now() - 1000).toISOString() }).eq("id", r.enrollment.id);
    await ins("signal_claim", { subject_type: "person", subject_id: pid, claim_type: "job_move", predicate: "left the company", evidence_tier: "single_unverified", evidence_excerpt: "Moved to a new firm" });
    await sequenceTick(admin, ws);
    const { data: e } = await admin.from("sequence_enrollment").select("status, pause_reason, pause_detail").eq("id", r.enrollment.id).single();
    expect(e).toMatchObject({ status: "paused", pause_reason: "contrary_info" });
    expect(e!.pause_detail).toMatch(/job move/);
  });

  it("active negotiation on the person's organisation pauses even without opportunity_id; manual resume is refused", async () => {
    const org = await ins("organisation", { display_name: "Negotia Ltd" });
    const pid = await person("Vikram Shah", `vikram.${tag("v")}@negotia.in`);
    await ins("employment", { person_id: pid, org_id: org });
    const r = await proposeEnrollment(colleague, ws, { personId: pid, userId: C, valueProposition: "Hinjewadi options" });
    expect(r.enrollment.org_id).toBe(org);
    expect(r.enrollment.opportunity_id).toBeNull();
    await activateEnrollment(colleague, ws, r.enrollment.id);
    await ins("opportunity", { org_id: org, name: "Negotia campus", stage: "proposal_negotiation", outcome: "open" });
    await admin.from("sequence_enrollment").update({ next_due_at: new Date(Date.now() - 1000).toISOString() }).eq("id", r.enrollment.id);
    const out = await sequenceTick(admin, ws);
    expect(out.paused).toBeGreaterThanOrEqual(1);
    const { data: e } = await admin.from("sequence_enrollment").select("status, pause_reason, pause_detail").eq("id", r.enrollment.id).single();
    expect(e).toMatchObject({ status: "paused", pause_reason: "active_negotiation" });
    expect(e!.pause_detail).toMatch(/Negotia campus/);
    await expect(activateEnrollment(colleague, ws, r.enrollment.id)).rejects.toBeInstanceOf(ActiveNegotiationError);
  });

  it("WhatsApp step is a draft opened via wa.me by hand, and the WhatsApp cap defers a second touch", async () => {
    const pid = await person("Isha Menon", `isha.${tag("i")}@wa-co.in`, { whatsapp: "+91 98220 12345" });
    const r = await proposeEnrollment(colleague, ws, { personId: pid, userId: C, template: "whatsapp", valueProposition: "a 1-page Baner vs Balewadi comparison" });
    const { data: seq } = await admin.from("outreach_sequence").select("name").eq("id", r.enrollment.sequence_id).single();
    expect(seq!.name).toMatch(/WhatsApp/);
    // step 1 (email) approved, opened and marked sent by the user => step 2 is due
    const d1 = r.draft!;
    await approveDraft(colleague, ws, d1.id, C, { reviewedHash: d1.content_hash });
    await openDraftForSend(colleague, ws, d1.id, C);
    await markDraftSent(colleague, ws, d1.id, C);
    await activateEnrollment(colleague, ws, r.enrollment.id);
    await onSequenceDraftSent(admin, ws, { sequence_key: `enr:${r.enrollment.id}`, sequence_step: 1 }, new Date(Date.now() - 10 * 86_400_000));
    await sequenceTick(admin, ws);
    const { data: wa } = await admin.from("draft").select("*").eq("workspace_id", ws).eq("sequence_key", `enr:${r.enrollment.id}`).eq("sequence_step", 2).single();
    expect(wa).toMatchObject({ channel: "whatsapp", state: "drafted", recipient_address: "+91 98220 12345" });
    await approveDraft(colleague, ws, wa!.id, C, { reviewedHash: wa!.content_hash });
    const opened = await openDraftForSend(colleague, ws, wa!.id, C);
    expect(opened.href).toMatch(/^https:\/\/wa\.me\/919822012345\?text=/);
    expect((await getDraft(admin, ws, wa!.id)).state).toBe("opened_for_send"); // not sent until the user says so
    await markDraftSent(colleague, ws, wa!.id, C);
    // a second WhatsApp-step enrollment for the same person within 14 days is deferred by the cap (no draft)
    await admin.from("sequence_enrollment").update({ status: "completed" }).eq("id", r.enrollment.id);
    const r2 = await proposeEnrollment(colleague, ws, { personId: pid, userId: C, template: "whatsapp", valueProposition: "a second note", overrideCollision: true });
    expect(r2.existing).toBe(false);
    await admin.from("sequence_enrollment").update({ status: "active", current_step: 1, next_due_at: new Date(Date.now() - 1000).toISOString() }).eq("id", r2.enrollment.id);
    // isolate the channel cap from the weekly account cap: forget the email touch (this test's own row)
    await admin.from("account_touch").delete().eq("workspace_id", ws).eq("draft_id", d1.id);
    expect(await count("account_touch", (q) => q.eq("person_id", pid).eq("touch_kind", "sent"))).toBeLessThan(2);
    const { data: before } = await admin.from("sequence_enrollment").select("next_due_at").eq("id", r2.enrollment.id).single();
    const out = await sequenceTick(admin, ws);
    expect(out.deferred).toBeGreaterThanOrEqual(1);
    expect(await count("draft", (q) => q.eq("sequence_key", `enr:${r2.enrollment.id}`).eq("sequence_step", 2))).toBe(0);
    const { data: after } = await admin.from("sequence_enrollment").select("status, next_due_at").eq("id", r2.enrollment.id).single();
    expect(after!.status).toBe("active");
    expect(Date.parse(after!.next_due_at)).toBeGreaterThan(Date.parse(before!.next_due_at));
  });
});

// ======================================================================================== 14 Calendar and Visits
describe("14 calendar & visits", () => {
  let assetFar = "", assetNear = "";
  beforeAll(async () => {
    const loc = await ins("geography", { level: "locality", name: `Baner ${tag("g")}`, lat: 18.559, lon: 73.786 });
    assetNear = await ins("asset", { name: "Baner Business Bay", address: "Baner Road, Pune", lat: 18.559, lon: 73.786, locality_id: loc });
    assetFar = await ins("asset", { name: "Kharadi IT Park", address: "Kharadi, Pune", lat: 18.551, lon: 73.935 });
  });

  it("a planned visit created by hand links the building (coordinates, locality) and stays provisional until confirmed", async () => {
    const v = await createPlannedVisit(colleague, ws, { title: "Site visit — Baner Business Bay", kind: "site_visit", start: "2026-11-20T05:00:00Z", end: "2026-11-20T06:00:00Z", assetId: assetNear }, C);
    expect(v).toMatchObject({ provider: "manual", status: "provisional", linked_entity_type: "asset", linked_entity_id: assetNear, location: "Baner Business Bay, Baner Road, Pune" });
    expect(Number(v.lat)).toBeCloseTo(18.559);
    expect(v.route_group).toMatch(/^2026-11-20:Baner /);
    const c = await updatePlannedVisit(colleague, ws, v.id, { status: "confirmed" });
    expect(c.status).toBe("confirmed");
    const synced = await upsertCalendarEvent(admin, ws, { item: { id: tag("evt"), iCalUId: null, title: "Synced", start: "2026-11-21T05:00:00Z", end: "2026-11-21T06:00:00Z", timezone: "Asia/Kolkata",
      location: null, organizer: null, attendees: [], isCancelled: false, isOnline: false, changeKey: "1" }, provider: "microsoft", connectorAccountId: null, ownerUserId: C, geos: [] });
    await expect(updatePlannedVisit(colleague, ws, synced.meetingVisitId!, { status: "cancelled" })).rejects.toBeInstanceOf(VisitInputError);
    await expect(createPlannedVisit(colleague, ws, { title: "x", kind: "meeting", start: "2026-11-20T06:00:00Z", end: "2026-11-20T05:00:00Z" }, C)).rejects.toBeInstanceOf(VisitInputError);
  });

  it("visit checklist items are stored when ticked from the phone; re-ticking is idempotent; custom items allowed", async () => {
    const v = await createPlannedVisit(colleague, ws, { title: "Checklist visit", kind: "site_visit", start: "2026-11-22T05:00:00Z", end: "2026-11-22T06:00:00Z", assetId: assetNear }, C);
    await setChecklistItem(colleague, ws, v.id, { itemKey: "access", done: true }, C);
    await setChecklistItem(colleague, ws, v.id, { itemKey: "access", done: true }, C);
    await setChecklistItem(colleague, ws, v.id, { label: "Check DG fuel log", done: false }, C);
    const { data: rows } = await admin.from("visit_checklist_item").select("item_key, done, done_by").eq("meeting_visit_id", v.id).order("item_key");
    expect(rows).toHaveLength(2);
    expect(rows!.find((r) => r.item_key === "access")).toMatchObject({ done: true, done_by: C });
    await expect(setChecklistItem(colleague, ws, v.id, { itemKey: "not-a-key", done: true }, C)).rejects.toBeInstanceOf(VisitInputError);
  });

  it("conflict alerts are written once (deduped) for overlaps and too-tight travel", async () => {
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const at = (hhmm: string) => `${day}T${hhmm}:00+05:30`;
    await createPlannedVisit(colleague, ws, { title: "Visit A (Baner)", kind: "site_visit", start: at("10:00"), end: at("11:00"), assetId: assetNear }, C);
    await createPlannedVisit(colleague, ws, { title: "Visit B (Baner, overlapping)", kind: "site_visit", start: at("10:30"), end: at("11:15"), assetId: assetNear }, C);
    await createPlannedVisit(colleague, ws, { title: "Visit C (Kharadi, 15 min later)", kind: "site_visit", start: at("11:30"), end: at("12:30"), assetId: assetFar }, C);
    const keys = await detectConflictsAndNotify(admin, ws);
    const mine = keys.filter((k) => k.startsWith("calendar_conflict:"));
    expect(mine.some((k) => k.includes(":overlap:"))).toBe(true);
    expect(mine.some((k) => k.includes(":travel:"))).toBe(true);
    const n1 = await count("outbox", (q) => q.eq("kind", "calendar_conflict"));
    expect(n1).toBe(new Set(keys).size);
    await detectConflictsAndNotify(admin, ws);
    expect(await count("outbox", (q) => q.eq("kind", "calendar_conflict"))).toBe(n1);
    const { data: o } = await admin.from("outbox").select("user_id, payload").eq("workspace_id", ws).eq("kind", "calendar_conflict").like("dedupe_key", "%:travel:%").limit(1).single();
    expect(o!.user_id).toBe(C);
    expect(String((o!.payload as { detail: string }).detail)).toMatch(/estimated travel \d+ min \(estimate/);
  });

  it("saveVisitFeedback logs the outcome as an interaction and creates one follow-up task linked to the visit and that interaction", async () => {
    const v = await createPlannedVisit(colleague, ws, { title: "Feedback visit", kind: "site_visit", start: "2026-10-30T05:00:00Z", end: "2026-10-30T06:00:00Z", assetId: assetNear }, C);
    const f = { attended: true, clientRating: 4, liked: "Floor plate", concerns: "Parking", nextStep: "Send revised commercials", followUpDue: "2026-11-02" };
    const r1 = await saveVisitFeedback(colleague, ws, v.id, f, C);
    expect(r1.taskId).toBeTruthy();
    expect(r1.interactionId).toBeTruthy();
    const { data: task } = await admin.from("task").select("title, linked_entity_type, linked_entity_id, due_at, description").eq("id", r1.taskId!).single();
    expect(task).toMatchObject({ title: "Send revised commercials", linked_entity_type: "meeting_visit", linked_entity_id: v.id });
    expect(task!.description).toContain(r1.interactionId!);
    const { data: links } = await admin.from("interaction_link").select("entity_type, entity_id").eq("interaction_id", r1.interactionId!);
    expect(links).toEqual(expect.arrayContaining([{ entity_type: "meeting_visit", entity_id: v.id }, { entity_type: "task", entity_id: r1.taskId! }, { entity_type: "asset", entity_id: assetNear }]));
    const { data: it } = await admin.from("interaction").select("channel, summary").eq("id", r1.interactionId!).single();
    expect(it).toMatchObject({ channel: "visit" });
    expect(it!.summary).toMatch(/Concerns: Parking/);
    const { data: mv } = await admin.from("meeting_visit").select("status").eq("id", v.id).single();
    expect(mv!.status).toBe("completed");
    // saving again (e.g. double tap on a phone) creates no second task or interaction
    const r2 = await saveVisitFeedback(colleague, ws, v.id, f, C);
    expect(r2).toMatchObject({ taskId: r1.taskId, interactionId: r1.interactionId });
    expect(await count("task", (q) => q.eq("linked_entity_id", v.id))).toBe(1);
  });

  it("external invites remain drafts only", async () => {
    const { draftInvite } = await import("./calendar");
    const d = await draftInvite(colleague, ws, { title: "Site visit", start: "2026-11-20T05:00:00Z", end: "2026-11-20T06:00:00Z", attendeeAddress: "client@example.in", ownerUserId: C });
    expect(d).toMatchObject({ channel: "calendar_invite", state: "drafted" });
  });
});

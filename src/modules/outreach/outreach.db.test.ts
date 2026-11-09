// Spec §22: company (M1) → Pune expansion signal (M2) → lead score (M3) → Head of Administration (M4) → context →
// suppression check → email + WhatsApp → questions → edit → approval → confirm → manual send → reply → link →
// commitment → next action → pause follow-ups → history. Plus rejection, suppression, duplicate, changed recipient,
// modified approved content.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import * as S from "./service";
import { relationshipLevel, scenarioFor, pauseReason, templateDraft } from "./rules";

const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;

describe("rules", () => {
  it("relationship level comes only from records", () => {
    expect(relationshipLevel([])).toBe("not_interacted");
    expect(relationshipLevel([{ channel: "call", direction: "outbound", is_meaningful: true }])).toBe("spoke_on_call");
    expect(relationshipLevel([{ channel: "meeting", direction: null, is_meaningful: true }])).toBe("met_once");
    expect(relationshipLevel([], true)).toBe("not_interested");
  });
  it("maps signals to scenarios and pauses on the right events", () => {
    expect(scenarioFor({ category: "expansion", title: "Pune expansion, 500 hires" })).toBe("expansion");
    expect(scenarioFor({ category: "lease", title: "Lease expiry" })).toBe("lease_renewal");
    expect(scenarioFor({ title: "Plans GCC in Pune" })).toBe("gcc");
    expect(pauseReason({ replied: true })).toMatch(/reply/);
    expect(pauseReason({ opportunityStage: "loi" })).toMatch(/negotiation/);
    expect(pauseReason({})).toBeNull();
  });
  it("offline drafts don't claim a need and differ by channel", () => {
    const a = { scenario: "expansion" as const, first: "Rahul", company: "VertexNova", level: "not_interacted" as const, reason: "I noticed reports of VertexNova's Pune expansion", roleKey: "facilities", sender: "Hussain" };
    const e = templateDraft({ ...a, channel: "email" }); const w = templateDraft({ ...a, channel: "whatsapp" });
    expect(e.subject).toBeTruthy(); expect(w.subject).toBeNull();
    expect(w.body.length).toBeLessThan(e.body.length);
    expect(e.body).not.toMatch(/you need|requires additional space|leading consultancy/i);
  });
});

describe("Module 5 — outreach end to end", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("or");
  let org: string; let pid: string; let opp: string;
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `VertexNova ${t}` }).select("id").single()).data!.id;
    pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Rahul Mehta ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: org, title: "Head of Administration", is_current: true });
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "email", value: `rahul@vn-${t}.example` });
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "phone", value: "+919800000001" });
    await db.from("contact_role_assessment").insert({ workspace_id: WS1, person_id: pid, org_id: org, role_class: "technical_evaluator", cre_relevance: "high", active: true, source: "test" });
    const s = await db.from("signal").insert({ workspace_id: WS1, category: "expansion", kind: "pune_expansion", title: `VertexNova ${t} announces Pune expansion`, org_id: org, verification: "inference", confidence: "medium", dedupe_key: `t:${t}` }).select("id").single();
    if (s.error) throw new Error(s.error.message);
    opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: org, name: `VN Pune ${t}`, stage: "approach_attempted" }).select("id").single()).data!.id;
  });

  it("suggests the contact, drafts email + WhatsApp from records, approves, sends manually, links the reply, pauses follow-ups", async () => {
    const sug = await S.suggestions(db, WS1, 50);
    expect(sug.find((x) => x.personId === pid)?.scenario).toBe("expansion");
    const ctx = await S.buildContext(db, WS1, pid);
    expect(ctx.level).toBe("not_interacted");
    expect(ctx.facts.some((f) => f.source_type === "signal")).toBe(true);
    expect(ctx.unknowns).toContain("any previous conversation");

    const r = await S.createOutreach(db, WS1, owner, { personId: pid, channels: ["email", "whatsapp", "call"], ai: noAi });
    expect(r.ids).toHaveLength(3);
    const { data: items } = await db.from("outreach_item").select("*").in("id", r.ids);
    const email = items!.find((i) => i.channel === "email")!; const wa = items!.find((i) => i.channel === "whatsapp")!;
    expect(email.reason).toMatch(/reports of/);                         // reported, not claimed as fact
    expect(email.opportunity_id).toBe(opp);
    expect(email.questions.length).toBeGreaterThan(0);
    const de = (await db.from("draft").select("*").eq("id", email.draft_id).single()).data!;
    const dw = (await db.from("draft").select("*").eq("id", wa.draft_id).single()).data!;
    expect(de.subject).toBeTruthy(); expect(dw.subject).toBeNull(); expect(dw.body).not.toBe(de.body);

    await S.editItem(db, WS1, owner, email.id, { subject: de.subject, body: `${de.body}\n\nP.S. edited` });
    await S.requestApproval(db, WS1, owner, email.id);
    const d1 = (await db.from("draft").select("content_hash").eq("id", email.draft_id).single()).data!;
    await expect(S.approve(db, WS1, owner, email.id, "wrong-hash")).rejects.toThrow();     // approval bound to what was reviewed
    await S.approve(db, WS1, owner, email.id, d1.content_hash);
    await expect(S.openForSend(db, WS1, owner, email.id, "stale")).rejects.toThrow(/changed/);
    const open = await S.openForSend(db, WS1, owner, email.id, d1.content_hash);
    expect(open.href).toMatch(/^mailto:/);
    await S.markSent(db, WS1, owner, email.id);
    expect((await S.markSent(db, WS1, owner, email.id)).already).toBe(true);           // idempotent
    const { data: plan } = await db.from("outreach_item").select("step, status, channel").eq("plan_key", email.plan_key).order("step");
    expect(plan!.find((p) => p.channel === "whatsapp")!.status).toBe("paused");          // alternative of the same step paused
    expect(plan!.filter((p) => p.step === 2)).toHaveLength(1);                            // only ONE next follow-up planned
    const { data: out } = await db.from("interaction").select("direction").eq("source_message_id", `outreach:${email.id}`).single();
    expect(out!.direction).toBe("outbound");

    const resp = await S.recordResponse(db, WS1, owner, email.id, "Thanks Rahul here — please send details of options in Kharadi. Let's meet Tuesday.", noAi);
    expect(resp.status).toBe("meeting");
    expect(resp.tasks.length).toBe(1);
    expect(resp.proposals.length).toBe(1);                                               // opportunity stage → proposal, not a write
    const { data: o } = await db.from("opportunity").select("stage").eq("id", opp).single();
    expect(o!.stage).toBe("approach_attempted");
    const { data: after } = await db.from("outreach_item").select("status, pause_reason").eq("plan_key", email.plan_key).eq("step", 2).single();
    expect(after).toMatchObject({ status: "paused", pause_reason: "A reply was received" });
    const { data: ev } = await db.from("outreach_event").select("event").eq("item_id", email.id);
    expect(ev!.map((e) => e.event)).toEqual(expect.arrayContaining(["drafted", "edited", "approval_requested", "approved", "opened_for_send", "sent_manual", "meeting"]));
    const { data: vers } = await db.from("outreach_version").select("version").eq("item_id", email.id);
    expect(vers!.length).toBe(2);
    const a = await S.analytics(db, WS1);
    expect(a.attempts).toBeGreaterThanOrEqual(1); expect(a.meetings).toBeGreaterThanOrEqual(1);
  });

  it("modified approved content and changed recipient invalidate approval; rejection returns to draft", async () => {
    const r = await S.createOutreach(db, WS1, owner, { personId: pid, channels: ["email"], scenario: "relocation", ai: noAi });
    expect(r.warnings.some((w) => w.kind === "recent_send" || w.kind === "open_outreach" || w.kind === "recent_interaction")).toBe(true);  // duplicate warning, not a block
    const id = r.ids[0];
    const it = (await db.from("outreach_item").select("draft_id").eq("id", id).single()).data!;
    const h = (await db.from("draft").select("content_hash").eq("id", it.draft_id).single()).data!.content_hash;
    await S.requestApproval(db, WS1, owner, id);
    await S.reject(db, WS1, owner, id, "too pushy");
    expect((await db.from("outreach_item").select("status").eq("id", id).single()).data!.status).toBe("draft");
    await S.approve(db, WS1, owner, id, h);
    await S.editItem(db, WS1, owner, id, { body: "Changed after approval" });
    expect((await db.from("outreach_item").select("status").eq("id", id).single()).data!.status).toBe("draft");
    expect((await db.from("draft").select("state, approved_hash").eq("id", it.draft_id).single()).data!.state).toBe("drafted");
    const h2 = (await db.from("draft").select("content_hash").eq("id", it.draft_id).single()).data!.content_hash;
    await S.approve(db, WS1, owner, id, h2);
    await S.editItem(db, WS1, owner, id, { body: "Changed after approval", recipientAddress: `other@vn-${t}.example` });
    const { data: ev } = await db.from("outreach_event").select("event, detail").eq("item_id", id).eq("event", "approval_invalidated").order("created_at", { ascending: false }).limit(1).single();
    expect(ev!.detail.reason).toBe("recipient changed");
  });

  it("suppression and do-not-contact block drafting and pause planned follow-ups", async () => {
    const p2 = (await db.from("person").insert({ workspace_id: WS1, full_name: `Supp Person ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: p2, org_id: org, title: "CFO", is_current: true });
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: p2, method_type: "email", value: `cfo@vn-${t}.example` });
    const r = await S.createOutreach(db, WS1, owner, { personId: p2, channels: ["email"], ai: noAi });
    await db.from("outreach_item").update({ status: "planned" }).eq("id", r.ids[0]);
    await db.from("person").update({ do_not_contact: true }).eq("id", p2);
    const sw = await S.sweep(db, WS1);
    expect(sw.paused).toBeGreaterThanOrEqual(1);
    expect((await db.from("outreach_item").select("pause_reason").eq("id", r.ids[0]).single()).data!.pause_reason).toMatch(/do-not-contact/);
    await expect(S.createOutreach(db, WS1, owner, { personId: p2, channels: ["email"], ai: noAi })).rejects.toThrow(/do-not-contact/);
  });

  it("isolation: another workspace sees nothing", async () => {
    const o = await userClient("other");
    const { data } = await o.from("outreach_item").select("id").eq("org_id", org);
    expect(data ?? []).toHaveLength(0);
  });
});

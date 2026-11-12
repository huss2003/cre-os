// Round 2: variants, follow-up tasks + overdue, alternative approach, referred/unavailable replies, contact/company
// proposals, relationships, analytics breakdowns, property suggestions.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import * as S from "./service";
import * as R from "./rules";

const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const T = "2026-11-10";

describe("rules — round 2", () => {
  it("follow-up state and task key", () => {
    expect(R.followupState("2026-11-09", T)).toBe("overdue");
    expect(R.followupState(T, T)).toBe("due");
    expect(R.followupState("2026-11-12", T)).toBe("upcoming");
    expect(R.followupTaskKey("abc")).toBe("outreach-followup:abc");
  });
  it("alternative approach only after 2+ unanswered sends: intro → other channel → pause", () => {
    expect(R.alternativeApproach({ unansweredSends: 1, channelsUsed: ["email"], available: { phone: true } })).toBeNull();
    expect(R.alternativeApproach({ unansweredSends: 2, channelsUsed: ["email"], available: { phone: true }, warmPath: { personId: "p", name: "Asha" } })!.kind).toBe("warm_intro");
    const sw = R.alternativeApproach({ unansweredSends: 2, channelsUsed: ["email"], available: { email: true, phone: true } })!;
    expect(sw).toMatchObject({ kind: "switch_channel", channel: "call" });
    expect(R.alternativeApproach({ unansweredSends: 3, channelsUsed: ["email"], available: { email: true } })!.kind).toBe("pause");
  });
  it("resume date from out-of-office text", () => {
    expect(R.resumeDateFrom("I'm away until 2026-11-20", T)).toBe("2026-11-20");
    expect(R.resumeDateFrom("Back on 24 Nov", T)).toBe("2026-11-24");
    expect(R.resumeDateFrom("Back on Jan 5", T)).toBe("2027-01-05");
    expect(R.resumeDateFrom("on leave next week", T)).toBe("2026-11-17");
    expect(R.resumeDateFrom("on leave", T)).toBe("2026-11-24");
  });
  it("extracts referral, contact updates and company notes literally", () => {
    const r = R.extractReply("Please reach out to Priya Sharma, priya@x.example, who handles admin.");
    expect(r.referred).toEqual({ name: "Priya Sharma", email: "priya@x.example" });
    expect(r.updates.email).toBeNull();
    const u = R.extractReply("Thanks. My new title is Director Facilities. Call me on +91 98000 12345. We are consolidating two offices.");
    expect(u.updates).toMatchObject({ title: "Director Facilities", phone: "+919800012345" });
    expect(u.companyNote).toMatch(/^We are consolidating/);
    expect(R.extractReply("Out of office until Monday").unavailable).toBe(true);
    expect(R.extractReply("I am now on leave until Monday").updates.title).toBeNull();
  });
  it("relationship status: needs attention > active < 45 ≤ cooling ≤ 90 < inactive", () => {
    expect(R.relationshipStatus({ lastAt: "2026-11-01", today: T, openCommitments: 0, unansweredInbound: false })).toBe("active");
    expect(R.relationshipStatus({ lastAt: "2026-09-01", today: T, openCommitments: 0, unansweredInbound: false })).toBe("cooling");
    expect(R.relationshipStatus({ lastAt: "2026-07-01", today: T, openCommitments: 0, unansweredInbound: false })).toBe("inactive");
    expect(R.relationshipStatus({ lastAt: null, today: T, openCommitments: 0, unansweredInbound: false })).toBe("inactive");
    expect(R.relationshipStatus({ lastAt: "2026-07-01", today: T, openCommitments: 1, unansweredInbound: false })).toBe("needs_attention");
    const e = R.engagement([{ occurred_at: "2026-11-05T10:00:00Z", direction: "inbound", promises: [{ who: "us", what: "Send rents" }, { who: "them", what: "x" }] }, { occurred_at: "2026-11-01T10:00:00Z", direction: "outbound" }, { occurred_at: "2026-01-01T10:00:00Z", direction: "outbound" }], T);
    expect(e).toMatchObject({ last90: 2, unansweredInbound: true, promises: ["Send rents"] });
  });
  it("rates carry denominators; breakdown and after-outreach window", () => {
    expect(R.rate(1, 4, "sent").label).toBe("25% (1 of 4 sent)");
    expect(R.rate(0, 0, "sent").pct).toBe("—");
    const b = R.breakdown([{ sent_at: "x", responded_at: "y", c: "Email" }, { sent_at: "x", responded_at: null, c: "Email" }, { sent_at: null, c: "WhatsApp" }] as never[], (i: { c: string }) => i.c);
    expect(b).toEqual([expect.objectContaining({ key: "Email", sends: 2, replies: 1 })]);
    const sends = [{ org_id: "o", sent_at: "2026-10-01T00:00:00Z" }];
    expect(R.afterOutreach(sends, { org_id: "o", created_at: "2026-10-20T00:00:00Z" })).toBe(true);
    expect(R.afterOutreach(sends, { org_id: "o", created_at: "2026-11-20T00:00:00Z" })).toBe(false);
    expect(R.afterOutreach(sends, { org_id: "o", created_at: "2026-09-20T00:00:00Z" })).toBe(false);
    expect(R.afterOutreach(sends, { org_id: "x", created_at: "2026-10-02T00:00:00Z" })).toBe(false);
  });
  it("availability label is verified only when confirmed and recent", () => {
    expect(R.availabilityLabel({ status: "available", as_of: "2026-11-01", fact_status: "currently_confirmed" }, T).verified).toBe(true);
    expect(R.availabilityLabel({ status: "available", as_of: "2026-08-01", fact_status: "currently_confirmed" }, T).verified).toBe(false);
    expect(R.availabilityLabel({ status: "unverified", as_of: "2026-11-01" }, T).text).toMatch(/not verified/);
  });
  it("variant mocks differ by angle and add no new claims", () => {
    const cur = { subject: "Acme: expansion in Pune", body: "Hi Ravi, I'm Sam, an office-space adviser in Pune.\n\nI noticed reports of Acme's Pune expansion. Given your focus on cost, it may help to compare early.\n\nWould a 15-minute call next week be useful?\n\nRegards,\nSam" };
    const vs = R.VARIANT_ANGLES.map((a) => R.variantMock(cur, a.key, "Ravi", "Roughly how many additional seats are expected?"));
    expect(new Set(vs.map((v) => v.body)).size).toBe(3);
    for (const v of vs) { expect(v.body).toMatch(/reports of/); expect(v.body).not.toMatch(/you need|leading/i); }
  });
});

describe("Module 5 — round 2 (db)", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("or2");
  let org: string; let pid: string;
  const person = async (name: string, email = true) => {
    const id = (await db.from("person").insert({ workspace_id: WS1, full_name: `${name} ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: id, org_id: org, title: "Admin Manager", is_current: true });
    if (email) await db.from("contact_method").insert({ workspace_id: WS1, person_id: id, method_type: "email", value: `${name.toLowerCase().replace(/\s/g, "")}@or2-${t}.example` });
    return id;
  };
  const sendOne = async (personId: string, channels: R.Channel[] = ["email"]) => {
    const r = await S.createOutreach(db, WS1, owner, { personId, channels, scenario: "expansion", ai: noAi });
    const id = r.ids[0];
    const it = (await db.from("outreach_item").select("draft_id").eq("id", id).single()).data!;
    const h = (await db.from("draft").select("content_hash").eq("id", it.draft_id).single()).data!.content_hash;
    await S.approve(db, WS1, owner, id, h); await S.openForSend(db, WS1, owner, id, h); await S.markSent(db, WS1, owner, id);
    return id;
  };
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Orbit ${t}` }).select("id").single()).data!.id;
    pid = await person("Ravi Kumar");
  });

  it("Show 3 versions: persisted alternatives; picking one makes a regenerated version and resets approval", async () => {
    const r = await S.createOutreach(db, WS1, owner, { personId: pid, channels: ["email"], scenario: "expansion", ai: noAi });
    const id = r.ids[0];
    const it = (await db.from("outreach_item").select("draft_id").eq("id", id).single()).data!;
    const h = (await db.from("draft").select("content_hash").eq("id", it.draft_id).single()).data!.content_hash;
    await S.approve(db, WS1, owner, id, h);
    const vs = await S.generateVariants(db, WS1, owner, id, noAi);
    expect(vs.length).toBeGreaterThanOrEqual(2);
    const stored = (await db.from("outreach_item").select("script, status").eq("id", id).single()).data!;
    expect(stored.script.variants).toHaveLength(vs.length);              // survives reload
    expect(stored.status).toBe("approved");                               // generating alone changes nothing
    await S.pickVariant(db, WS1, owner, id, vs[1].n);
    const d = (await db.from("draft").select("body, state").eq("id", it.draft_id).single()).data!;
    expect(d.body).toBe(vs[1].body); expect(d.state).toBe("drafted");
    expect((await db.from("outreach_item").select("status").eq("id", id).single()).data!.status).toBe("draft");
    const { data: v } = await db.from("outreach_version").select("kind, op").eq("item_id", id).order("version", { ascending: false }).limit(1).single();
    expect(v).toEqual({ kind: "regenerated", op: `variant:${vs[1].n}` });
    await S.pauseItem(db, WS1, owner, id, "test done");
  });

  it("sweep creates one reminder task per due/overdue follow-up (idempotent); 2 unanswered sends suggest another approach", async () => {
    const p = await person("Neha Rao");
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: p, method_type: "phone", value: "+919800000222" });
    const first = await sendOne(p);
    const { data: fu } = await db.from("outreach_item").select("id, plan_key").eq("plan_key", (await db.from("outreach_item").select("plan_key").eq("id", first).single()).data!.plan_key).eq("step", 2).single();
    await db.from("outreach_item").update({ planned_on: "2026-01-02" }).eq("id", fu!.id);       // overdue
    const s1 = await S.sweep(db, WS1); await S.sweep(db, WS1);
    expect(s1.tasks).toBeGreaterThanOrEqual(1);
    const { data: tk } = await db.from("task").select("id, due_at").eq("idempotency_key", `outreach-followup:${fu!.id}`);
    expect(tk).toHaveLength(1);
    expect(await S.alternativeFor(db, WS1, owner, p)).toBeNull();
    await db.from("outreach_item").update({ status: "paused" }).eq("id", fu!.id);
    await sendOne(p);
    const alt = await S.alternativeFor(db, WS1, owner, p);
    expect(alt).toMatchObject({ kind: "switch_channel", channel: "call" });
    expect((await S.alternativesToday(db, WS1, owner, 50)).some((a) => a.personId === p)).toBe(true);
  });

  it("referred reply proposes a new contact; contact/company updates go to Review, never direct writes", async () => {
    const p = await person("Kiran Joshi");
    const id = await sendOne(p);
    const r = await S.recordResponse(db, WS1, owner, id, "Thanks. My new title is Head of Workplace. Please reach out to Meera Iyer, meera@or2.example, she owns this. We are moving our finance team to Hinjewadi.", noAi);
    expect(r.outcome).toBe("referred");
    expect(r.referred?.name).toBe("Meera Iyer");
    expect(r.proposalKinds).toEqual(expect.arrayContaining(["title", "company note", "referred contact"]));
    const { data: emp } = await db.from("employment").select("title").eq("person_id", p).eq("is_current", true).single();
    expect(emp!.title).toBe("Admin Manager");                                       // unchanged until approved
    expect((await db.from("person").select("id").eq("workspace_id", WS1).eq("full_name", "Meera Iyer").limit(1)).data ?? []).toHaveLength(0);
    const { data: cps } = await db.from("change_proposal").select("target_type, operation").eq("workspace_id", WS1).like("idempotency_key", `outreach:${id}:%`);
    expect((cps ?? []).map((c) => c.target_type)).toEqual(expect.arrayContaining(["employment", "organisation", "person"]));
    const again = await S.recordResponse(db, WS1, owner, id, "Please reach out to Meera Iyer.", noAi);   // idempotent proposals
    expect(again.outcome).toBe("referred");
    expect(((await db.from("change_proposal").select("id").eq("workspace_id", WS1).like("idempotency_key", `outreach:${id}:referred`)).data ?? []).length).toBe(1);
  });

  it("unavailable reply replans the follow-up after their return and the sweep doesn't pause it", async () => {
    const p = await person("Arjun Mehta");
    const id = await sendOne(p);
    const r = await S.recordResponse(db, WS1, owner, id, "I am out of office until 2099-01-20 with limited access to email.", noAi);
    expect(r.outcome).toBe("unavailable"); expect(r.resumeOn).toBe("2099-01-20");
    const plan = (await db.from("outreach_item").select("plan_key").eq("id", id).single()).data!.plan_key;
    const { data: nx } = await db.from("outreach_item").select("id, status, planned_on").eq("plan_key", plan).eq("step", 2).single();
    expect(nx).toMatchObject({ status: "planned", planned_on: "2099-01-21" });
    await S.sweep(db, WS1);
    expect((await db.from("outreach_item").select("status").eq("id", nx!.id).single()).data!.status).toBe("planned");
    const a = await S.analytics(db, WS1);
    expect(a.outcomes.unavailable).toBeGreaterThanOrEqual(1);
    expect(a.rates.reply.d).toBe(a.attempts);
    expect(a.byChannel.some((x) => x.key === "Email")).toBe(true);
    expect(a.byCompany.length).toBeLessThanOrEqual(10);
  });

  it("relationships list status, commitments and warm intros", async () => {
    const p = await person("Sana Khan");
    const i = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: new Date().toISOString(), channel: "email", direction: "inbound", summary: "asked for rents", promises: [{ who: "us", what: "Send Baner rents" }], owner_user_id: owner }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: p, role: "from" });
    const mid = await person("Mutual Friend", false);
    await db.from("relationship_edge").insert({ workspace_id: WS1, from_person_id: mid, to_person_id: p, edge_type: "colleague", warmth: "warm" });
    const rows = await S.relationships(db, WS1, 1000);
    const me = rows.find((r) => r.personId === p)!;
    expect(me).toMatchObject({ status: "needs_attention", unansweredInbound: true, last90: 1, warmIntros: 1 });
    expect(me.commitments).toContain("Send Baner rents");
  });

  it("property suggestions for the open requirement, labelled by verification; mention adds a fact only", async () => {
    const req = await db.from("requirement").insert({ workspace_id: WS1, org_id: org, title: `Orbit Pune ${t}`, objective: "expansion", area_min_sf: 8000, area_target_sf: 10000, area_max_sf: 12000, status: "draft" }).select("id").single();
    expect(req.error).toBeNull();
    const asset = (await db.from("asset").insert({ workspace_id: WS1, name: `Tower ${t}` }).select("id").single()).data!.id;
    const sp1 = (await db.from("space").insert({ workspace_id: WS1, asset_id: asset, chargeable_sf: 10500 }).select("id").single()).data!.id;
    const sp2 = (await db.from("space").insert({ workspace_id: WS1, asset_id: asset, chargeable_sf: 50000 }).select("id").single()).data!.id;
    const av = (await db.from("availability").insert({ workspace_id: WS1, space_id: sp1, as_of: new Date().toISOString().slice(0, 10), status: "available", fact_status: "currently_confirmed" }).select("id").single()).data!.id;
    await db.from("availability").insert({ workspace_id: WS1, space_id: sp2, as_of: new Date().toISOString().slice(0, 10), status: "available" });
    const r = await S.propertySuggestions(db, WS1, org, 50); // shared WS1: look past other tests' newer fixtures
    expect(r.requirement?.id).toBe(req.data!.id);
    const mine = r.options.filter((o) => o.asset === `Tower ${t}`);
    expect(mine.map((o) => o.spaceId)).toEqual([sp1]);                      // out-of-size space excluded
    expect(mine[0].label.verified).toBe(true);
    const c = await S.createOutreach(db, WS1, owner, { personId: pid, channels: ["email"], scenario: "expansion", mentionAvailabilityIds: [av], ai: noAi });
    const { data: item } = await db.from("outreach_item").select("facts, script, draft_id").eq("id", c.ids[0]).single();
    expect((item!.facts as { source_type: string }[]).some((f) => f.source_type === "availability")).toBe(true);
    const before = (await db.from("draft").select("body").eq("id", item!.draft_id).single()).data!.body;
    expect(await S.toggleMention(db, WS1, owner, c.ids[0], av)).toBe(false);   // already mentioned → removed
    expect(await S.toggleMention(db, WS1, owner, c.ids[0], av)).toBe(true);
    expect((await db.from("draft").select("body").eq("id", item!.draft_id).single()).data!.body).toBe(before);
  });
});

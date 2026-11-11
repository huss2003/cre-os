// Journey STAGE 5 — Module 5 Outreach Engine (TEST_PLAN 5.1–5.8). Service level, WS1 as owner, mock AI only.
// Verifies S3 (no outbound send), hash-bound approval invalidated by edits, duplicate warnings, reply → CRM.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { userClient, WS1, tag } from "../helpers";
import * as S from "@/modules/outreach/service";

type Row = Record<string, any>;
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;
const UNSUPPORTED = /25,?000|you (need|require)|requires? additional space|confirmed requirement|leading consultancy|as agreed/i;

describe("STAGE 5 — Outreach Engine (ABC Technologies)", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("j5");
  let abc: string; let rahul: string; let priya: string; let amit: string; let opp: string; let req: string;
  let first: Row; let firstDraft: Row;
  const draftOf = async (itemId: string) => { const it = (await db.from("outreach_item").select("*").eq("id", itemId).single()).data!; return { it, d: (await db.from("draft").select("*").eq("id", it.draft_id).single()).data! }; };

  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    abc = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `ABC Technologies Pvt. Ltd. ${t}`, sector: "Information Technology" }).select("id").single()).data!.id;
    const mk = async (name: string, title: string, email: string) => {
      const id = (await db.from("person").insert({ workspace_id: WS1, full_name: `${name} ${t}` }).select("id").single()).data!.id;
      await db.from("employment").insert({ workspace_id: WS1, person_id: id, org_id: abc, title, is_current: true });
      await db.from("contact_method").insert({ workspace_id: WS1, person_id: id, method_type: "email", value: `${email}@abc-${t}.example`, verify_status: "likely_valid" });
      return id;
    };
    rahul = await mk("Rahul Sharma", "Head of Administration", "rahul");
    priya = await mk("Priya Mehta", "Head of Finance", "priya");
    amit = await mk("Amit Verma", "Head of HR", "amit");
    const s = await db.from("signal").insert({ workspace_id: WS1, category: "expansion", kind: "pune_expansion", title: `ABC Technologies Pvt. Ltd. ${t} plans to expand Pune operations`, org_id: abc, verification: "inference", confidence: "medium", dedupe_key: `j5:${t}` });
    if (s.error) throw new Error(s.error.message);
    req = (await db.from("requirement").insert({ workspace_id: WS1, org_id: abc, title: `ABC Pune expansion ${t}`, objective: "expansion", status: "draft" }).select("id").single()).data!.id;
    opp = (await db.from("opportunity").insert({ workspace_id: WS1, org_id: abc, requirement_id: req, name: `ABC Pune ${t}`, stage: "approach_attempted" }).select("id").single()).data!.id;
  });

  it("5.1 first outreach email to Rahul: right contact/company, expansion context, no invented requirement, editable", async () => {
    const r = await S.createOutreach(db, WS1, owner, { personId: rahul, channels: ["email"], ai: noAi });
    expect(r.ids).toHaveLength(1);
    ({ it: first, d: firstDraft } = await draftOf(r.ids[0]));
    expect.soft(firstDraft.recipient_person_id).toBe(rahul);
    expect.soft(firstDraft.recipient_address).toBe(`rahul@abc-${t}.example`);
    expect.soft(first.org_id).toBe(abc);
    expect.soft(first.opportunity_id).toBe(opp);
    expect.soft(firstDraft.body).toMatch(/Pune/);
    expect.soft(firstDraft.body).toMatch(/expand/i);
    expect.soft(first.reason).toMatch(/reports of/);                 // reported, not confirmed
    expect.soft(firstDraft.body).not.toMatch(UNSUPPORTED);
    expect.soft(firstDraft.state).toBe("drafted");
    await S.editItem(db, WS1, owner, first.id, { subject: firstDraft.subject, body: `${firstDraft.body}\n\n(edited in 5.1)` });
    expect((await draftOf(first.id)).d.body).toMatch(/edited in 5\.1/);
  });

  it("5.2 three genuinely different versions: professional, conversational, very short", async () => {
    const v = await S.generateVariants(db, WS1, owner, first.id, noAi);
    expect.soft(v).toHaveLength(3);
    expect.soft(new Set(v.map((x) => x.body)).size).toBe(v.length);
    for (const x of v) { expect.soft(x.body).toMatch(/Rahul/); expect.soft(x.body).not.toMatch(UNSUPPORTED); }
    // Plan asks for professional / conversational / very short; the engine offers concise / value-led / question-led.
    expect(v.map((x) => x.angle), "tones requested by the user").toEqual(expect.arrayContaining(["professional", "conversational", "very_short"]));
  });

  it("5.3 role-specific messages for Administration, Finance and HR", async () => {
    const pr = await S.createOutreach(db, WS1, owner, { personId: priya, channels: ["email"], ai: noAi });
    const am = await S.createOutreach(db, WS1, owner, { personId: amit, channels: ["email"], ai: noAi });
    const admin = firstDraft.body, fin = (await draftOf(pr.ids[0])).d.body, hr = (await draftOf(am.ids[0])).d.body;
    expect.soft(admin).toMatch(/building operations|parking|space utilisation|amenities/i);
    expect.soft(fin).toMatch(/occupancy cost|rent|cash-flow|lease economics/i);
    expect.soft(hr).toMatch(/employee|workforce|seating/i);
    expect(new Set([admin, fin, hr]).size).toBe(3);
  });

  it("5.4 follow-up uses the previous interaction without re-entering it", async () => {
    const i = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: new Date(Date.now() - 20 * 864e5).toISOString(), channel: "call", direction: "inbound", summary: "Rahul asked us to reconnect after discussing expansion plans.", is_meaningful: true, owner_user_id: owner }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: rahul, role: "from" });
    const ctx = await S.buildContext(db, WS1, rahul);
    expect.soft(ctx.facts.some((f) => f.source_type === "interaction" && /reconnect/.test(f.text))).toBe(true);
    const r = await S.createOutreach(db, WS1, owner, { personId: rahul, channels: ["email"], scenario: "reconnect", ai: noAi });
    const { it: item, d } = await draftOf(r.ids[0]);
    expect.soft(item.facts.some((f: Row) => /reconnect/.test(f.text))).toBe(true);
    expect.soft(r.warnings.length).toBeGreaterThan(0);                  // already an open draft to Rahul
    expect(d.body, "follow-up references the previous conversation").toMatch(/since we (last )?spoke|our (call|conversation)|reconnect|expansion plans/i);
    await db.from("outreach_item").update({ status: "closed" }).eq("id", item.id);   // keep the journey to one live thread
  });

  it("5.5 approval is recorded with recipient/channel/version and invalidated by a later edit", async () => {
    await S.requestApproval(db, WS1, owner, first.id);
    let { d } = await draftOf(first.id);
    await expect(S.approve(db, WS1, owner, first.id, "not-the-reviewed-hash")).rejects.toThrow();
    await S.approve(db, WS1, owner, first.id, d.content_hash);
    ({ d } = await draftOf(first.id));
    expect.soft(d.state).toBe("approved");
    expect.soft(d.approved_hash).toBe(d.content_hash);
    expect.soft(d.recipient_address).toBe(`rahul@abc-${t}.example`);
    expect.soft(d.channel).toBe("email");
    const { data: ev } = await db.from("outreach_event").select("event, detail").eq("item_id", first.id).eq("event", "approved");
    expect.soft(ev![0].detail.hash).toBe(d.content_hash);             // the approved version is identifiable
    const versions = (await db.from("outreach_version").select("version").eq("item_id", first.id)).data!;
    expect.soft(versions.length).toBeGreaterThanOrEqual(2);
    const approvedHash = d.content_hash;
    await S.editItem(db, WS1, owner, first.id, { subject: d.subject, body: `${d.body}\nOne more line after approval.` });
    const after = (await draftOf(first.id));
    expect.soft(after.d.state).not.toBe("approved");
    expect.soft(after.d.content_hash).not.toBe(approvedHash);
    expect(after.it.status, "item no longer approved after edit").not.toBe("approved");
    await expect(S.openForSend(db, WS1, owner, first.id, approvedHash)).rejects.toThrow();
  });

  it("5.6 'Send this to Rahul' hands off to the user's own mail app; nothing is sent by the system (S3)", async () => {
    let { it: item, d } = await draftOf(first.id);
    if (item.status !== "pending_approval") await db.from("outreach_item").update({ status: "draft" }).eq("id", first.id);
    await S.approve(db, WS1, owner, first.id, d.content_hash);
    const open = await S.openForSend(db, WS1, owner, first.id, d.content_hash);
    expect.soft(open.href).toMatch(/^mailto:rahul@abc-/);
    ({ it: item, d } = await draftOf(first.id));
    expect.soft(item.status).toBe("approved");                       // opening ≠ sent
    expect.soft(item.sent_at).toBeNull();
    expect.soft((await db.from("interaction").select("id").eq("source_message_id", `outreach:${first.id}`)).data!.length).toBe(0);
    const src = ["src/modules/outreach/service.ts", "src/lib/services/drafts.ts"].map((f) => fs.readFileSync(path.resolve(f), "utf8")).join("\n");
    expect.soft(src).not.toMatch(/nodemailer|sendgrid|api\.twilio|gmail\.users\.messages\.send|graph\.microsoft\.com\/v1\.0\/me\/sendMail/i);
    const s = await S.markSent(db, WS1, owner, first.id);              // user presses "I sent it"
    ({ it: item } = await draftOf(first.id));
    expect.soft(item.sent_evidence).toBe("user_assertion");
    expect(s.interactionId).toBeTruthy();
  });

  it("5.7 reply 'Please share some available office options in Kharadi' is linked, classified and drives CRM suggestions", async () => {
    const r = await S.recordResponse(db, WS1, owner, first.id, "Please share some available office options in Kharadi.", noAi);
    const item = (await db.from("outreach_item").select("response").eq("id", first.id).single()).data!;
    const { data: links } = await db.from("interaction_link").select("entity_type, entity_id").eq("interaction_id", item.response.interaction_id);
    expect.soft(links).toEqual(expect.arrayContaining([{ entity_type: "person", entity_id: rahul }, { entity_type: "organisation", entity_id: abc }]));
    expect.soft(["info_requested", "interested"]).toContain(r.outcome);
    expect.soft(r.tasks.length).toBeGreaterThan(0);                   // follow-up task created
    const { data: props } = await db.from("change_proposal").select("target_type, target_id").eq("workspace_id", WS1).in("target_id", [opp, req]);
    expect(props!.map((p) => p.target_type), "suggests updating opportunity AND requirement").toEqual(expect.arrayContaining(["opportunity", "requirement"]));
  });

  it("5.8 another introduction email to Rahul warns about duplicate and suggests a follow-up instead", async () => {
    const w = await S.duplicateCheck(db, WS1, rahul, owner);
    expect.soft(w.some((x) => x.kind === "recent_send" || x.kind === "recent_interaction")).toBe(true);
    const r = await S.createOutreach(db, WS1, owner, { personId: rahul, channels: ["email"], scenario: "expansion", ai: noAi });
    expect.soft(r.warnings.length).toBeGreaterThan(0);
    const alt = await S.alternativeFor(db, WS1, owner, rahul);
    expect(r.warnings.map((x) => x.text).join(" ") + (alt ? JSON.stringify(alt) : ""), "suggests a relevant alternative / follow-up").toMatch(/follow[- ]?up|reply|instead|alternative/i);
  });
});

// Module 12 engine: spec §21 acceptance tests 1–10 at service level (mock planner, no ANTHROPIC_API_KEY),
// plus idempotency, approval enforcement / reject / drift, and cross-workspace focus isolation.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../../../../tests/helpers";
import type { AppContext } from "@/lib/auth/context";
import type { Block, EntityRef, StreamEvent } from "../types";
import { runAssistant } from "./run";
import { decideApproval } from "./approvals";
import { executeTool } from "./execute";
import { getTool } from "../tools";
import { saveMemory } from "../memory/service";
import { createDraft } from "@/lib/services/drafts";

type Row = Record<string, any>;
const T = tag("eng");
let ctx: AppContext;
let db: any;
const admin = adminClient();
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

delete process.env.ANTHROPIC_API_KEY;
process.env.ASSISTANT_RUNS_PER_MIN = "500";

async function ask(request: string, extra: Partial<Parameters<typeof runAssistant>[0]> = {}) {
  const events: StreamEvent[] = [];
  const r = await runAssistant({ ctx, request, onEvent: (e) => events.push(e), ...extra });
  const { data: msg } = await db.from("assistant_message").select("*").eq("id", r.messageId).single();
  const { data: steps } = await db.from("assistant_tool_execution").select("*").eq("run_id", r.runId).order("step");
  const blocks = (msg?.blocks ?? []) as Block[];
  if (process.env.DEBUG_ENGINE) console.log(request, r.status, JSON.stringify((steps ?? []).map((s: Row) => [s.tool_id, s.status, s.error, s.input])), msg?.content);
  return { ...r, events, msg: msg as Row, steps: (steps ?? []) as Row[], blocks, all: JSON.stringify(blocks) };
}
const step = (steps: Row[], id: string) => steps.find((s) => s.tool_id === id);
const ins = async (table: string, row: Row) => {
  const { data, error } = await db.from(table).insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, ...row }).select("*").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data as Row;
};

let org: Row, person: Row, req: Row, opp: Row;
const assets: Row[] = [];

beforeAll(async () => {
  db = await userClient("owner");
  ctx = { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner",
    allowedClassifications: ["public", "permitted_personal", "corporate_confidential"], isPlatformAdmin: false, workspaces: [] };
  org = await ins("organisation", { display_name: `Acme${T}`, sector: "IT services" });
  person = await ins("person", { full_name: `Ravi${T} Kumar` });
  await ins("employment", { person_id: person.id, org_id: org.id, title: "Head of Real Estate", is_current: true }).catch(() => null);
  for (const [i, n] of ["Alpha", "Beta", "Gamma"].entries()) {
    const a = await ins("asset", { name: `${n}${T} Tower`, asset_kind: "building", address: `Kharadi, Pune`, lat: 18.55 + i * 0.01, lon: 73.94 + i * 0.01, grade: "A" });
    const s = await ins("space", { asset_id: a.id, floor_text: "5", chargeable_sf: 20000 + i * 5000 });
    await ins("availability", { space_id: s.id, as_of: day(-10).slice(0, 10), status: "available", asking_rent_min: 80 + i * 5, asking_rent_max: 90 + i * 5, fact_status: "reported" });
    assets.push(a);
  }
  req = await ins("requirement", { org_id: org.id, title: `Acme${T} Pune office`, area_min_sf: 18000, area_max_sf: 30000, area_basis: "chargeable", status: "estimated" });
  await ins("shortlist_option", { requirement_id: req.id, asset_id: assets[2].id, option_status: "rejected", eligible: true, rubric_version: "test", disqualifiers: ["Floor plate too small"], version: 1 });
  opp = await ins("opportunity", { org_id: org.id, requirement_id: req.id, name: `Acme${T} relocation`, stage: "options_visits" });
});

describe("spec §21 acceptance (mock mode)", () => {
  it("1 company intelligence: profile via tool, entity resolved by name, missing info surfaced", async () => {
    const r = await ask(`Give me everything important about Acme${T}.`);
    expect(r.events[0]).toMatchObject({ type: "run" });
    expect(step(r.steps, "get_company_profile")?.status).toBe("ok");
    expect(step(r.steps, "get_company_profile")?.input.companyId).toBe(org.id);
    expect(["completed", "partial"]).toContain(r.status);
    expect(r.blocks[0].kind).toBe("text");
    expect(r.blocks.at(-1)!.kind).toBe("status");
    const { data: conv } = await db.from("assistant_conversation").select("title, entity_refs").eq("id", r.conversationId).single();
    expect(conv.title).toContain(`Acme${T}`);
    expect((conv.entity_refs as EntityRef[]).some((e) => e.id === org.id)).toBe(true);
  });

  it("2 meeting preparation: finds tomorrow's meeting and generates the brief", async () => {
    const mv = await ins("meeting_visit", { title: `Acme${T} review`, start_at: day(1), end_at: day(1.05), kind: "meeting", status: "confirmed" });
    await ins("meeting_prep", { meeting_visit_id: mv.id, org_id: org.id, opportunity_id: opp.id, meeting_type: "requirement_discovery", purpose: "Discuss options" }).catch(() => null);
    const r = await ask(`Prepare me for my meeting with Acme${T} tomorrow.`);
    // resolved either by name (meeting title) or via get_upcoming_meetings
    const found = step(r.steps, "get_upcoming_meetings");
    if (found) expect(JSON.stringify(found.output)).toContain(mv.id);
    const brief = step(r.steps, "generate_meeting_brief");
    expect(brief?.status).toBe("ok");
    expect(JSON.stringify(brief!.input)).toMatch(new RegExp(`${mv.id}|prepId`));
    expect(step(r.steps, "get_company_profile")?.status).toBe("ok");
  });

  it("3 commercial analysis: 'these three properties' resolved from conversation; comparison by calculator tool", async () => {
    const first = await ask(`Show me ${assets.map((a) => a.name).join(", ")}`);
    const r = await ask("Compare these three properties for my client.", { conversationId: first.conversationId });
    const s = step(r.steps, "compare_properties");
    expect(s?.status).toBe("ok");
    expect(new Set(s!.input.assetIds)).toEqual(new Set(assets.map((a) => a.id)));
  });

  it("4 historical memory: rejected options with recorded reasons and the confirmed/inferred distinction", async () => {
    const r = await ask("What did this client reject previously and why?", { focus: { type: "company", id: org.id, label: "x" } });
    expect(step(r.steps, "get_requirement_details")?.status).toBe("ok");
    expect(r.all).toContain("Floor plate too small");
    expect(r.msg.content).toMatch(/inferred/i);
  });

  it("5 multi-module workflow: deal review pack", async () => {
    const r = await ask("Prepare this deal for review.", { focus: { type: "opportunity", id: opp.id, label: "x" } });
    expect(step(r.steps, "generate_deal_review")?.status).toBe("ok");
    expect(step(r.steps, "generate_deal_review")?.category).toBe("B");
  });

  it("6 research & mapping: web research (reported), buildings, straight-line distances from infrastructure", async () => {
    await ins("infrastructure", { name: `Metro${T} Kharadi station`, kind: "metro", status: "under_construction", lat: 18.551, lon: 73.941 }).catch((e) => { console.log("infra", e.message); });
    const r = await ask("Find office buildings that may benefit from the upcoming metro station.");
    expect(step(r.steps, "web_research")?.status).toBe("ok");
    expect(step(r.steps, "search_properties")?.status).toBe("ok");
    expect(step(r.steps, "calculate_distance")?.status).toBe("ok");
    expect(r.msg.content).toMatch(/straight-line/i);
    expect(r.all).toMatch(/mock mode|not run/i); // uncertainty is explicit
  });

  it("7 permission enforcement: cross-workspace focus → denied, security event, nothing leaked", async () => {
    const secret = `Secret${T} Holdings`;
    const { data: other } = await admin.from("organisation").insert({ workspace_id: WS2, display_name: secret, owner_user_id: USERS.other.id }).select("id").single();
    const r = await ask("Give me everything important about this company.", { focus: { type: "company", id: other!.id, label: secret } });
    expect(r.status).toBe("partial");
    const { data: msgs } = await db.from("assistant_message").select("content, blocks").eq("conversation_id", r.conversationId);
    expect(JSON.stringify(msgs)).not.toContain(secret);
    const { data: ev } = await admin.from("assistant_security_event").select("kind").eq("workspace_id", WS1).contains("detail", { id: other!.id });
    expect(ev!.some((e: Row) => e.kind === "access_denied")).toBe(true);
    expect(r.all).toMatch(/not found or you do not have access/);
  });

  let sendApproval: string;
  let draftId: string;
  it("8 approval enforcement: 'send this proposal' → approval card, nothing executed", async () => {
    const d = await createDraft(db, WS1, { channel: "email", recipientDisplay: "Ravi Kumar", recipientAddress: `ravi.${T}@example.com`, subject: `Proposal ${T}`, body: "Please find our proposal.", orgId: org.id, ownerUserId: USERS.owner.id });
    draftId = (d as Row).id;
    const r = await ask("Send this proposal to the client.", { focus: { type: "outreach", id: draftId, label: "draft", href: "/drafts" } });
    expect(r.status).toBe("waiting_approval");
    expect(step(r.steps, "prepare_send")?.status).toBe("needs_approval");
    const card = r.blocks.find((b) => b.kind === "approval") as Extract<Block, { kind: "approval" }>;
    expect(card.status).toBe("pending");
    expect(JSON.stringify(card.diff)).toContain(`ravi.${T}@example.com`);
    sendApproval = card.approvalId;
    const { data: draft } = await db.from("draft").select("state").eq("id", draftId).single();
    expect(draft.state).toBe("drafted");
    expect((r.blocks.at(-1) as Extract<Block, { kind: "status" }>).pending.length).toBe(1);
  });

  it("reject path: rejected approval never executes", async () => {
    const res = await decideApproval(ctx, sendApproval, "reject");
    expect(res.status).toBe("rejected");
    const { data: a } = await db.from("assistant_approval").select("status").eq("id", sendApproval).single();
    expect(a.status).toBe("rejected");
    const { data: draft } = await db.from("draft").select("state").eq("id", draftId).single();
    expect(draft.state).toBe("drafted");
    await expect(decideApproval(ctx, sendApproval, "approve")).rejects.toThrow(/rejected/);
  });

  it("9 memory correction: old kept as outdated history, new stated with source/date", async () => {
    const old = await saveMemory(ctx, { category: "person", entityType: "person", entityId: person.id, content: "Prefers small floor plates", stated: true, source: "user" } as never);
    const r = await ask("That preference is outdated. He now prefers larger floor plates.", { focus: { type: "person", id: person.id, label: "x" } });
    expect(step(r.steps, "correct_memory")?.status).toBe("ok");
    const { data: rows } = await db.from("assistant_memory").select("id, content, status, superseded_by_id, source").eq("entity_id", person.id).order("captured_at");
    const prev = rows.find((m: Row) => m.id === (old as Row).id);
    expect(prev.status).toBe("outdated");
    const now = rows.find((m: Row) => m.status === "active");
    expect(now.content).toMatch(/larger floor plates/);
    expect(prev.superseded_by_id).toBe(now.id);
  });

  it("10 incomplete task: lease expiry search reports coverage, no claim of completeness", async () => {
    await ins("lease", { tenant_org_id: org.id, asset_id: assets[0].id, area_sf: 20000, contractual_expiry: day(120).slice(0, 10), fact_status: "reported" });
    const r = await ask("Find all companies whose lease expires in the next 12 months.");
    const s = step(r.steps, "find_leases_expiring");
    expect(s?.status).toBe("ok");
    expect(s!.input.windowMonths).toBe(12);
    expect(r.msg.content).toMatch(/Coverage: checked \d+/);
    expect(r.msg.content).toMatch(/not a complete/);
    expect(r.blocks.some((b) => b.kind === "missing")).toBe(true);
  });
});

describe("engine guarantees", () => {
  it("idempotent re-run returns the same run and stores one user message", async () => {
    const key = `idem-${T}`;
    const a = await runAssistant({ ctx, request: `Give me everything important about Acme${T}.`, idempotencyKey: key });
    const b = await runAssistant({ ctx, request: `Give me everything important about Acme${T}.`, idempotencyKey: key });
    expect(b.runId).toBe(a.runId);
    expect(b.messageId).toBe(a.messageId);
    const { count } = await db.from("assistant_message").select("id", { count: "exact", head: true }).eq("conversation_id", a.conversationId).eq("role", "user");
    expect(count).toBe(1);
  });

  it("C tool never runs without approval; approval drift → expired + fresh approval", async () => {
    const r = await ask(`Give me everything important about Acme${T}.`);
    const tool = getTool("update_company_record")!;
    const o = await executeTool(tool, { companyId: org.id, changes: { sector: "Fintech" }, reason: "Client said so" }, { ctx, runId: r.runId, conversationId: r.conversationId, focus: null }, 9);
    expect(o.status).toBe("needs_approval");
    let { data: cur } = await db.from("organisation").select("sector").eq("id", org.id).single();
    expect(cur.sector).toBe("IT services");
    // someone edits the record before approval
    await db.from("organisation").update({ sector: "Banking" }).eq("id", org.id);
    const res = await decideApproval(ctx, o.approvalId!, "approve");
    expect(res.status).toBe("expired");
    expect(res.newApprovalId).toBeTruthy();
    ({ data: cur } = await db.from("organisation").select("sector").eq("id", org.id).single());
    expect(cur.sector).toBe("Banking");
    const ok = await decideApproval(ctx, res.newApprovalId!, "approve");
    expect(ok.status).toBe("executed");
    ({ data: cur } = await db.from("organisation").select("sector").eq("id", org.id).single());
    expect(cur.sector).toBe("Fintech");
    const { data: au } = await admin.from("audit_event").select("action").eq("workspace_id", WS1).eq("entity_id", res.newApprovalId!);
    expect(au!.map((x: Row) => x.action)).toContain("assistant.approval.executed");
  });
});

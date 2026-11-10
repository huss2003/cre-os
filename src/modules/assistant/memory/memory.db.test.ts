import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import * as M from "./service";
import { memoryTools } from "../tools/memory";
import type { ToolContext } from "../types";

describe("assistant memory", () => {
  let ctx: M.MemCtx; const t = tag("mem");
  let orgA: string; let orgB: string; let pid: string; let empA: string;
  beforeAll(async () => {
    const db = await userClient("owner");
    ctx = { db, workspaceId: WS1, userId: USERS.owner.id };
    orgA = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Alpha ${t}` }).select("id").single()).data!.id;
    orgB = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Beta ${t}` }).select("id").single()).data!.id;
    pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `John Doe ${t}` }).select("id").single()).data!.id;
    empA = (await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: orgA, is_current: true }).select("id").single()).data!.id;
  });

  it("Test 9: correction supersedes, keeps history, new memory is stated with source + date", async () => {
    const old = await M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Prefers smaller floor plates", source: "user" });
    expect(old.org_context_id).toBe(orgA);
    expect(old.review_at).toBeTruthy();
    const tool = memoryTools.find((x) => x.id === "correct_memory")!;
    const tc: ToolContext = { ctx: ctx as never, runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), focus: { type: "person", id: pid, label: "John" } };
    const r = await tool.run({ hint: "floor plates", new_content: "Now prefers larger floor plates" }, tc);
    expect(r.ok).toBe(true);
    const list = await M.listMemories(ctx, { entityId: pid });
    const cur = list.find((m) => m.content === "Now prefers larger floor plates")!;
    expect(cur.stated).toBe(true);
    expect(cur.source).toBe(`conversation:${tc.conversationId}`);
    expect(cur.captured_at.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(cur.history.map((h) => h.id)).toContain(old.id);
    const oldNow = (await M.getMemory(ctx, old.id))!;
    expect(oldNow.status).toBe("outdated"); expect(oldNow.superseded_by_id).toBe(cur.id); expect(oldNow.content).toBe("Prefers smaller floor plates");
    const recalled = await M.recallMemories(ctx, [{ type: "person", id: pid, label: "" }]);
    expect(recalled.map((m) => m.content)).toContain("Now prefers larger floor plates");
    expect(recalled.map((m) => m.content)).not.toContain("Prefers smaller floor plates");
  });

  it("inferred memories are never returned as stated", async () => {
    const m = await M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Seems price-sensitive", source: "user", stated: false });
    expect(Number(m.confidence)).toBeLessThan(0.8);
    const r = (await M.recallMemories(ctx, [{ type: "person", id: pid, label: "" }])).find((x) => x.id === m.id)!;
    expect(r.stated).toBe(false); expect(r.content).toMatch(/^\(inferred\)/);
  });

  it("employer-scoped memories don't follow the person to a new employer", async () => {
    const scoped = await M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Needs Alpha procurement sign-off for leases", source: "user", scope: "employer" });
    const general = await M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Prefers short emails", source: "user" });
    let ids = (await M.recallMemories(ctx, [{ type: "person", id: pid, label: "" }])).map((m) => m.id);
    expect(ids).toContain(scoped.id);
    await ctx.db.from("employment").update({ is_current: false }).eq("id", empA);
    await ctx.db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: orgB, is_current: true });
    ids = (await M.recallMemories(ctx, [{ type: "person", id: pid, label: "" }])).map((m) => m.id);
    expect(ids).not.toContain(scoped.id); expect(ids).toContain(general.id);
  });

  it("forgotten and restricted memories are excluded; restricted only on explicit owner request", async () => {
    const f = await M.saveMemory(ctx, { category: "company", entityType: "company", entityId: orgA, content: "Finance approval needed before signing", source: "user" });
    const r = await M.saveMemory(ctx, { category: "company", entityType: "company", entityId: orgA, content: "Board is split on relocation", source: "user" });
    await M.forgetMemory(ctx, f.id); await M.restrictMemory(ctx, r.id);
    expect((await M.getMemory(ctx, f.id))!.content).not.toMatch(/Finance/);
    const ids = (await M.recallMemories(ctx, [{ type: "company", id: orgA, label: "" }])).map((m) => m.id);
    expect(ids).not.toContain(f.id); expect(ids).not.toContain(r.id);
    const withR = (await M.recallMemories(ctx, [{ type: "company", id: orgA, label: "" }], { includeRestricted: true })).map((m) => m.id);
    expect(withR).toContain(r.id); expect(withR).not.toContain(f.id);
    const plan = await memoryTools.find((x) => x.id === "forget_memory")!.plan!({ memory_id: r.id }, { ctx: ctx as never, runId: crypto.randomUUID(), conversationId: null });
    expect(plan.diff[0].after).toBe("(forgotten)");
  });

  it("refuses sensitive categories", async () => {
    await expect(M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Has diabetes, avoid lunch meetings", source: "user" })).rejects.toThrow(/sensitive/);
    expect(M.sensitiveCategory("Prefers Baner over Hinjewadi")).toBeNull();
  });

  it("stale when past review date or unverified for 180 days", () => {
    const now = new Date("2026-11-10T00:00:00Z");
    expect(M.isStale({ review_at: "2026-11-01", last_verified_at: null, captured_at: "2026-10-01T00:00:00Z" }, now)).toBe(true);
    expect(M.isStale({ review_at: null, last_verified_at: null, captured_at: "2026-01-01T00:00:00Z" }, now)).toBe(true);
    expect(M.isStale({ review_at: "2027-04-01", last_verified_at: null, captured_at: "2026-10-01T00:00:00Z" }, now)).toBe(false);
  });

  it("workspace isolation: another workspace's user can't read or recall these memories", async () => {
    const m = await M.saveMemory(ctx, { category: "person", entityType: "person", entityId: pid, content: "Likes site visits on Fridays", source: "user" });
    const other: M.MemCtx = { db: await userClient("other"), workspaceId: WS1, userId: USERS.other.id };
    expect(await M.getMemory(other, m.id)).toBeNull();
    expect(await M.recallMemories(other, [{ type: "person", id: pid, label: "" }])).toEqual([]);
    const { data } = await adminClient().from("assistant_memory").select("workspace_id").eq("id", m.id).single();
    expect(data!.workspace_id).toBe(WS1);
  });
});

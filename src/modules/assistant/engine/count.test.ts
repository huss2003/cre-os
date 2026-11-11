import { describe, it, expect } from "vitest";
import { requestedCount, fillInput, MockProvider } from "./mock";
import { getTool } from "../tools";
import type { ContextPackage } from "../types";

describe("requestedCount", () => {
  it.each([
    ["Which five accounts should I focus on this week?", 5],
    ["Show me the top 3", 3],
    ["top ten companies", 10],
    ["list 7 priority accounts", 7],
    ["give me twenty leads", 20],
    ["Which accounts should I focus on?", null],
    ["Leases expiring in the next 12 months", null],
    ["Find 5000 sq ft options", null],
  ])("%s -> %s", (text, n) => expect(requestedCount(text)).toBe(n));

  it("passes the count as rank_priority_accounts.limit", () => {
    const tool = getTool("rank_priority_accounts")!;
    expect(fillInput(tool.input, { assets: [], request: "Which five accounts should I focus on this week?" })).toEqual({ limit: 5 });
    expect(fillInput(tool.input, { assets: [], request: "Which accounts should I focus on?" })).toEqual({});
  });

  it("mock planner calls the tool with limit and the answer states how many it shows", async () => {
    const pkg = { request: "Which five accounts should I focus on this week?", resolved: [], records: [], attachments: [], missing: [], focus: null } as unknown as ContextPackage;
    const p = new MockProvider(pkg, "priority_accounts");
    const r1 = await p.chat({ messages: [{ role: "user", content: pkg.request }] } as never);
    const use = r1.content[0] as { id: string; name: string; input: unknown };
    expect(use.name).toBe("rank_priority_accounts");
    expect(use.input).toEqual({ limit: 5 });
    const items = Array.from({ length: 5 }, (_, i) => ({ rank: i + 1 }));
    const r2 = await p.chat({ messages: [
      { role: "user", content: pkg.request },
      { role: "assistant", content: [use] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ ok: true, summary: "Top 5 of 40 scored accounts", data: { items } }) }] },
    ] } as never);
    const r3 = r2.stop_reason === "tool_use" ? await p.chat({ messages: [] } as never) : r2;
    expect((r3.content[0] as { text: string }).text).toContain("Showing 5, as you asked for 5.");
  });
});

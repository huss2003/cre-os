import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import { assembleMorningBrief, deliverMorningBrief, leasesEnteringWindows, saveBriefSetting, sinceDate, type BriefCtx } from "./morning";
import { briefDedupeKey, scheduleMorningBriefs } from "./jobs";

const NOW = new Date("2026-11-11T02:30:00Z"); // Wed 08:00 IST

describe("morning brief — pure", () => {
  it("lease windows and since-date", () => {
    expect(sinceDate("2026-11-11")).toBe("2026-11-10");
    expect(sinceDate("2026-11-16")).toBe("2026-11-13"); // Monday covers the weekend
    const hits = leasesEnteringWindows([
      { id: "a", contractual_expiry: "2027-11-11" },   // 12-month window opens today
      { id: "b", contractual_expiry: "2027-05-11" },   // 6-month window opens today
      { id: "c", contractual_expiry: "2027-02-10" },   // 3-month opened 10 Nov — not after since
      { id: "d", contractual_expiry: null },
    ], "2026-11-10", "2026-11-11");
    expect(hits.map((h) => [h.id, h.months])).toEqual([["a", 12], ["b", 6]]);
  });
});

describe("morning brief — db", () => {
  let c: BriefCtx; const t = tag("mb"); const admin = adminClient();
  const jobKeys: string[] = [];
  beforeAll(async () => {
    c = { db: await userClient("colleague"), workspaceId: WS1, userId: USERS.colleague.id, timezone: "Asia/Kolkata" };
    // clean only our own user's brief rows for this date so the test is repeatable
    await admin.from("assistant_morning_brief").delete().eq("workspace_id", WS1).eq("owner_user_id", USERS.colleague.id).eq("brief_date", "2026-11-11");
    const own = { workspace_id: WS1, owner_user_id: USERS.colleague.id };
    await admin.from("task").insert({ ...own, title: `Overdue ${t}`, due_at: "2026-11-09T10:00:00Z", status: "open", assigned_user_id: USERS.colleague.id, source: "manual" });
    await admin.from("lease").insert({ ...own, tenant_name_raw: `Tenant ${t}`, contractual_expiry: "2027-11-11", status: "active" });
  });
  afterAll(async () => { if (jobKeys.length) await admin.from("job").delete().in("dedupe_key", jobKeys); });

  it("assembles deterministic sections", async () => {
    const b = await assembleMorningBrief(c, NOW);
    expect(b.failed).toEqual([]);
    const json = JSON.stringify(b.blocks);
    expect(json).toContain(`Overdue ${t} (overdue)`);
    expect(json).toContain(`Tenant ${t} — 12 months to expiry`);
    expect(b.title).toMatch(/Morning brief — Wed 11 Nov 2026/);
  });

  it("a failing source is labelled, not hidden (S10)", async () => {
    const broken = new Proxy(c.db, { get: (target, p) => p === "from" ? (tbl: string) => tbl === "lease" ? { select: () => { throw new Error("boom"); } } : target.from(tbl) : Reflect.get(target, p) });
    const b = await assembleMorningBrief({ ...c, db: broken }, NOW);
    expect(b.failed).toEqual(["Leases"]);
    expect(JSON.stringify(b.blocks)).toMatch(/Not checked — leases/);
  });

  it("delivers once per user per day as a pinned conversation", async () => {
    const r1 = await deliverMorningBrief(c, NOW);
    expect(r1.duplicate).toBe(false);
    const r2 = await deliverMorningBrief(c, NOW);
    expect(r2.duplicate).toBe(true); expect(r2.conversationId).toBe(r1.conversationId);
    const { data: conv } = await admin.from("assistant_conversation").select("title, pinned").eq("id", r1.conversationId!).single();
    expect(conv!.pinned).toBe(true); expect(conv!.title).toMatch(/^Morning brief — /);
    const { data: msgs } = await admin.from("assistant_message").select("blocks").eq("conversation_id", r1.conversationId!);
    expect(msgs).toHaveLength(1);
  });

  it("schedules only opted-in users, with a per-user-per-day dedupe key", async () => {
    await saveBriefSetting(c, { enabled: false });
    let keys = await scheduleMorningBriefs(admin, NOW, async () => {}, WS1);
    expect(keys).not.toContain(briefDedupeKey(USERS.colleague.id, "2026-11-11"));
    const s = await saveBriefSetting(c, { enabled: true, time: "08:00" }, new Date("2026-11-10T05:00:00Z"));
    expect(s.next_run_at).toMatch(/^2026-11-11T02:30:00/);
    const seen: string[] = [];
    keys = await scheduleMorningBriefs(admin, NOW, async (o) => { seen.push(o.dedupeKey); }, WS1);
    expect(seen).toContain(briefDedupeKey(USERS.colleague.id, "2026-11-11"));
    // advanced to Thursday 08:00 IST → not due again now
    keys = await scheduleMorningBriefs(admin, NOW, async () => {}, WS1);
    expect(keys).not.toContain(briefDedupeKey(USERS.colleague.id, "2026-11-11"));
    await saveBriefSetting(c, { enabled: false });
  });
});

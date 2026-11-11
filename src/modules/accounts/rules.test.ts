import { describe, expect, it } from "vitest";
import { bestChannel, diffSince, groupStakeholders, nextActions, scoreDelta, suggestLevel, timeboxed, type StakePerson } from "./rules";

describe("suggestLevel (spec 2.3)", () => {
  it("no interactions → not interacted", () => expect(suggestLevel([]).level).toBe("not_interacted"));
  it("outbound email only → not interacted", () => expect(suggestLevel([{ channel: "email", direction: "outbound" }]).level).toBe("not_interacted"));
  it("call → spoke on call", () => expect(suggestLevel([{ channel: "call", direction: "outbound" }]).level).toBe("spoke_on_call"));
  it("inbound reply → spoke on call", () => expect(suggestLevel([{ channel: "email", direction: "inbound" }]).level).toBe("spoke_on_call"));
  it("one meeting → met once", () => expect(suggestLevel([{ channel: "call" }, { channel: "meeting" }]).level).toBe("met_once"));
  it("several meetings/visits → met a few times", () => expect(suggestLevel([{ channel: "meeting" }, { channel: "visit" }]).level).toBe("met_few"));
  it("never suggests Good relationship, however many meetings", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ channel: i % 2 ? "meeting" : "call", direction: "inbound" }));
    expect(suggestLevel(many).level).not.toBe("good");
  });
  it("recent 'not interested' objection wins", () => {
    const s = suggestLevel([{ channel: "meeting", occurred_at: "2026-01-01" }, { channel: "call", occurred_at: "2026-11-01", objections: [{ text: "Not interested right now" }] }]);
    expect(s.level).toBe("not_interested");
  });
  it("old objection outside the latest 3 is ignored", () => {
    const ints = [{ channel: "call", occurred_at: "2025-01-01", objections: ["not interested"] }, ...["2026-01-01", "2026-02-01", "2026-03-01"].map((d) => ({ channel: "meeting", occurred_at: d }))];
    expect(suggestLevel(ints).level).toBe("met_few");
  });
});

describe("groupStakeholders", () => {
  const p = (o: Partial<StakePerson>): StakePerson => ({ personId: Math.random().toString(), name: "X", title: null, department: null, roleClass: null, stakeholderRoles: [], level: null, channel: null, current: true, ...o });
  it("groups by function, orders by influence, drops past employees", () => {
    const g = groupStakeholders([
      p({ name: "Fin user", title: "Finance analyst", roleClass: "operational" }),
      p({ name: "CFO", title: "CFO", roleClass: "economic_buyer" }),
      p({ name: "RE head", title: "Head of Real Estate", roleClass: "decision_maker" }),
      p({ name: "Gone", title: "Facilities manager", current: false }),
      p({ name: "Mystery", title: null }),
    ]);
    expect(g.map((x) => x.fn)).toEqual(["real_estate", "finance", "other"]);
    expect(g[0].people.map((x) => x.name)).toEqual(["RE head"]);
    expect(g[0].people[0].influence).toBe("decides");
    expect(g[1].people.map((x) => x.name)).toEqual(["CFO", "Fin user"]);
    expect(g[2].people[0].influence).toBe("unknown");
  });
  it("stakeholder role on a requirement sets influence when no assessment", () => {
    expect(groupStakeholders([p({ title: "Admin manager", stakeholderRoles: ["final signatory"] })])[0].people[0].influence).toBe("approves");
  });
  it("a person counted once per group", () => {
    const x = p({ personId: "same", title: "CFO" });
    expect(groupStakeholders([x, { ...x }])[0].people).toHaveLength(1);
  });
});

describe("bestChannel", () => {
  it("prefers the most recently verified, ignores suppressed, null when none verified", () => {
    expect(bestChannel([{ method_type: "email", verified_on: "2026-01-01" }, { method_type: "phone", verified_on: "2026-06-01" }, { method_type: "mobile", verified_on: "2026-09-01", suppressed: true }])).toEqual({ type: "phone", verifiedOn: "2026-06-01" });
    expect(bestChannel([{ method_type: "email", verified_on: null }])).toBeNull();
  });
});

describe("diffSince (what changed)", () => {
  const rows = [
    { id: "a", label: "old", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: "b", label: "edited", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-11-05T00:00:00Z" },
    { id: "c", label: "new", created_at: "2026-11-06T00:00:00Z" },
  ];
  it("first visit has no baseline → nothing", () => expect(diffSince(null, { signal: rows })).toEqual([]));
  it("lists new and updated rows after the last view, newest first", () => {
    const d = diffSince("2026-11-01T00:00:00Z", { signal: rows, lease: [{ id: "l", label: "Tower A", created_at: "2026-11-02T00:00:00Z" }] });
    expect(d.map((x) => `${x.kind}:${x.id}:${x.what}`)).toEqual(["signal:c:new", "signal:b:updated", "lease:l:new"]);
  });
  it("nothing changed → empty", () => expect(diffSince("2026-12-01T00:00:00Z", { signal: rows })).toEqual([]));
});

describe("scoreDelta", () => {
  it("unknown previous stays unknown", () => { expect(scoreDelta(50, null)).toBeNull(); expect(scoreDelta(50, 42)).toBe(8); expect(scoreDelta(null, 3)).toBeNull(); });
});

describe("nextActions", () => {
  it("deterministic list from gaps, dated items first", () => {
    const a = nextActions({ orgId: "o", openOppsWithAction: [{ id: "d", name: "Deal", next_action: "Send options", next_action_due: "2026-11-20" }], requirements: [{ id: "r", title: "GCC", missing: ["Budget"] }], leaseEvents: [{ lease_id: "l", event_type: "expiry", event_date: "2027-03-01" }, { lease_id: "l", event_type: "lockin_end", event_date: "2020-01-01" }], peopleCount: 0, hasDecider: false, lastInteractionAt: null, unverifiedSignals: 2, today: "2026-11-11" });
    expect(a[0].key).toBe("opp:d");
    expect(a.map((x) => x.key)).toEqual(expect.arrayContaining(["lease:l:expiry", "req:r", "people", "first-touch", "signals"]));
    expect(a.some((x) => x.key.includes("lockin_end"))).toBe(false);
  });
});

describe("timeboxed", () => {
  it("returns a visible failure on timeout or error", async () => {
    expect(await timeboxed(new Promise((r) => setTimeout(() => r(1), 200)), 20)).toMatchObject({ ok: false });
    expect(await timeboxed(Promise.reject(new Error("boom")))).toEqual({ ok: false, error: "boom" });
    expect(await timeboxed(async () => 3)).toEqual({ ok: true, data: 3 });
  });
});

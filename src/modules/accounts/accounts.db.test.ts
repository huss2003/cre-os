// Account & contact workspaces against the local DB (RLS on, seeded owner in WS1).
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, WS2, tag } from "../../../tests/helpers";
import { loadAccount, setLevel, levelHistory, currentLevels, loadContactExtras } from "./service";

describe("accounts workspace", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; let org: string; let person: string; const t = tag("acct");
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    org = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `Acct Co ${t}` }).select("id").single()).data!.id;
    person = (await db.from("person").insert({ workspace_id: WS1, full_name: `Priya ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: person, org_id: org, title: "Head of Real Estate", is_current: true, fact_status: "reported" });
  });

  it("relationship level: manual setter keeps history; same level is a no-op; invalid rejected", async () => {
    await setLevel(db, WS1, owner, person, "spoke_on_call", "intro call");
    await setLevel(db, WS1, owner, person, "met_once", "coffee");
    expect((await setLevel(db, WS1, owner, person, "met_once", "again")).unchanged).toBe(true);
    await expect(setLevel(db, WS1, owner, person, "best_friends", "")).rejects.toThrow();
    const h = await levelHistory(db, WS1, person);
    expect(h.map((x: { level: string }) => x.level)).toEqual(["met_once", "spoke_on_call"]);
    expect((await currentLevels(db, WS1, [person])).get(person)?.level).toBe("met_once");
  });

  it("other workspace can't see or set the level", async () => {
    await expect(setLevel(db, WS2, owner, person, "good", "")).rejects.toThrow();
  });

  it("first visit has no baseline; second visit lists new interactions; stakeholder map groups the person", async () => {
    const a1 = await loadAccount(db, WS1, owner, org);
    expect(a1.viewedAt).toBeNull();
    expect(a1.changes).toEqual([]);
    for (const k of ["opps", "reqs", "leases", "signals", "people", "warm", "timeline", "meetings", "documents", "scores", "tasks", "transactions"] as const) expect([k, a1[k]]).toEqual([k, expect.objectContaining({ ok: true })]);
    expect(a1.people.ok && a1.people.data.groups[0].fn).toBe("real_estate");
    expect(a1.people.ok && a1.people.data.groups[0].people[0].level).toBe("met_once");
    await new Promise((r) => setTimeout(r, 20));
    const i = (await db.from("interaction").insert({ workspace_id: WS1, channel: "meeting", occurred_at: new Date().toISOString(), subject: `Site tour ${t}` }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "organisation", entity_id: org });
    const a2 = await loadAccount(db, WS1, owner, org);
    expect(a2.viewedAt).not.toBeNull();
    expect(a2.changes.some((c) => c.kind === "interaction" && c.id === i && c.what === "new")).toBe(true);
    const a3 = await loadAccount(db, WS1, owner, org);
    expect(a3.changes).toEqual([]);
  });

  it("contact extras suggest a level from interactions without ever writing it", async () => {
    const i = (await db.from("interaction").insert({ workspace_id: WS1, channel: "call", occurred_at: new Date().toISOString() }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: i, entity_type: "person", entity_id: person });
    const x = await loadContactExtras(db, WS1, person);
    expect(x.suggestion?.level).toBe("spoke_on_call");
    expect(x.current?.level).toBe("met_once");
  });
});

/** Bug hunt M2/M3: validate before creating the company; company name matched exactly (no LIKE wildcards). */
import { describe, it, expect, beforeAll } from "vitest";
import { USERS, WS1, tag, userClient } from "../../../../tests/helpers";
import { DealsError, type DealsCtx } from "../ctx";
import { createRequirement } from "./service";

let owner: DealsCtx;
beforeAll(async () => { owner = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id, role: "owner" }; });

const orgs = async (name: string) => ((await owner.db.from("organisation").select("id").eq("workspace_id", WS1).eq("display_name", name)).data ?? []) as { id: string }[];

describe("createRequirement validation order", () => {
  it("does not create the new company when a value is invalid", async () => {
    const name = `Orphan ${tag("orph")}`;
    const e = await createRequirement(owner, { title: "x", orgName: name, changes: [{ key: "area", value: ["abc", "", ""] }] }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(DealsError);
    expect(await orgs(name)).toHaveLength(0);
    const e2 = await createRequirement(owner, { title: "x", orgName: name, changes: [{ key: "area", value: ["900", "", "100"] }] }).then(() => null, (x) => x);
    expect(e2).toBeInstanceOf(DealsError);
    expect(await orgs(name)).toHaveLength(0);
  });

  it("treats % and _ in a typed company name literally", async () => {
    const t = tag("abc");
    const existing = (await owner.db.from("organisation").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, display_name: `AXB Corp ${t}` }).select("id").single()).data as { id: string };
    const r = await createRequirement(owner, { title: `Req ${t}`, orgName: `A_B Corp ${t}` }) as { org_id: string };
    expect(r.org_id).not.toBe(existing.id);
    const again = await createRequirement(owner, { title: `Req2 ${t}`, orgName: `a_b corp ${t}` }) as { org_id: string };
    expect(again.org_id).toBe(r.org_id); // exact, case-insensitive match reuses it
  });
});

import { describe, it, expect } from "vitest";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "./helpers";

describe("tenant + account isolation (spec: Permissions acceptance test)", () => {
  it("other tenant cannot read tenant one records; colleague sees only own/shared", async () => {
    const owner = await userClient("owner");
    const name = tag("Acme");
    const { data: org, error } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: name }).select().single();
    expect(error).toBeNull();

    const other = await userClient("other");
    const { data: seenByOther } = await other.from("organisation").select("id").eq("id", org.id);
    expect(seenByOther).toEqual([]);
    const { error: crossInsert } = await other.from("organisation").insert({ workspace_id: WS1, display_name: "x" });
    expect(crossInsert).not.toBeNull();

    const col = await userClient("colleague");
    const { data: before } = await col.from("organisation").select("id").eq("id", org.id);
    expect(before).toEqual([]);
    await adminClient().from("record_share").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, user_id: USERS.colleague.id });
    const { data: after } = await col.from("organisation").select("id").eq("id", org.id);
    expect(after?.length).toBe(1);
    expect(WS2).not.toBe(WS1);
  });

  it("licensed_restricted rows hidden from colleague without that classification", async () => {
    const owner = await userClient("owner");
    const { data: org } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag("Lic"), classification: "licensed_restricted", owner_user_id: USERS.colleague.id }).select().single();
    const col = await userClient("colleague");
    const { data } = await col.from("organisation").select("id").eq("id", org.id);
    expect(data).toEqual([]);
  });

  it("row_version increments and audit is append-only", async () => {
    const owner = await userClient("owner");
    const { data: org } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag("Ver") }).select().single();
    const { data: upd } = await owner.from("organisation").update({ sector: "IT" }).eq("id", org.id).eq("row_version", 1).select().single();
    expect(upd.row_version).toBe(2);
    const { data: stale } = await owner.from("organisation").update({ sector: "BFSI" }).eq("id", org.id).eq("row_version", 1).select();
    expect(stale).toEqual([]);
    const { data: audit } = await owner.from("audit_event").select("id, action").eq("entity_id", org.id);
    expect(audit?.map((a) => a.action)).toEqual(expect.arrayContaining(["insert", "update"]));
    const { error: del } = await owner.from("audit_event").delete().eq("entity_id", org.id);
    const { data: still } = await owner.from("audit_event").select("id").eq("entity_id", org.id);
    expect(del !== null || (still?.length ?? 0) >= 2).toBe(true);
  });
});

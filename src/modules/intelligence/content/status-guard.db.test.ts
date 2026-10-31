import { afterAll, describe, expect, it } from "vitest";
import { adminClient, userClient, tag, WS1 } from "../../../../tests/helpers";

const ids: string[] = [];
afterAll(async () => { if (ids.length) await adminClient().from("content_post").delete().in("id", ids); });

describe("Content Editor (20) — approval rules enforced in the database", () => {
  it("an editor cannot set 'approved' directly when the checklist is not passing, nor publish without approval", async () => {
    const owner = await userClient("owner");
    const t = tag("guard");
    const { data: post, error } = await owner.from("content_post").insert({
      workspace_id: WS1, week_start: "2026-11-02", topic: `Guard ${t}`, body: "Rents rose 12%.",
      review_checklist: [{ key: "facts", label: "Facts match evidence", ok: false }], status: "drafted",
    }).select().single();
    expect(error).toBeNull();
    ids.push(post!.id);
    const a = await owner.from("content_post").update({ status: "approved" }).eq("id", post!.id);
    expect(a.error?.message).toMatch(/cannot be approved/);
    const p = await owner.from("content_post").update({ status: "published_manually" }).eq("id", post!.id);
    expect(p.error?.message).toMatch(/must be approved/);
  });

  it("editing an approved post's body drops it back to review", async () => {
    const owner = await userClient("owner");
    const { data: post } = await owner.from("content_post").insert({
      workspace_id: WS1, week_start: "2026-11-02", topic: `Guard ${tag("ok")}`, body: "Plain advice.",
      review_checklist: [{ key: "facts", label: "Facts match evidence", ok: true }], status: "drafted",
    }).select().single();
    ids.push(post!.id);
    const a = await owner.from("content_post").update({ status: "approved" }).eq("id", post!.id).select().single();
    expect(a.error).toBeNull();
    expect(a.data!.status).toBe("approved");
    const e = await owner.from("content_post").update({ body: "Plain advice, edited." }).eq("id", post!.id).select().single();
    expect(e.data!.status).toBe("in_review");
  });
});

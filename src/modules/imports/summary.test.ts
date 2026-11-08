// Bulk import review: lanes + chunked "apply all safe" (duplicates/conflicts never auto-applied).
import { describe, it, expect } from "vitest";
import { proposeChange } from "@/lib/services/changes";
import { userClient, WS1, USERS, tag } from "../../../tests/helpers";
import { laneOf, applySafeChunk } from "./summary";

describe("import summary lanes", () => {
  it("classifies conflicts and same-name people as Check, plain creates as Safe", () => {
    expect(laneOf({ id: "1", target_type: "person", operation: "create", idempotency_key: "imports.person:x", reason: "Creates a new person" })).toBe("safe");
    expect(laneOf({ id: "2", target_type: "person", operation: "create", idempotency_key: "imports.person:y", reason: "— 1 existing person(s) share this name; they are NOT merged automatically" })).toBe("check");
    expect(laneOf({ id: "3", target_type: "organisation", operation: "update", idempotency_key: "imports.conflict:z", reason: "Import conflict" })).toBe("check");
  });

  it("applies only safe proposals from that file, in one chunk", async () => {
    const db = await userClient("owner");
    const t = tag("bulk");
    const src = (await db.from("source_object").insert({ workspace_id: WS1, kind: "file", uri: `test://${t}`, sha256: t.padEnd(64, "0").slice(0, 64), file_name: `${t}.xlsx` }).select("id").single()).data!.id;
    const mk = (name: string, reason: string) => proposeChange(db, WS1, { targetType: "person", operation: "create", patch: [{ op: "add", path: "/full_name", value: name }],
      reason, evidenceIds: [src], proposedByKind: "job", idempotencyKey: `imports.person:${t}:${name}`, ownerUserId: USERS.owner.id });
    await mk(`Safe One ${t}`, "Creates a new person");
    await mk(`Safe Two ${t}`, "Creates a new person");
    await mk(`Dup ${t}`, "Creates a new person — 1 existing person(s) share this name; they are NOT merged automatically");
    const r = await applySafeChunk(db, WS1, USERS.owner.id, src);
    expect(r.applied).toBe(2);
    expect(r.remaining).toBe(0);
    const { data: ppl } = await db.from("person").select("full_name").eq("workspace_id", WS1).like("full_name", `%${t}`);
    expect((ppl ?? []).map((p) => p.full_name).sort()).toEqual([`Safe One ${t}`, `Safe Two ${t}`]);
  });
});

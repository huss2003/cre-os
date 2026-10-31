import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";
import { setAiPaused, assertIngestionAllowed, IngestionPausedError } from "./killswitch";

// Uses a private throwaway workspace so toggling the kill switch never affects other modules' tests on WS1.
describe("kill switch (POST /v1/admin/pause)", () => {
  const admin = adminClient();
  let wsId = "";
  beforeAll(async () => {
    const slug = tag("ks").toLowerCase();
    const { data: ws, error } = await admin.from("workspace").insert({ name: `Kill switch ${slug}`, slug }).select().single();
    if (error) throw error;
    wsId = ws.id;
    await admin.from("membership").insert({ workspace_id: wsId, user_id: USERS.owner.id, role: "owner", see_all_accounts: true,
      allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] });
  });
  afterAll(async () => {
    if (wsId) await admin.from("workspace").delete().eq("id", wsId);
  });

  const call = () => callStructured({
    workspaceId: wsId, workflow: "admin.test", system: "s", input: "i",
    schema: z.object({ ok: z.boolean() }), schemaName: "t", mock: () => ({ ok: true }),
  });

  it("pausing blocks AI gateway calls with AiUnavailableError('paused'); resuming restores them", async () => {
    const owner = await userClient("owner");
    expect((await call()).data.ok).toBe(true);
    await setAiPaused(owner, wsId, true, "suspected compromise drill");
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).reason).toBe("paused");
    await expect(assertIngestionAllowed(admin, wsId)).rejects.toBeInstanceOf(IngestionPausedError);

    // internal records keep working while paused
    const { error } = await owner.from("task").insert({ workspace_id: wsId, title: "Internal task while paused" });
    expect(error).toBeNull();

    const { data: audit } = await admin.from("audit_event").select("action").eq("workspace_id", wsId).eq("entity_type", "workspace");
    expect(audit?.map((a) => a.action)).toContain("pause");

    await setAiPaused(owner, wsId, false);
    expect((await call()).data.ok).toBe(true);
    await expect(assertIngestionAllowed(admin, wsId)).resolves.toBeUndefined();
  });

  it("non-members / non-admins cannot toggle it", async () => {
    const colleague = await userClient("colleague");
    await expect(setAiPaused(colleague, wsId, true)).rejects.toThrow(/admin/);
    const { data } = await admin.from("workspace").select("ai_paused").eq("id", wsId).single();
    expect(data?.ai_paused).toBe(false);
  });
});

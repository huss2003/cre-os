import { describe, it, expect } from "vitest";
import { z } from "zod";
import { adminClient, WS2, tag } from "./helpers";
import { callStructured, AiUnavailableError } from "@/lib/ai/gateway";

const schema = z.object({ ok: z.boolean() });
const call = (extra: Record<string, unknown> = {}) =>
  callStructured({ workspaceId: WS2, workflow: "test.lanes", system: "s", input: "i", schema, schemaName: "t", mock: () => ({ ok: true }), ...extra });

describe("AI gateway data-lane and licence enforcement", () => {
  it("blocks licensed-restricted data without a lane, licence without AI permission, and unapproved lanes", async () => {
    const admin = adminClient();
    expect((await call()).data.ok).toBe(true);
    await expect(call({ classification: "licensed_restricted" })).rejects.toBeInstanceOf(AiUnavailableError);

    const { data: src } = await admin.from("licensed_source").insert({ workspace_id: WS2, name: tag("Matrix"), permits_ai_processing: false }).select().single();
    await expect(call({ licensedSourceIds: [src.id] })).rejects.toThrow(/licence/);

    const { data: lane } = await admin.from("data_lane").insert({ workspace_id: WS2, name: tag("lane"), allowed_classifications: ["public"], approved_processors: ["openai"], approved_at: new Date().toISOString() }).select().single();
    await expect(call({ classification: "corporate_confidential" })).rejects.toThrow(/data lane/);
    expect((await call({ classification: "public" })).data.ok).toBe(true);

    await admin.from("data_lane").delete().eq("id", lane.id);
    await admin.from("licensed_source").delete().eq("id", src.id);
  });
});

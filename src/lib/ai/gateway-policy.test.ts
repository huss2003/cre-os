import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// Fake service-role client: ai.modes turns brief.synthesis/transcribe off; records every insert.
const inserts: { table: string; row: Record<string, unknown> }[] = [];
const modes = { "brief.synthesis": "off", "transcribe": "off", "capture.ocr": "off" };
vi.mock("@/lib/supabase/admin", () => {
  const q = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self, gte: self,
      maybeSingle: async () => ({ data: table === "workspace_setting" ? { value: modes } : null }),
      single: async () => ({ data: { ai_paused: false } }),
      insert: async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; },
    });
    return chain;
  };
  return { createAdminClient: () => ({ from: q }) };
});

import { callStructured, transcribe, extractImageText, AiDisabledError, AiUnavailableError } from "./gateway";

describe("gateway honours AI policy 'off'", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => { inserts.length = 0; vi.stubGlobal("fetch", fetchSpy); process.env.ANTHROPIC_API_KEY = "sk-test"; process.env.OPENAI_API_KEY = "sk-test"; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; fetchSpy.mockReset(); });

  const base = { workspaceId: "11111111-1111-1111-1111-111111111111", system: "s", input: "i", schema: z.object({ ok: z.boolean() }), schemaName: "t" };

  it("returns the deterministic mock result with no fetch and no model_usage row; counts calls_saved", async () => {
    const r = await callStructured({ ...base, workflow: "brief.synthesis", mock: () => ({ ok: true }) });
    expect(r).toMatchObject({ data: { ok: true }, mocked: true, disabled: true, model: "code" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === "model_usage")).toBe(false);
    expect(inserts.find((i) => i.table === "resource_usage")?.row).toMatchObject({ module: "ai", unit: "calls_saved", workflow: "brief.synthesis", units: 1 });
  });
  it("without a mock, throws typed AiDisabledError (an AiUnavailableError, reason ai_disabled)", async () => {
    const e = await callStructured({ ...base, workflow: "brief.synthesis" }).catch((x) => x);
    expect(e).toBeInstanceOf(AiDisabledError);
    expect(e).toBeInstanceOf(AiUnavailableError);
    expect(e.reason).toBe("ai_disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("transcribe and extractImageText skip the provider when off", async () => {
    expect(await transcribe({ workspaceId: base.workspaceId, audio: Buffer.from(""), filename: "a.webm", mockText: "hi" })).toMatchObject({ text: "hi", disabled: true });
    await expect(transcribe({ workspaceId: base.workspaceId, audio: Buffer.from(""), filename: "a.webm" })).rejects.toBeInstanceOf(AiDisabledError);
    expect(await extractImageText({ workspaceId: base.workspaceId, image: Buffer.from(""), mimeType: "image/png", workflow: "capture.document_ocr", mock: () => "local" })).toMatchObject({ text: "local", disabled: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(inserts.some((i) => i.table === "model_usage")).toBe(false);
  });
});

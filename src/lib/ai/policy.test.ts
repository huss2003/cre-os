import { describe, it, expect, vi } from "vitest";
import { FEATURES, FEATURE_KEYS, defaultModes, featureForWorkflow, getAiMode, resolveModes, runWithPolicy, type AiMode } from "./policy";

const fakeDb = (value: unknown) => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value } }) }) }) }) }),
});

describe("AI policy registry & defaults", () => {
  it("groups carry the agreed defaults", () => {
    for (const k of FEATURE_KEYS) {
      const f = FEATURES[k];
      expect(f.default).toBe(({ code: "off", code_first: "backup", ai_needed: "on" } as const)[f.group]);
    }
    const d = defaultModes();
    expect(d["brief.synthesis"]).toBe("off");
    expect(d["capture.extract"]).toBe("backup");
    expect(d["transcribe"]).toBe("on");
  });
  it("maps workflows to features (exact > longest prefix, unknown → null)", () => {
    expect(featureForWorkflow("capture.document_ocr")).toBe("capture.ocr");
    expect(featureForWorkflow("assistant.lease_terms")).toBe("capture.lease_terms");
    expect(featureForWorkflow("intelligence.memory.summary.company")).toBe("intelligence.memory");
    expect(featureForWorkflow("assistant.summarise")).toBe("assistant.summarise");
    expect(featureForWorkflow("assistant.route")).toBe("assistant.routing");
    expect(featureForWorkflow("assistant.deep")).toBe("assistant.answer");
    expect(featureForWorkflow("admin.test")).toBeNull();
  });
  it("every workflow belongs to exactly one feature", () => {
    const seen = new Map<string, string>();
    for (const k of FEATURE_KEYS) for (const w of FEATURES[k].workflows as string[]) { expect(seen.has(w), w).toBe(false); seen.set(w, k); }
  });
  it("resolveModes ignores junk and merges over defaults", () => {
    const m = resolveModes({ "brief.synthesis": "on", "transcribe": "nope", "bogus": "off" });
    expect(m["brief.synthesis"]).toBe("on");
    expect(m["transcribe"]).toBe("on");
    expect("bogus" in m).toBe(false);
  });
  it("getAiMode reads ai.modes, falls back to defaults, accepts feature key or workflow", async () => {
    expect(await getAiMode(fakeDb(undefined), "ws", "brief.synthesis")).toBe("off");
    expect(await getAiMode(fakeDb({ "brief.synthesis": "backup" }), "ws", "brief.synthesis")).toBe("backup");
    expect(await getAiMode(fakeDb({ "capture.ocr": "off" }), "ws", "capture.document_ocr")).toBe("off");
    expect(await getAiMode(fakeDb({}), "ws", "admin.test")).toBe("on");
    expect(await getAiMode({ from: () => { throw new Error("db down"); } }, "ws", "transcribe")).toBe("on");
  });
});

describe("runWithPolicy matrix", () => {
  const run = (mode: AiMode, codeVal: string | null, aiOk: boolean, accept?: (s: string) => boolean) => {
    const ai = vi.fn(async () => { if (!aiOk) throw new Error("ai failed"); return "ai"; });
    const code = vi.fn(() => codeVal);
    return runWithPolicy({ mode, code, ai, accept }).then((r) => ({ ...r, aiCalls: ai.mock.calls.length, codeCalls: code.mock.calls.length }));
  };
  it("off: code only, never AI", async () => {
    expect(await run("off", "code", true)).toMatchObject({ value: "code", source: "code", aiCalls: 0 });
    expect(await run("off", null, true)).toMatchObject({ value: null, source: "none", aiCalls: 0 });
  });
  it("backup: code wins when it answers; AI only on null / rejected", async () => {
    expect(await run("backup", "code", true)).toMatchObject({ value: "code", source: "code", aiCalls: 0 });
    expect(await run("backup", null, true)).toMatchObject({ value: "ai", source: "ai", aiCalls: 1 });
    expect(await run("backup", "weak", true, (s) => s !== "weak")).toMatchObject({ value: "ai", source: "ai", aiCalls: 1 });
    expect(await run("backup", "weak", false, (s) => s !== "weak")).toMatchObject({ value: "weak", source: "code" });
    expect(await run("backup", null, false)).toMatchObject({ value: null, source: "none" });
  });
  it("on: AI first, code on AI failure", async () => {
    expect(await run("on", "code", true)).toMatchObject({ value: "ai", source: "ai", codeCalls: 0 });
    const r = await run("on", "code", false);
    expect(r).toMatchObject({ value: "code", source: "code", codeCalls: 1 });
    expect(r.aiError).toBeInstanceOf(Error);
  });
});

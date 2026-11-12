import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const aiSpy = vi.fn(async () => ({ text: "AI READ", mocked: false, model: "vision" }));
vi.mock("@/lib/ai/gateway", () => ({ extractImageText: (...a: unknown[]) => aiSpy(...(a as [])) }));

import { ocrImage, terminateOcr } from "@/lib/ocr/local";
import { parseBusinessCard } from "./docs/card";
import { ocrWithPolicy } from "./ocr";

const fixture = (n: string) => readFileSync(path.resolve(__dirname, "../../../tests/fixtures/ocr", n));
afterAll(() => terminateOcr());
beforeEach(() => aiSpy.mockClear());

describe("local OCR (tesseract.js, offline language data)", () => {
  it("reads a business card PNG and the card parser fills the fields with no AI", async () => {
    const r = await ocrImage(fixture("card.png"), { langs: ["eng", "hin"] });
    expect(r.confidence).toBeGreaterThan(0.6);
    expect(r.text).toContain("rahul.mehta@acmerealty.in");
    const card = parseBusinessCard(r.text) as unknown as Record<string, unknown>;
    expect(JSON.stringify(card)).toContain("rahul.mehta@acmerealty.in");
    expect(JSON.stringify(card)).toMatch(/98220\s?12345/);
    expect(JSON.stringify(card)).toContain("Rahul Mehta");
  }, 120_000);
  it("reads lease terms text from a screenshot", async () => {
    const r = await ocrImage(fixture("lease.png"));
    expect(r.text).toMatch(/Rs 85 per sq ft per month/);
    expect(r.words.length).toBeGreaterThan(5);
  }, 120_000);
});

describe("ocrWithPolicy — modes", () => {
  const img = new Uint8Array([1, 2, 3]);
  const base = { db: null, workspaceId: "ws", image: img, mimeType: "image/png", workflow: "capture.ocr" as const, hint: "h", mock: () => "" };
  const good = async () => ({ text: "Clear text here", confidence: 0.92 });
  const weak = async () => ({ text: "c1e@r t3xt", confidence: 0.3 });
  it("off: never calls AI, even when local OCR is weak", async () => {
    const r = await ocrWithPolicy({ ...base, mode: "off", local: weak });
    expect(aiSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ source: "code", text: "c1e@r t3xt" });
  });
  it("backup: confident local read → no AI", async () => {
    const r = await ocrWithPolicy({ ...base, mode: "backup", local: good });
    expect(aiSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ source: "code", model: "tesseract-local", mocked: false });
  });
  it("backup: low confidence or unreadable → AI vision", async () => {
    expect((await ocrWithPolicy({ ...base, mode: "backup", local: weak })).text).toBe("AI READ");
    expect((await ocrWithPolicy({ ...base, mode: "backup", local: async () => null })).source).toBe("ai");
    expect(aiSpy).toHaveBeenCalledTimes(2);
  });
  it("backup without an API key keeps the weak local text instead of the empty mock", async () => {
    aiSpy.mockResolvedValueOnce({ text: "", mocked: true, model: "mock:x" });
    const r = await ocrWithPolicy({ ...base, mode: "backup", local: weak });
    expect(r).toMatchObject({ source: "code", text: "c1e@r t3xt" });
  });
  it("on: AI first", async () => {
    const r = await ocrWithPolicy({ ...base, mode: "on", local: good });
    expect(r.source).toBe("ai");
  });
});

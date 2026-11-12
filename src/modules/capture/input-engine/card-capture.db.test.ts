/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
/** Photo capture of a business card read by local OCR (no AI): card fields become observations + a person proposal. */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { userClient, adminClient, USERS, WS1, tag } from "../../../../tests/helpers";
import { createCapture } from "../service";
import { processAndAnalyse, observationsFor } from "./service";

async function cardPng(lines: string[]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${120 + lines.length * 80}"><rect width="100%" height="100%" fill="white"/>` +
    lines.map((l, i) => `<text x="60" y="${110 + i * 80}" font-family="DejaVu Sans, Arial, sans-serif" font-size="48" fill="black">${l}</text>`).join("") + `</svg>`;
  const b = await sharp(Buffer.from(svg)).png().toBuffer();
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("business card photo capture (local OCR)", () => {
  it("writes card fields as observations and proposes the contact", async () => {
    const admin = adminClient();
    const db = await userClient("owner");
    const t = tag("card");
    const sur = `Mehta${t.slice(-4)}`.replace(/[^A-Za-z]/g, "") ;
    const name = `Priya ${sur[0].toUpperCase()}${sur.slice(1).toLowerCase()}`;
    const bytes = await cardPng([name, "Head of Finance", "ABC Technologies Pvt Ltd", "priya.mehta@abctech.example", "+91 98220 12345"]);
    const { capture } = await createCapture(db, WS1, USERS.owner.id, { kind: "image", file: { name: `card-${t}.png`, type: "image/png", bytes } }, `${t}-cap`);
    const { engine } = await processAndAnalyse(admin, WS1, capture.id, { ocr: undefined });
    const { data: cap } = await admin.from("capture").select("transcript, status, error").eq("id", capture.id).single();
    const obs: any[] = await observationsFor(db, WS1, { captureId: capture.id }) as any;
    const fields = obs.map((o) => o.field);
    expect(cap?.transcript, JSON.stringify(cap)).toMatch(/priya\.mehta@abctech\.example/i);
    expect(fields, JSON.stringify({ fields, engine: engine?.receipt })).toEqual(expect.arrayContaining(["contact_name", "contact_title", "company_name", "contact_email", "contact_phone"]));
    const { data: props } = await admin.from("change_proposal").select("target_type, patch").eq("workspace_id", WS1).eq("capture_id", capture.id);
    expect((props ?? []).some((p: any) => p.target_type === "person"), JSON.stringify(props)).toBe(true);
    await admin.storage.from("mudar-workspace-files").remove(capture.storage_paths);
  }, 120_000);
});

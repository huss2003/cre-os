/**
 * Demo data for the "ai-settings" tutorial videos (Settings → AI use, local OCR). Local Supabase + demo workspace ONLY.
 *   - Resets the demo workspace's AI modes to the defaults (deletes workspace_setting "ai.modes").
 *     With --ocr-off it then sets "Reading text from images & scans" (capture.ocr) to Off — the owner cannot save this page in
 *     the demo without two-step sign-in, so the videos show an already-changed feature instead of saving one.
 *   - Writes a synthetic business-card photo (PNG, rendered with sharp) to $TUT_AI_DIR (default /tmp/tutorial-ai/card-rhea-kulkarni.png).
 * Run again after recording to restore the defaults (flows-ai-settings.js does this in prepare() and finish()).
 *
 *   npx tsx --require ./scripts/assistant-evals.preload.cjs --env-file=.env.local scripts/tutorial-videos/setup-ai-settings.ts
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DEMO_WORKSPACE_ID as WS } from "../demo-data";
import { createAdminClient } from "@/lib/supabase/admin";

const DIR = process.env.TUT_AI_DIR || "/tmp/tutorial-ai";
export const CARD_LINES = ["Rhea Kulkarni", "Facilities Manager", "Quillstone Labs Pvt Ltd", "rhea.kulkarni@quillstone.example", "+91 98220 55501"];

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  const { error } = await db.from("workspace_setting").delete().eq("workspace_id", WS).eq("key", "ai.modes");
  if (error) throw new Error(`reset ai.modes: ${error.message}`);
  if (process.argv.includes("--ocr-off")) {
    const r = await db.from("workspace_setting").insert({ workspace_id: WS, key: "ai.modes", value: { "capture.ocr": "off" } });
    if (r.error) throw new Error(`set ai.modes: ${r.error.message}`);
  }
  mkdirSync(DIR, { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${140 + CARD_LINES.length * 80}"><rect width="100%" height="100%" fill="white"/>` +
    CARD_LINES.map((l, i) => `<text x="60" y="${110 + i * 80}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${i === 0 ? 56 : 46}" ${i === 0 ? 'font-weight="bold"' : ""} fill="black">${l}</text>`).join("") + `</svg>`;
  const file = path.join(DIR, "card-rhea-kulkarni.png");
  await sharp(Buffer.from(svg)).png().toFile(file);
  console.log("AI", file);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

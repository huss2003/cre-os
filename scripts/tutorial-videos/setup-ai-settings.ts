/**
 * Demo data for the "ai-settings" tutorial videos (Settings → AI use, local OCR). Local Supabase + demo workspace ONLY.
 *   - Resets the demo workspace's AI modes to the defaults (deletes workspace_setting "ai.modes").
 *     With --ocr-off it then sets "Reading text from images & scans" (capture.ocr) to Off — the owner cannot save this page in
 *     the demo without two-step sign-in, so the videos show an already-changed feature instead of saving one.
 *   - With --ocr-off it also removes earlier observations of the Rhea Kulkarni card (same photo => "already captured") and archives
 *     the open "new contact Rhea Kulkarni" proposal those runs left, so the local-ocr video shows a fresh read every time.
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

/** Demo workspace only: forget earlier reads of the card photo so the capture is not a repeat. */
async function resetRheaCard(db: ReturnType<typeof createAdminClient>) {
  const { data: obs, error } = await db.from("capture_observation").select("source_hash").eq("workspace_id", WS).ilike("raw_text", "%rhea%kulkarni%");
  if (error) throw new Error(`find card observations: ${error.message}`);
  const hashes = [...new Set((obs ?? []).map((o: { source_hash: string | null }) => o.source_hash).filter((h): h is string => !!h))];
  if (hashes.length) {
    const r = await db.from("capture_observation").delete().eq("workspace_id", WS).in("source_hash", hashes);
    if (r.error) throw new Error(`delete card observations: ${r.error.message}`);
  }
  const p = await db.from("change_proposal").update({ archived_at: new Date().toISOString() }).eq("workspace_id", WS).is("archived_at", null)
    .in("state", ["proposed", "clarify"]).eq("target_type", "person").filter("patch", "cs", JSON.stringify([{ path: "/full_name", value: "Rhea Kulkarni" }]));
  if (p.error) console.log(`(could not archive old Rhea proposals: ${p.error.message})`);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("refusing: not local Supabase");
  const db = createAdminClient();
  const { error } = await db.from("workspace_setting").delete().eq("workspace_id", WS).eq("key", "ai.modes");
  if (error) throw new Error(`reset ai.modes: ${error.message}`);
  if (process.argv.includes("--ocr-off")) {
    await resetRheaCard(db);
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

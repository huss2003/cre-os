import "server-only";
import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { VIDEOS } from "@/app/(app)/tutorials/videos";

/**
 * tutorials.sync — copies tutorial videos into the public Supabase Storage bucket "tutorials" (videos/<slug>.mp4|.jpg).
 * Source: the deployed app's own /tutorials/videos/* static files (only present until they are removed from the repo).
 * Uploads only files missing from the bucket, so it is cheap and safe to re-run; it never deletes anything.
 * Platform-level content (not workspace data): no workspace_id involved.
 */
const BUCKET = "tutorials";
const appUrl = () => (process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).replace(/\/$/, "");

export async function syncTutorialVideos(deadlineMs = 40_000) {
  const started = Date.now();
  const admin = createAdminClient();
  const storage = admin.storage.from(BUCKET);
  const { data: existing, error } = await storage.list("videos", { limit: 1000 });
  if (error) throw new Error(`list ${BUCKET}: ${error.message}`);
  const have = new Set((existing ?? []).map((o) => o.name));
  const base = appUrl();
  if (!base) return { skipped: "APP_URL not set" };
  const uploaded: string[] = [], missingSource: string[] = [];
  for (const v of VIDEOS) for (const [ext, type] of [["mp4", "video/mp4"], ["jpg", "image/jpeg"]] as const) {
    const name = `${v.slug}.${ext}`;
    if (have.has(name)) continue;
    if (Date.now() - started > deadlineMs) return { uploaded, missingSource, more: true };
    const res = await fetch(`${base}/tutorials/videos/${name}`, { cache: "no-store" });
    if (!res.ok) { missingSource.push(name); continue; }
    const body = new Uint8Array(await res.arrayBuffer());
    const { error: upErr } = await storage.upload(`videos/${name}`, body, { contentType: type, upsert: false, cacheControl: "604800" });
    if (upErr && !/exists/i.test(upErr.message)) throw new Error(`upload ${name}: ${upErr.message}`);
    uploaded.push(name);
  }
  return { uploaded, missingSource, more: false };
}

export const handlers: Record<string, JobHandler> = {
  "tutorials.sync": async () => {
    const r = await syncTutorialVideos();
    if ("more" in r && r.more) await enqueue({ workspaceId: null, type: "tutorials.sync", dedupeKey: `tutorials.sync:more:${Date.now()}` });
    return r;
  },
};

/** Check every hour (dedupe per hour); a no-op once every video is in the bucket. */
export async function schedule(now: Date): Promise<void> {
  await enqueue({ workspaceId: null, type: "tutorials.sync", dedupeKey: `tutorials.sync:${now.toISOString().slice(0, 13)}` });
}

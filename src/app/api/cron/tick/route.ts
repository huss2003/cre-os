import { NextResponse, type NextRequest } from "next/server";
import { tick } from "@/lib/jobs/runner";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Called by Vercel Cron / Supabase pg_cron / local `npm run worker`. Authorised by CRON_SECRET bearer. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  const ua = req.headers.get("user-agent") ?? "";
  const source = /vercel-cron/i.test(ua) ? "vercel-cron" : /pg_net/i.test(ua) ? "pg_cron" : "other";
  // Heartbeat: every tick is recorded in scheduler_run; a gap > 15 min (e.g. pg_cron stopped) is alerted by the next
  // tick that runs — at the latest the daily Vercel cron (00:30 UTC, vercel.json) — and shown on /admin.
  return NextResponse.json(await tick({ budgetMs: 45_000, source }));
}
export const POST = GET;

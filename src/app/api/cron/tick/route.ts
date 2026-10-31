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
  return NextResponse.json(await tick({ budgetMs: 45_000 }));
}
export const POST = GET;

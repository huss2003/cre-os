import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
/** Liveness + configuration flags (no secret values). */
export function GET() {
  const set = (k: string) => Boolean(process.env[k]);
  return NextResponse.json({
    ok: true,
    service: "cre-os",
    at: new Date().toISOString(),
    configured: {
      supabase: set("NEXT_PUBLIC_SUPABASE_URL") && set("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") && set("SUPABASE_SECRET_KEY"),
      cron_secret: set("CRON_SECRET"),
      token_encryption_key: set("TOKEN_ENCRYPTION_KEY"),
      openai: set("OPENAI_API_KEY"),
      microsoft: set("MICROSOFT_CLIENT_ID"),
      google: set("GOOGLE_CLIENT_ID"),
      app_url: set("APP_URL"),
    },
  });
}

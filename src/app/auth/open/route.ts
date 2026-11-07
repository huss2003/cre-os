import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

/**
 * OPEN ACCESS (temporary, owner-requested): when OPEN_ACCESS_EMAIL is set, any visitor without a session is signed in
 * as that existing user via a server-generated one-time magic-link token. RLS still applies (that user's memberships).
 * Remove the env var in Vercel to restore the normal login page.
 */
export async function GET(request: NextRequest) {
  const email = process.env.OPEN_ACCESS_EMAIL;
  const next = request.nextUrl.searchParams.get("next") || "/today";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/today";
  if (!email) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(safeNext)}`, request.url));

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data?.properties?.hashed_token) return new NextResponse(`Open access failed: ${error?.message ?? "no token"}`, { status: 500 });

  const response = NextResponse.redirect(new URL(safeNext, request.url));
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: { getAll: () => request.cookies.getAll(), setAll: (list) => list.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) },
  });
  const v = await supabase.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" });
  if (v.error) return new NextResponse(`Open access failed: ${v.error.message}`, { status: 500 });
  return response;
}

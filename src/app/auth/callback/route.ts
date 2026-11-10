import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createUserClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/util/safe-redirect";

/** Email invite / magic-link / password-recovery: PKCE code exchange or token_hash verification. */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = sp.get("code");
  const tokenHash = sp.get("token_hash");
  const type = sp.get("type") as EmailOtpType | null;
  const next = safeNext(sp.get("next") ?? (type === "recovery" ? "/auth/update-password" : null), "/");
  const db = await createUserClient();
  let ok = false;
  if (code) ok = !(await db.auth.exchangeCodeForSession(code)).error;
  else if (tokenHash && type) ok = !(await db.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  if (!ok) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent("Reset link expired or already used.")}`, req.url));
  return NextResponse.redirect(new URL(next, req.url));
}

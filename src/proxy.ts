import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isHiddenPath } from "@/lib/nav";

// /api/webhooks: Microsoft Graph / Gmail push — authenticated by clientState hash / verification token, not a session.
const PUBLIC = ["/login", "/auth", "/api/cron", "/api/oauth", "/api/health", "/api/webhooks"];

export async function proxy(request: NextRequest) {
  // Deployed before Supabase is configured: keep health check working, show a clear message elsewhere.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    if (request.nextUrl.pathname.startsWith("/api/health")) return NextResponse.next({ request });
    return new NextResponse(
      "<!doctype html><meta name=viewport content='width=device-width'><title>CRE OS</title>" +
        "<body style='font-family:system-ui;padding:2rem;color:#13303b'><h1>CRE OS is deployed</h1>" +
        "<p>The database connection is not configured yet. An administrator needs to add the Supabase settings in Vercel.</p></body>",
      { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  // getClaims(): verifies the session JWT (locally with asymmetric signing keys) and refreshes cookies when needed.
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  if (!data?.claims?.sub && !PUBLIC.some((p) => path.startsWith(p))) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = process.env.OPEN_ACCESS_EMAIL ? "/auth/open" : "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  // Focus mode: hidden screens redirect to the Database screen (code kept; see src/lib/nav.ts).
  if (data?.claims?.sub && !path.startsWith("/api/") && ((path === "/" && isHiddenPath("/today")) || isHiddenPath(path))) {
    const url = request.nextUrl.clone();
    url.pathname = "/database"; url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};

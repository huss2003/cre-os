import { NextResponse, type NextRequest } from "next/server";
import { getContext, hasRole } from "@/lib/auth/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/modules/integrations/config";
import { providerParam } from "@/modules/integrations/http";
import { startOAuth } from "@/modules/integrations/oauth";

/**
 * GET /api/oauth/:provider/start — begins authorization-code + PKCE for the signed-in user in the current workspace.
 * Read-only scopes only (no Mail.Send / calendar write). Without client credentials, sends the user back to the
 * connections page where the clearly-labelled mock connector can be enabled instead.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const back = (q: string) => NextResponse.redirect(new URL(`/settings/connections?${q}`, appUrl()));
  let provider: "microsoft" | "google";
  try {
    provider = providerParam((await params).provider);
  } catch {
    return back("error=unknown_provider");
  }
  const ctx = await getContext();
  if (!ctx) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent("/settings/connections")}`, appUrl()));
  if (!ctx.workspaceId || !hasRole(ctx, "editor")) return back("error=forbidden");
  const res = await startOAuth(createAdminClient(), { provider, userId: ctx.userId, workspaceId: ctx.workspaceId, redirectTo: "/settings/connections",
    loginHint: req.nextUrl.searchParams.get("login_hint") });
  if (!res.url) return back(`notice=not_configured&provider=${provider}`);
  return NextResponse.redirect(res.url);
}

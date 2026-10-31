import { NextResponse, type NextRequest } from "next/server";
import { getContext } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl } from "@/modules/integrations/config";
import { providerParam } from "@/modules/integrations/http";
import { completeOAuth, OAuthError } from "@/modules/integrations/oauth";
import { ProviderAuthError } from "@/modules/integrations/types";

/**
 * GET /api/oauth/:provider/callback?code&state — state must be single-use, unexpired and started by this same user.
 * Tokens are stored encrypted; initial inbox / calendar / sent syncs are queued.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const back = (q: string) => NextResponse.redirect(new URL(`/settings/connections?${q}`, appUrl()));
  let provider: "microsoft" | "google";
  try {
    provider = providerParam((await params).provider);
  } catch {
    return back("error=unknown_provider");
  }
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return back(`error=${encodeURIComponent(sp.get("error")!.slice(0, 60))}&provider=${provider}`);
  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) return back("error=missing_code");
  const ctx = await getContext();
  if (!ctx) return NextResponse.redirect(new URL("/login", appUrl()));
  try {
    const r = await completeOAuth(createAdminClient(), { provider, userId: ctx.userId, state, code });
    for (const [type, delay] of [["integrations.inbox_sync", 0], ["integrations.calendar_sync", 0], ["integrations.sent_reconcile", 60]] as const) {
      await enqueue({ workspaceId: r.workspaceId, type, payload: { account_id: r.accountId }, dueAt: new Date(Date.now() + delay * 1000), dedupeKey: `${type}:${r.accountId}:connect:${Date.now()}` });
    }
    return NextResponse.redirect(new URL(`${r.redirectTo}${r.redirectTo.includes("?") ? "&" : "?"}connected=${provider}`, appUrl()));
  } catch (e) {
    if (e instanceof OAuthError) return back(`error=${e.code}&provider=${provider}`);
    if (e instanceof ProviderAuthError) return back(`error=consent_${e.status}&provider=${provider}`);
    console.error("oauth callback failed", e);
    return back(`error=token_exchange_failed&provider=${provider}`);
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleGmailPush, type PubSubPush } from "@/modules/integrations/push";

/**
 * POST /api/webhooks/google?token=<GMAIL_PUSH_VERIFICATION_TOKEN> — Gmail notifications via a Cloud Pub/Sub push
 * subscription. The token must match; the payload ({emailAddress, historyId}) only enqueues a deduplicated inbox sync
 * for the matching Google connector(s). 2xx acknowledges the Pub/Sub message; 403 on a bad token; 503 when not configured.
 */
export async function POST(req: NextRequest) {
  let body: PubSubPush | null = null;
  try {
    body = (await req.json()) as PubSubPush;
  } catch {
    body = null;
  }
  try {
    const r = await handleGmailPush(createAdminClient(), req.nextUrl.searchParams.get("token"), body);
    if (r.status === 204) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ error: r.status === 403 ? "forbidden" : "push_not_configured" }, { status: r.status });
  } catch (e) {
    console.error("gmail push failed", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

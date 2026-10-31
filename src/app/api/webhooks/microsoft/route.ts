import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleGraphNotifications, type GraphNotification } from "@/modules/integrations/push";

/**
 * POST /api/webhooks/microsoft — Microsoft Graph change + lifecycle notifications.
 *  - Subscription validation: `?validationToken=` is echoed back as text/plain within 10 s.
 *  - Notifications: each one's clientState must match the stored secret hash; valid ones only enqueue a deduplicated
 *    delta-sync job (no mail content from the payload is used). Always answers 202 quickly so Graph does not retry.
 * Service-role client: webhook context (rule S2) — every write in the handler filters the subscription's workspace.
 */
export async function POST(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get("validationToken");
  if (validationToken !== null) {
    return new NextResponse(validationToken.slice(0, 1024), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  let body: { value?: GraphNotification[] } | null = null;
  try {
    body = (await req.json()) as { value?: GraphNotification[] };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const r = await handleGraphNotifications(createAdminClient(), body);
    return NextResponse.json({ accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected }, { status: 202 });
  } catch (e) {
    console.error("graph webhook failed", e);
    // 5xx => Graph retries; polling remains the fallback either way
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

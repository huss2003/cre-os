import "server-only";
import type { AppContext } from "@/lib/auth/context";
import { createAdminClient } from "@/lib/supabase/admin";

/** Security event (denied access, approval bypass attempt...). User client first (RLS insert policy), admin fallback. */
export async function securityEvent(ctx: AppContext, kind: string, toolId: string | null, detail: Record<string, unknown>) {
  const row = { workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, kind, tool_id: toolId, detail };
  const { error } = await ctx.db.from("assistant_security_event").insert(row);
  if (error) {
    try { await createAdminClient().from("assistant_security_event").insert(row); } catch { /* never break */ }
  }
  await audit(ctx, `assistant.security.${kind}`, "assistant_security_event", null, detail);
}

/** audit_event is insert-only for the service role; always written with an explicit workspace_id. */
export async function audit(ctx: AppContext, action: string, entityType: string, entityId: string | null, after: Record<string, unknown>, before?: Record<string, unknown> | null) {
  try {
    await createAdminClient().from("audit_event").insert({
      workspace_id: ctx.workspaceId, actor_user_id: ctx.userId, actor_kind: "user", action, entity_type: entityType,
      entity_id: entityId, before: before ?? null, after,
    });
  } catch { /* never break */ }
}

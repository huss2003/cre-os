import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/util/http";

/** GET /api/v1/assistant/conversations?q= — the caller's conversations (title or message text search). */
export const GET = route(async (req) => {
  const ctx = await requireContext();
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  let query = ctx.db.from("assistant_conversation").select("id, title, last_message_at, pinned, context_entity_type")
    .eq("workspace_id", ctx.workspaceId).eq("owner_user_id", ctx.userId).is("archived_at", null);
  if (q) {
    const words = q.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    const { data: hits } = words.length
      ? await ctx.db.from("assistant_message").select("conversation_id").eq("workspace_id", ctx.workspaceId).eq("owner_user_id", ctx.userId)
        .textSearch("search", words.join(" & "), { config: "simple" }).limit(200)
      : { data: [] };
    const ids = [...new Set((hits ?? []).map((h) => h.conversation_id as string))];
    const safe = q.replace(/[%_,()\\]/g, " ");
    query = query.or(ids.length ? `title.ilike.%${safe}%,id.in.(${ids.join(",")})` : `title.ilike.%${safe}%`);
  }
  const { data, error } = await query.order("pinned", { ascending: false }).order("last_message_at", { ascending: false }).limit(100);
  if (error) throw error;
  return { items: data ?? [] };
});

import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route, uuid } from "@/lib/util/http";

async function load(id: string) {
  const ctx = await requireContext();
  const { data } = await ctx.db.from("assistant_conversation").select("*").eq("workspace_id", ctx.workspaceId).eq("owner_user_id", ctx.userId).eq("id", uuid.parse(id)).is("archived_at", null).maybeSingle();
  if (!data) throw new HttpError(404, "conversation not found");
  return { ctx, conversation: data };
}

/** GET /api/v1/assistant/conversations/:id — conversation + messages. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const { ctx, conversation } = await load(params.id);
  const { data: messages, error } = await ctx.db.from("assistant_message").select("id, seq, role, content, blocks, status, created_at, run_id")
    .eq("workspace_id", ctx.workspaceId).eq("conversation_id", conversation.id).order("seq").limit(500);
  if (error) throw error;
  return { conversation, messages: messages ?? [] };
});

const Patch = z.object({ title: z.string().trim().min(1).max(120).optional(), pinned: z.boolean().optional() });

/** PATCH /api/v1/assistant/conversations/:id — rename / pin. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const { ctx, conversation } = await load(params.id);
  const body = await parseJson(req, Patch);
  const { data, error } = await ctx.db.from("assistant_conversation").update(body).eq("workspace_id", ctx.workspaceId).eq("id", conversation.id).select("id, title, pinned").single();
  if (error) throw error;
  return { conversation: data };
}, { requireIdempotency: true });

/** DELETE /api/v1/assistant/conversations/:id — archive. */
export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const { ctx, conversation } = await load(params.id);
  const { error } = await ctx.db.from("assistant_conversation").update({ archived_at: new Date().toISOString() }).eq("workspace_id", ctx.workspaceId).eq("id", conversation.id);
  if (error) throw error;
  return { ok: true };
}, { requireIdempotency: true });

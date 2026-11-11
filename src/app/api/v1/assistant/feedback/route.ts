import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { learnFromFeedback } from "@/modules/assistant/engine/learn";

const Body = z.object({ messageId: z.string().uuid(), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(2000).optional() });

/** POST /api/v1/assistant/feedback {messageId, rating, comment?}. */
export const POST = route(async (req) => {
  const ctx = await requireContext();
  const b = await parseJson(req, Body);
  const { data: msg } = await ctx.db.from("assistant_message").select("id").eq("workspace_id", ctx.workspaceId).eq("id", b.messageId).maybeSingle();
  if (!msg) throw new HttpError(404, "message not found");
  const { data, error } = await ctx.db.from("assistant_feedback").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, message_id: b.messageId, rating: b.rating, comment: b.comment ?? null,
  }).select("id").single();
  if (error) throw error;
  // Thumbs-down with a comment becomes a stated preference memory (person/company of the conversation).
  const learned = await learnFromFeedback(ctx, { messageId: b.messageId, rating: b.rating, comment: b.comment, feedbackId: data.id as string }).catch(() => ({ saved: null, reason: "not learned" }));
  return { id: data.id, memoryId: learned.saved?.id ?? null, learnNote: learned.saved ? null : learned.reason ?? null };
}, { requireIdempotency: true });

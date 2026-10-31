import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { draftPost, checkPost, approvePost, markPublished, discardPost } from "@/modules/intelligence/content/service";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft") }),
  z.object({ action: z.literal("save"), body: z.string().max(3500) }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("published"), url: z.string().url().nullable().optional() }),
  z.object({ action: z.literal("discard") }),
]);

/** Post lifecycle. Publishing is manual: "published" only records the URL after the user posted it themselves. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const b = await parseJson(req, Body);
  switch (b.action) {
    case "draft": return guard(draftPost(ctx.db, ctx.workspaceId, id));
    case "save": return guard(checkPost(ctx.db, ctx.workspaceId, id, { body: b.body, status: "in_review" }));
    case "approve": return guard(approvePost(ctx.db, ctx.workspaceId, id));
    case "published": return guard(markPublished(ctx.db, ctx.workspaceId, id, b.url ?? null));
    case "discard": await guard(discardPost(ctx.db, ctx.workspaceId, id)); return { ok: true };
  }
}, { requireIdempotency: true });

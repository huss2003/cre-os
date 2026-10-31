import { z } from "zod";
import { route, parseJson, uuid } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { draftPost, checkPost, approvePost, markPublished, discardPost, confirmBrandReview, linkMarketNote, addPublicFact, removeEvidence, setPlannedDate, PublicFactInput } from "@/modules/intelligence/content/service";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft") }),
  z.object({ action: z.literal("save"), body: z.string().max(3500) }),
  z.object({ action: z.literal("brand_confirm") }),
  z.object({ action: z.literal("link_note"), noteId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("public_fact"), fact: PublicFactInput }),
  z.object({ action: z.literal("remove_evidence"), refId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("plan"), date: z.string().date().nullable() }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("published"), url: z.string().url().nullable().optional() }),
  z.object({ action: z.literal("discard") }),
]);

/**
 * Post lifecycle. Approval requires every checklist item (fact check vs approved evidence, brand rules, confidential terms,
 * licensed content) to pass; approved = ready. Publishing is manual: "published" only records the URL after the user posted it.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const b = await parseJson(req, Body);
  switch (b.action) {
    case "draft": return guard(draftPost(ctx.db, ctx.workspaceId, id));
    case "save": return guard(checkPost(ctx.db, ctx.workspaceId, id, { body: b.body, status: "in_review" }));
    case "brand_confirm": return guard(confirmBrandReview(ctx.db, ctx.workspaceId, id));
    case "link_note": return guard(linkMarketNote(ctx.db, ctx.workspaceId, id, b.noteId));
    case "public_fact": return guard(addPublicFact(ctx.db, ctx.workspaceId, id, b.fact, ctx.userId));
    case "remove_evidence": return guard(removeEvidence(ctx.db, ctx.workspaceId, id, b.refId));
    case "plan": return guard(setPlannedDate(ctx.db, ctx.workspaceId, id, b.date));
    case "approve": return guard(approvePost(ctx.db, ctx.workspaceId, id));
    case "published": return guard(markPublished(ctx.db, ctx.workspaceId, id, b.url ?? null));
    case "discard": await guard(discardPost(ctx.db, ctx.workspaceId, id)); return { ok: true };
  }
}, { requireIdempotency: true });

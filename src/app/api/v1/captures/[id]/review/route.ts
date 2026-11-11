import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { getReview, submitReview } from "@/modules/capture/service";
import { asHttp } from "@/modules/changes/http";
import { correctTranscript, runInputEngine } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

/** GET — review screen model: extraction, candidates, open questions, proposals, tasks, drafts, spans. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  try { return await getReview(ctx.db, ctx.workspaceId, uuid.parse(params.id)); } catch (e) { asHttp(e); }
});

const Body = z.object({
  resolutions: z.record(z.string().regex(/^\d+$/), z.union([uuid, z.literal("create")])).optional(),
  answers: z.record(z.string().regex(/^\d+$/), z.union([z.string().max(100), z.number(), z.null()])).optional(),
  requirementId: uuid.nullish(),
  text: z.string().max(20_000).nullish(),
  done: z.boolean().optional(),
});

/** POST — confirm entities / answer ambiguities / mark reviewed; re-materialises the capture idempotently. */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const body = await parseJson(req, Body);
  try {
    if (body.text?.trim()) await correctTranscript(ctx.db, ctx.workspaceId, ctx.userId, uuid.parse(params.id), body.text);
    await submitReview(ctx.db, createAdminClient(), ctx.workspaceId, ctx.userId, uuid.parse(params.id), body);
    try { await runInputEngine(createAdminClient(), ctx.workspaceId, params.id); } catch { /* best effort */ }
    return await getReview(ctx.db, ctx.workspaceId, params.id);
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext, HttpError } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { asHttp } from "@/modules/changes/http";
import { DOC_TYPES } from "@/modules/capture/docs/detect";
import { getDocument, updateAndReprocess } from "@/modules/capture/docs/service";

export const dynamic = "force-dynamic";

/** GET /api/v1/captures/documents/:id — document, its proposals, transcript and a short-lived link to the original. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const ctx = await requireContext();
  const r = await getDocument(ctx.db, ctx.workspaceId, uuid.parse(params.id));
  if (!r) throw new HttpError(404, "not found");
  return r;
});

const Body = z.object({
  type: z.enum(DOC_TYPES).nullish(), typedText: z.string().max(20_000).nullish(),
  links: z.object({ organisation_id: z.string().uuid(), person_id: z.string().uuid(), asset_id: z.string().uuid(), requirement_id: z.string().uuid(), meeting_prep_id: z.string().uuid() }).partial().optional(),
});

/** POST /api/v1/captures/documents/:id — change type/links/typed text and process again (same idempotency keys; never duplicates). */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  try {
    return { document: await updateAndReprocess(ctx, uuid.parse(params.id), { userType: b.type === undefined ? undefined : b.type ?? null, links: b.links, typedText: b.typedText }, { admin: createAdminClient() }) };
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

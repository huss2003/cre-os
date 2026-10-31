import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { approveDraft } from "@/lib/services/drafts";
import { parseJson, route, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/integrations/http";

const body = z.object({ reviewedHash: z.string().min(16).max(128), note: z.string().max(500).optional(), expectedVersion: z.number().int().positive().optional() });

/**
 * POST /api/v1/drafts/:id/approve { reviewedHash } — binds approval to the content hash the user reviewed.
 * Goes through the SECURITY DEFINER app.approve_draft (role, suppression and hash checks).
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const v = await parseJson(req, body);
  return { draft: await asHttp(() => approveDraft(ctx.db, ctx.workspaceId, id, ctx.userId, v)) };
}, { requireIdempotency: true });

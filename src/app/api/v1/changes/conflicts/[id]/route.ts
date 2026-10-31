import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { dismissConflict, proposeConflictFix } from "@/modules/changes/steward";

const Body = z.object({ action: z.enum(["propose_fix", "dismiss"]), note: z.string().max(1000).nullish() });

/** POST /api/v1/changes/conflicts/:id {action: propose_fix|dismiss} — never writes the record directly. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const ctx = await requireContext("editor");
  const cid = uuid.parse(params.id);
  const b = await parseJson(req, Body);
  try {
    if (b.action === "dismiss") return await dismissConflict(ctx.db, ctx.workspaceId, ctx.userId, cid, b.note ?? null);
    return { proposal: await proposeConflictFix(ctx.db, ctx.workspaceId, cid) };
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

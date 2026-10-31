import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { proposeChange } from "@/lib/services/changes";
import { listQueue, proposeMerge, proposePersonMove, type QueueTab } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

const Patch = z.array(z.object({ op: z.enum(["add", "replace", "remove"]), path: z.string().regex(/^\/[a-z_][a-z0-9_]*$/), value: z.unknown().optional() })).min(1).max(60);
const Body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change"),
    targetType: z.string().regex(/^[a-z_]+$/), targetId: uuid.nullish(),
    operation: z.enum(["create", "update", "archive", "link"]).default("update"),
    expectedVersion: z.number().int().positive().nullish(), patch: Patch, reason: z.string().min(1).max(2000),
    evidenceIds: z.array(uuid).max(50).optional(),
    classification: z.enum(["public", "permitted_personal", "corporate_confidential", "licensed_restricted"]).optional(),
  }),
  z.object({ kind: z.literal("merge"), entityType: z.enum(["organisation", "person", "asset"]), winnerId: uuid, loserId: uuid, reason: z.string().min(1).max(2000), evidenceIds: z.array(uuid).max(50).optional() }),
  z.object({ kind: z.literal("person_move"), personId: uuid, newOrgId: uuid, title: z.string().max(200).nullish(), startDate: z.string().date().nullish(),
    endDate: z.string().date().nullish(), reason: z.string().min(1).max(2000), evidenceIds: z.array(uuid).max(50).optional() }),
]);

/** GET /api/v1/changes?tab=records|merges|drafts|documents|history — approval queue. */
export const GET = route(async (req: NextRequest) => {
  const ctx = await requireContext();
  const tab = (req.nextUrl.searchParams.get("tab") ?? "records") as QueueTab;
  if (!["records", "merges", "drafts", "documents", "history"].includes(tab)) return { error: "unknown tab" };
  try { return await listQueue(ctx.db, ctx.workspaceId, tab); } catch (e) { asHttp(e); }
});

/**
 * POST /api/v1/changes — propose a change (kind=change), identity merge (kind=merge) or person job move (kind=person_move).
 * Risk is computed server-side; the Idempotency-Key header becomes the proposal's idempotency key.
 */
export const POST = route(async (req: NextRequest, { idempotencyKey }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  const key = `api:${ctx.userId}:${idempotencyKey}`;
  try {
    if (b.kind === "merge") return { proposal: await proposeMerge(ctx.db, ctx.workspaceId, { ...b, idempotencyKey: key }) };
    if (b.kind === "person_move") return { proposals: await proposePersonMove(ctx.db, ctx.workspaceId, { ...b, idempotencyKey: key }) };
    return { proposal: await proposeChange(ctx.db, ctx.workspaceId, { ...b, patch: b.patch as never, idempotencyKey: key, proposedByKind: "user" }) };
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

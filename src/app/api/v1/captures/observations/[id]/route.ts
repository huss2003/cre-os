import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { asHttp } from "@/modules/changes/http";
import { associateObservation, confirmObservation, correctObservation, createRecordFromObservation, rejectObservation, requestClarification } from "@/modules/capture/input-engine/service";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("reject"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("correct"), value: z.union([z.string().max(500), z.number(), z.null()]).optional(), unit: z.string().max(40).nullish(),
    pricing_basis: z.enum(["per_sf_month", "per_seat_month", "total_month", "total_year"]).nullish(), area_basis: z.enum(["carpet", "chargeable", "super_built_up", "unknown"]).nullish(),
    cam_treatment: z.enum(["included", "extra", "unknown"]).nullish(), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("associate"), type: z.enum(["requirement", "organisation", "person", "asset", "quote"]), id: uuid }),
  z.object({ action: z.literal("create"), kind: z.enum(["organisation", "person"]), name: z.string().min(1).max(200) }),
  z.object({ action: z.literal("clarify"), question: z.string().min(3).max(300) }),
]);

/** POST /api/v1/captures/observations/[id] — confirm / edit / reject / associate / create / request clarification (§13B). */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, Body);
  const id = uuid.parse(params.id);
  try {
    switch (b.action) {
      case "confirm": return { observation: await confirmObservation(ctx.db, ctx.workspaceId, ctx.userId, id) };
      case "reject": return { observation: await rejectObservation(ctx.db, ctx.workspaceId, ctx.userId, id, b.note) };
      case "correct": { const { action: _a, ...patch } = b; return { observation: await correctObservation(ctx.db, ctx.workspaceId, ctx.userId, id, patch) }; }
      case "associate": return { observation: await associateObservation(ctx.db, ctx.workspaceId, ctx.userId, id, { type: b.type, id: b.id }) };
      case "create": return { proposal: await createRecordFromObservation(ctx.db, ctx.workspaceId, ctx.userId, id, b.kind, b.name) };
      case "clarify": return { task: await requestClarification(ctx.db, ctx.workspaceId, ctx.userId, id, b.question) };
    }
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { route, parseJson, uuid } from "@/lib/util/http";
import { approveChange, applyChange, clarifyChange, rejectChange } from "@/modules/changes/service";
import { asHttp } from "@/modules/changes/http";

export const dynamic = "force-dynamic";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "clarify"]).default("approved"),
  note: z.string().max(2000).nullish(),
  ttlHours: z.number().int().min(1).max(720).optional(),
  apply: z.boolean().default(false),
});

/** POST — hash-bound decision (approve / reject / clarify); `apply: true` applies right after approving. */
export const POST = route<{ id: string }>(async (req: NextRequest, { params }) => {
  const ctx = await requireContext("editor");
  const id = uuid.parse(params.id);
  const b = await parseJson(req, Body);
  try {
    if (b.decision === "rejected") return { decision: await rejectChange(ctx.db, id, { note: b.note ?? undefined }) };
    if (b.decision === "clarify") return { decision: await clarifyChange(ctx.db, id, { note: b.note ?? "Please clarify" }) };
    const decision = await approveChange(ctx.db, id, { note: b.note ?? undefined, ttlHours: b.ttlHours });
    return { decision, applied: b.apply ? await applyChange(ctx.db, id) : null };
  } catch (e) { asHttp(e); }
}, { requireIdempotency: true });

import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { enqueue } from "@/lib/jobs/queue";
import { parseJson, route, uuid } from "@/lib/util/http";
import { agenda, createPlannedVisit, findConflicts, findTravelConflicts, loadGeos, planRoutes, VisitInputError, withPoints } from "@/modules/integrations/calendar";

/**
 * GET /api/v1/calendar?from=ISO&to=ISO — agenda (default today-1 .. +14 days) with overlap conflicts, travel conflicts
 * (deterministic estimate) and provisional route clusters.
 */
export const GET = route(async (req) => {
  const ctx = await requireContext("viewer");
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date(Date.now() - 86_400_000);
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date(Date.now() + 14 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, "invalid from/to");
  const items = withPoints(await agenda(ctx.db, ctx.workspaceId, from, to), await loadGeos(ctx.db, ctx.workspaceId));
  return { items, conflicts: findConflicts(items), travelConflicts: findTravelConflicts(items, ctx.timezone), routes: planRoutes(items, ctx.timezone), travelTimesAreEstimates: true };
});

const body = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["site_visit", "meeting"]),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  assetId: uuid.nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  opportunityId: uuid.nullable().optional(),
});

/** POST /api/v1/calendar — plan a visit / meeting by hand (status provisional until the user confirms). Sends nothing. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, body);
  try {
    const mv = await createPlannedVisit(ctx.db, ctx.workspaceId, b, ctx.userId, ctx.timezone);
    await enqueue({ workspaceId: ctx.workspaceId, type: "integrations.calendar_conflicts", dedupeKey: `integrations.calendar_conflicts:${ctx.workspaceId}:${mv.id}:${mv.version_key}` });
    return { visit: mv };
  } catch (e) {
    if (e instanceof VisitInputError) throw new HttpError(400, e.message);
    throw e;
  }
}, { requireIdempotency: true });

import { route, parseJson } from "@/lib/util/http";
import { requireContext } from "@/lib/auth/context";
import { guard } from "@/modules/intelligence/api";
import { GeoMappingInput, proposeGeographyMapping, pendingGeographyMappings } from "@/modules/intelligence/market/service";

export const GET = route(async () => {
  const ctx = await requireContext();
  return { pending_raw_names: await guard(pendingGeographyMappings(ctx.db, ctx.workspaceId)) };
});

/** Propose raw geography name → geography id (as an alias). Goes through change proposals; nothing merges until approved. */
export const POST = route(async (req) => {
  const ctx = await requireContext("editor");
  const b = await parseJson(req, GeoMappingInput);
  return guard(proposeGeographyMapping(ctx.db, ctx.workspaceId, b, ctx.userId));
}, { requireIdempotency: true });

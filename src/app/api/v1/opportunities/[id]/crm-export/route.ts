import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { dealsRoute } from "@/modules/deals/api";
import { markExported, proposeCrmExport, recordExternalSnapshot } from "@/modules/deals/crm/export";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose") }),
  z.object({ action: z.literal("external"), exportId: z.string().uuid(), external: z.record(z.string(), z.unknown()), crmExternalId: z.string().max(100).nullish() }),
  z.object({ action: z.literal("exported"), exportId: z.string().uuid(), resolution: z.enum(["keep_external", "use_local"]).nullish() }),
]);

/** Official CRM stays the source of truth: proposals reference crm_external_id and surface conflicts, never overwrite. */
export const POST = dealsRoute<{ id: string }>({ mutation: true, scope: "opportunities.crm" }, async (req, ctx, p) => {
  const b = await parseJson(req, Body);
  if (b.action === "propose") return { export: await proposeCrmExport(ctx, z.string().uuid().parse(p.id)) };
  if (b.action === "external") return { export: await recordExternalSnapshot(ctx, b.exportId, b.external, b.crmExternalId) };
  return { export: await markExported(ctx, b.exportId, { resolution: b.resolution ?? null }) };
});

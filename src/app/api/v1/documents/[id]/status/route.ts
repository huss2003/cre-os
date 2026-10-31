import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { refreshStatus } from "@/modules/deals/documents/service";

/** Re-check freshness (marks the document stale when inputs changed). */
export const POST = dealsRoute<{ id: string }>({ mutation: true }, async (_req, ctx, p) => refreshStatus(ctx, z.string().uuid().parse(p.id)));

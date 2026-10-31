import { dealsRoute } from "@/modules/deals/api";
import { listDocuments } from "@/modules/deals/documents/service";

export const GET = dealsRoute({}, async (req, ctx) => ({ documents: await listDocuments(ctx, { requirementId: req.nextUrl.searchParams.get("requirementId") ?? undefined }) }));

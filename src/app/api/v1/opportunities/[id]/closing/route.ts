import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { getClosingView } from "@/modules/deals/pipeline/closing-service";
import { localDate } from "@/lib/util/time";

/** Closing coordinator view: dependency timeline (blocked items + what they wait on), outstanding documents, fee ledger, reconciliation exceptions. */
export const GET = dealsRoute<{ id: string }>({}, async (_req, ctx, p) => getClosingView(ctx, z.string().uuid().parse(p.id), localDate()));

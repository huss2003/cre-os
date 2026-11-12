import { txRoute } from "@/modules/transactions/api";
import { commandView } from "@/modules/transactions/command";

/** §15 command view (JSON). */
export const GET = txRoute<{ id: string }>({}, async (_req, ctx, p) => commandView(ctx, p.id));

import { z } from "zod";
import { parseJson } from "@/lib/util/http";
import { txRoute } from "@/modules/transactions/api";
import { createTransaction, listTransactions } from "@/modules/transactions/service";

const Create = z.object({
  name: z.string().min(1).max(300), txType: z.string().min(1).max(80), requirementId: z.string().uuid().nullish(), opportunityId: z.string().uuid().nullish(),
  clientOrgId: z.string().uuid().nullish(), spaceIds: z.array(z.string().uuid()).max(50).optional(), propertyLabels: z.array(z.string().max(200)).max(50).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(), expectedCompletion: z.string().nullish(), templateId: z.string().uuid().nullish(),
});

export const GET = txRoute({}, async (req, ctx) => ({ transactions: await listTransactions(ctx, { status: req.nextUrl.searchParams.get("status") ?? undefined, opportunityId: req.nextUrl.searchParams.get("opportunity") ?? undefined }) }));
export const POST = txRoute({ mutation: true }, async (req, ctx) => ({ transaction: await createTransaction(ctx, await parseJson(req, Create)) }));

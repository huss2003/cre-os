import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { loadUsage, setMonthlyBudget, UsageError } from "@/modules/assistant/usage/service";

/** GET /api/v1/assistant/usage — month/day spend, breakdowns, tokens, top runs (admin+, model_usage is admin-only). */
export const GET = route(async () => {
  const ctx = await requireContext("admin");
  return loadUsage(ctx.db, ctx.workspaceId);
});

const Body = z.object({ monthlyBudgetInr: z.number().min(0).max(10_000_000) });
/** PUT /api/v1/assistant/usage {monthlyBudgetInr} — owner only. 0 = no cap. */
export const PUT = route(async (req) => {
  const ctx = await requireContext("viewer");
  const b = await parseJson(req, Body);
  try { return await setMonthlyBudget(ctx, b.monthlyBudgetInr); }
  catch (e) { if (e instanceof UsageError) throw new HttpError(e.status, e.message); throw e; }
}, { requireIdempotency: true });

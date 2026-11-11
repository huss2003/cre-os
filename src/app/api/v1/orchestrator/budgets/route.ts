import { z } from "zod";
import { HttpError, requireContext } from "@/lib/auth/context";
import { parseJson, route } from "@/lib/util/http";
import { BudgetError, budgetStates, listBudgets, setBudget, usageReport } from "@/modules/orchestrator/budget/service";

/** GET /api/v1/orchestrator/budgets (admin) — budgets, current usage/status and this month's usage by module/workflow/user. */
export const GET = route(async () => {
  const ctx = await requireContext("admin");
  return { budgets: await listBudgets(ctx.db, ctx.workspaceId), states: await budgetStates(ctx.db, ctx.workspaceId), usage: await usageReport(ctx.db, ctx.workspaceId) };
});

const Body = z.object({
  resource: z.string(), provider: z.string().max(60).optional(), module: z.string().max(60).optional(), period: z.enum(["daily", "monthly"]),
  limitUnits: z.number().min(0), unit: z.string(), alertPct: z.number().int().min(1).max(100).optional(), enabled: z.boolean().optional(),
});
/** PUT /api/v1/orchestrator/budgets (admin, Idempotency-Key) — create or adjust a budget. */
export const PUT = route(async (req) => {
  const ctx = await requireContext("admin");
  const b = await parseJson(req, Body);
  try { return { budget: await setBudget(ctx.db, ctx.workspaceId, ctx.userId, b) }; }
  catch (e) { if (e instanceof BudgetError) throw new HttpError(400, e.message); throw e; }
}, { requireIdempotency: true });

import { z } from "zod";
import { dealsRoute } from "@/modules/deals/api";
import { approveScenario } from "@/modules/deals/finance/service";

/** Approve a stored scenario (re-runs the engine; refuses if the hash no longer reproduces or quotes are stale). */
export const POST = dealsRoute<{ id: string }>({ role: "admin", mutation: true, scope: "finance.approve" }, async (_req, ctx, p) =>
  ({ scenario: await approveScenario(ctx, z.string().uuid().parse(p.id)) }));

import { z } from "zod";
import { defineTool, failed, isUuid } from "@/modules/assistant/tools/shared";
import { answer, ASSISTANT_QUESTIONS } from "./integrations";
import { listTransactions } from "./service";

/**
 * Module 12 tools for Module 16 (category A: read-only). Answers are built only from transaction records; when nothing
 * is recorded the tool says so — it never invents negotiation outcomes or approvals.
 * TODO(lead): register `transactionTools` in src/modules/assistant/tools/index.ts (assistant module owns the registry).
 */
const ctxOf = (t: { ctx: { db: unknown; workspaceId: string; userId: string } }) => ({ db: t.ctx.db as never, workspaceId: t.ctx.workspaceId, userId: t.ctx.userId });

const ask = defineTool({
  id: "transaction_question", module: "toolkit", category: "A",
  description: "Answer a question about one transaction (Module 16) from its records: blocking items, latest agreed rent, unresolved terms, the landlord's last counteroffer, pending approvals, outstanding documents, next action, responsible stakeholder, what changed in the latest agreement, what must happen before possession.",
  input: z.object({ transactionId: z.string(), question: z.enum(ASSISTANT_QUESTIONS) }),
  async run(i, t) {
    if (!isUuid(i.transactionId)) return { ok: false, summary: "invalid transaction id", error: "invalid id" };
    try { const r = await answer(ctxOf(t), i.transactionId, i.question); return { ok: true, summary: r.answer, data: r }; }
    catch (e) { return failed("transaction lookup failed", e); }
  },
});

const list = defineTool({
  id: "list_transactions", module: "toolkit", category: "A",
  description: "List active transactions (Module 16) with code, type, status and current stage.",
  input: z.object({ status: z.enum(["active", "on_hold", "completed", "cancelled"]).optional() }),
  async run(i, t) {
    const rows = await listTransactions(ctxOf(t), { status: i.status });
    return { ok: true, summary: `${rows.length} transaction(s)`, data: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.tx_type, status: r.status, stage: r.current_stage })) };
  },
});

export const transactionTools = [ask, list];

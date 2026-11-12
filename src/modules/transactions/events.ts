import { publishEvent } from "@/modules/orchestrator/events/publish";
import type { TxCtx } from "./ctx";
import { isOverdue } from "./model";

/** §17 Module 9 — orchestrator event types published by Module 16 (event_outbox; consumers may register on them). */
export const TX_EVENTS = {
  stageChanged: "transaction.stage_changed",
  offerReceived: "transaction.offer_received",
  counterofferCreated: "transaction.counteroffer_created",
  offerExpiring: "transaction.offer_expiring",
  issueOverdue: "transaction.issue_overdue",
  approvalPending: "transaction.approval_pending",
  documentVersionChanged: "transaction.document_version_changed",
  materialTermChanged: "transaction.material_term_changed",
  executed: "transaction.executed",
  possessionApproaching: "transaction.possession_approaching",
  handoverIncomplete: "transaction.handover_incomplete",
} as const;

/** Timeline entry (append-only tx_event) + orchestrator event when `event` is given. Same dedupe → one outbox event. */
export async function record(ctx: Pick<TxCtx, "db" | "workspaceId">, txId: string, e: {
  kind: string; summary: string; subjectType?: string; subjectId?: string | null; payload?: Record<string, unknown>; source?: string; event?: string; dedupe?: string;
}) {
  const { error } = await ctx.db.from("tx_event").insert({
    workspace_id: ctx.workspaceId, transaction_id: txId, kind: e.kind, summary: e.summary, subject_type: e.subjectType ?? null,
    subject_id: e.subjectId ?? null, payload: e.payload ?? {}, source: e.source ?? "user",
  });
  if (error) throw new Error(`timeline: ${error.message}`);
  if (e.event) {
    await publishEvent(ctx.db, ctx.workspaceId, {
      type: e.event, subjectType: e.subjectType ?? "tx_transaction", subjectId: e.subjectId ?? txId,
      payload: { transaction_id: txId, summary: e.summary, ...(e.payload ?? {}) }, dedupeKey: e.dedupe,
    });
  }
}

/**
 * Time-based triggers (offer expiring, issue overdue, possession approaching, handover incomplete). Deduped per subject
 * per day, so re-running never duplicates. Works with a user client or the service-role client (explicit ws filters).
 */
export async function scanTransactions(ctx: Pick<TxCtx, "db" | "workspaceId">, asOf: string, opts: { expiringDays?: number; possessionDays?: number } = {}) {
  const ws = ctx.workspaceId; const db = ctx.db;
  const plus = (days: number) => { const d = new Date(`${asOf}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const out: { type: string; subjectId: string; transactionId: string }[] = [];
  const pub = async (txId: string, type: string, subjectType: string, subjectId: string, summary: string) => {
    const r = await publishEvent(db, ws, { type, subjectType, subjectId, payload: { transaction_id: txId, summary, as_of: asOf }, dedupeKey: `${type}:${subjectId}:${asOf}` });
    if (!r.duplicate) out.push({ type, subjectId, transactionId: txId });
  };
  // Every active transaction (paged; one response is capped at 1,000 rows), then child rows in id chunks of 100 —
  // a single .in() over hundreds of ids overflows the request URL and silently returned nothing.
  const ids: string[] = [];
  for (let from = 0; from < 50_000; from += 1000) {
    const { data, error } = await db.from("tx_transaction").select("id").eq("workspace_id", ws).eq("status", "active").is("archived_at", null).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    ids.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
    if ((data ?? []).length < 1000) break;
  }
  if (!ids.length) return out;
  const inChunks = async (build: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const rows: any[] = [];
    for (let i = 0; i < ids.length; i += 100) { const { data, error } = await build(ids.slice(i, i + 100)); if (error) throw new Error(error.message); rows.push(...((data ?? []) as any[])); }
    return rows;
  };
  const offers = await inChunks((c) => db.from("tx_offer").select("id, transaction_id, valid_until, version_no").eq("workspace_id", ws).in("transaction_id", c)
    .eq("response_status", "pending").not("valid_until", "is", null).lte("valid_until", plus(opts.expiringDays ?? 3)).gte("valid_until", asOf));
  for (const o of offers) await pub(o.transaction_id, TX_EVENTS.offerExpiring, "tx_offer", o.id, `Offer v${o.version_no} expires ${o.valid_until}`);
  const issues = await inChunks((c) => db.from("tx_issue").select("id, transaction_id, title, status, due_date, blocking").eq("workspace_id", ws).in("transaction_id", c).is("archived_at", null));
  for (const i of issues) if (isOverdue(i, asOf)) await pub(i.transaction_id, TX_EVENTS.issueOverdue, "tx_issue", i.id, `Issue overdue: ${i.title} (due ${i.due_date})`);
  const ms = await inChunks((c) => db.from("tx_milestone").select("id, transaction_id, kind, expected_on, achieved_on").eq("workspace_id", ws).in("transaction_id", c).is("achieved_on", null));
  for (const m of ms) {
    if (m.kind === "possession_completed" && m.expected_on && m.expected_on >= asOf && m.expected_on <= plus(opts.possessionDays ?? 14))
      await pub(m.transaction_id, TX_EVENTS.possessionApproaching, "tx_milestone", m.id, `Possession expected ${m.expected_on}`);
    if (m.kind === "handover_completed" && m.expected_on && m.expected_on < asOf)
      await pub(m.transaction_id, TX_EVENTS.handoverIncomplete, "tx_milestone", m.id, `Handover expected ${m.expected_on} is incomplete`);
  }
  return out;
}

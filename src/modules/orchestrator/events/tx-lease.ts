import "server-only";
/**
 * Integration consumers for Module 16 (transaction.*) and Module 15 (lease.*) events (master spec Part 4 / 6.5 / 6.6).
 * Each consumer is idempotent: notifications dedupe on the event id, the Module 15 hand-off is a no-op once delivered,
 * and the record-changed workflow dedupes per event. Admin client (jobs) — every query filters workspace_id (S2).
 */
import type { Db } from "@/lib/supabase/server";
import { notifyUser } from "../notify/service";
import type { Consumer } from "./process";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const URGENT_TX = new Set(["transaction.offer_expiring", "transaction.issue_overdue", "transaction.approval_pending", "transaction.handover_incomplete"]);

async function txOf(db: Db, ws: string, e: Row): Promise<Row | null> {
  const id = (e.payload?.transaction_id as string | undefined) ?? (e.subject_type === "tx_transaction" ? e.subject_id : null);
  if (!id) return null;
  const { data } = await db.from("tx_transaction").select("id, code, name, owner_user_id, client_org_id, opportunity_id, lease_handoff, status").eq("workspace_id", ws).eq("id", id).maybeSingle();
  return (data as Row) ?? null;
}

/** transaction.* → in-app notification to the transaction owner (never outbound, S3). */
export const notifyTxOwner: Consumer = async (db, ws, e) => {
  const tx = await txOf(db, ws, e);
  if (!tx?.owner_user_id) return { status: "skipped", detail: "Transaction not found or has no owner." };
  const what = String(e.event_type).replace(/^transaction\./, "").replace(/_/g, " ");
  const r = await notifyUser(db, ws, {
    userId: tx.owner_user_id, category: "transaction", eventKey: `evt:${e.id}`, title: `${tx.code ?? "Transaction"}: ${what}`,
    body: typeof e.payload?.summary === "string" ? e.payload.summary.slice(0, 300) : null, severity: URGENT_TX.has(e.event_type) ? "urgent" : undefined,
    record: { type: "tx_transaction", id: tx.id }, href: `/transactions/${tx.id}`,
  });
  return { status: "done", detail: r.duplicate ? "Already notified." : r.suppressed ? "Notification muted by preferences." : "Owner notified (Today / inbox)." };
};

/** transaction.executed → retry the Module 15 hand-off while it is pending (idempotent once delivered). */
export const retryLeaseHandoff: Consumer = async (db, ws, e) => {
  const tx = await txOf(db, ws, e);
  if (!tx) return { status: "skipped", detail: "Transaction not found." };
  if (tx.lease_handoff?.status === "delivered") return { status: "skipped", detail: "Lease Lifecycle already has this lease." };
  const { handOffExecutedLease } = await import("@/modules/transactions/lease-handoff");
  const r = await handOffExecutedLease({ db: db as never, workspaceId: ws, userId: tx.owner_user_id }, tx.id) as Row;
  if (r.status !== "delivered") throw new Error(`Module 15 hand-off still pending: ${r.reason ?? "unknown"} — will retry`);
  return { status: "done", detail: `Handed to Lease Lifecycle (lease ${r.lease_id}).` };
};

/** Sweep for executed transactions whose hand-off is still pending (called by the orchestrator tick). */
export async function retryPendingHandoffs(db: Db, ws: string): Promise<number> {
  const { data } = await db.from("tx_transaction").select("id, owner_user_id, lease_handoff").eq("workspace_id", ws).not("lease_handoff", "is", null).limit(50);
  const pending = ((data ?? []) as Row[]).filter((t) => t.lease_handoff?.status === "pending_module_15");
  if (!pending.length) return 0;
  const { handOffExecutedLease } = await import("@/modules/transactions/lease-handoff");
  let delivered = 0;
  for (const t of pending) {
    try { const r = await handOffExecutedLease({ db: db as never, workspaceId: ws, userId: t.owner_user_id }, t.id) as Row; if (r.status === "delivered") delivered++; } catch { /* stays pending; visible on the transaction */ }
  }
  return delivered;
}

/** lease.* lifecycle events (Module 15) → notify the lease owner. */
export const notifyLeaseOwner: Consumer = async (db, ws, e) => {
  const leaseId = (e.payload?.lease_id as string | undefined) ?? (e.subject_type === "lease" ? e.subject_id : null);
  if (!leaseId) return { status: "skipped", detail: "No lease on the event." };
  const { data: l } = await db.from("lease").select("id, owner_user_id, tenant_name_raw").eq("workspace_id", ws).eq("id", leaseId).maybeSingle();
  if (!l?.owner_user_id) return { status: "skipped", detail: "Lease not found or has no owner." };
  const what = String(e.event_type).replace(/^lease\./, "").replace(/_/g, " ");
  const potential = e.event_type === "lease.opportunity_identified";
  await notifyUser(db, ws, {
    userId: l.owner_user_id, category: potential ? "lease_opportunity" : "lease_deadline", eventKey: `evt:${e.id}`,
    title: `Lease${l.tenant_name_raw ? ` (${l.tenant_name_raw})` : ""}: ${what}${potential ? " — potential, not confirmed" : ""}`,
    body: typeof e.payload?.summary === "string" ? e.payload.summary.slice(0, 300) : null, record: { type: "lease", id: l.id }, href: `/leases/${l.id}`,
  });
  return { status: "done", detail: "Lease owner notified." };
};

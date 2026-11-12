import "server-only";
/**
 * Today: "Active transactions" (Module 16) and "Important lease events" (Module 15) sections (master spec 2.2 TODAY).
 * Read-only, user client (RLS). Lease dates: confirmed contractual deadlines are shown as such; anything else is shown
 * only with an explicit "not verified" label (USER-RULES 1). Failures are visible (unavailable), never "nothing to do".
 */
import type { Db } from "@/lib/supabase/server";
import { commandView } from "@/modules/transactions/command";
import { listTransactions } from "@/modules/transactions/service";
import { VERIFICATION_LABEL, type VerificationStatus } from "@/modules/leases/dates";
import { addDays } from "@/modules/brief/dates";
import type { PlannerItem, PlannerSection } from "./planner";
import { codeLabel } from "@/lib/util/labels";

const DATE_LABEL: Record<string, string> = {
  expiry: "Lease expiry", lockin_end: "Lock-in ends", escalation: "Rent escalation", renewal_option: "Renewal option", renewal_notice_deadline: "Renewal notice deadline",
  break_option: "Break option", termination_notice_deadline: "Termination notice deadline", deposit_refund_deadline: "Deposit refund deadline",
  possession: "Possession", commencement: "Commencement", rent_commencement: "Rent starts", handover: "Handover",
};
const IMPORTANT = Object.keys(DATE_LABEL);

const section = (key: string, title: string, items: PlannerItem[], empty: string, link: { href: string; label: string }, unavailable: string | null = null, count = items.length): PlannerSection =>
  ({ key, title, count, countText: String(count), items: items.slice(0, 8), empty, unavailable, link });

export async function activeTransactionsSection(ctx: { db: Db; workspaceId: string; userId: string }, today: string): Promise<PlannerSection> {
  try {
    const txs = await listTransactions({ db: ctx.db as never, workspaceId: ctx.workspaceId, userId: ctx.userId }, { status: "active" });
    const items: PlannerItem[] = [];
    for (const t of txs.slice(0, 15)) {
      const v = await commandView({ db: ctx.db as never, workspaceId: ctx.workspaceId, userId: ctx.userId }, t.id, today);
      const mineApprovals = v.pendingApprovals.filter((a: { reviewer_user_id?: string | null }) => a.reviewer_user_id === ctx.userId).length;
      const next = v.nextActions[0];
      const parts = [
        v.blockingNow.length ? `${v.blockingNow.length} blocker(s): ${v.blockingNow[0]}` : null,
        mineApprovals ? `${mineApprovals} approval(s) waiting for you` : v.pendingApprovals.length ? `${v.pendingApprovals.length} approval(s) pending` : null,
        next ? `Next: ${next.what}${next.due ? ` (due ${next.due})` : ""}` : null,
      ].filter(Boolean);
      items.push({ key: `tx:${t.id}`, title: `${t.code} — ${t.name ?? "Transaction"}`, href: `/transactions/${t.id}`, meta: parts.join(" · ") || "No blockers or pending approvals recorded.",
        tone: v.blockingNow.length || mineApprovals ? "bad" : v.pendingApprovals.length ? "warn" : "ok" });
    }
    items.sort((a, b) => ["bad", "warn", "ok", "neutral"].indexOf(a.tone ?? "neutral") - ["bad", "warn", "ok", "neutral"].indexOf(b.tone ?? "neutral"));
    return section("transactions", "Active transactions", items, "No active transactions. Start one from a deal when negotiation begins.", { href: "/transactions", label: "Transactions" }, null, txs.length);
  } catch (e) {
    return section("transactions", "Active transactions", [], "", { href: "/transactions", label: "Transactions" }, `Transactions could not be loaded (${e instanceof Error ? e.message : "error"}). Nothing was changed; reload to retry.`);
  }
}

export async function leaseEventsSection(ctx: { db: Db; workspaceId: string }, today: string, days = 90): Promise<PlannerSection> {
  const { data, error } = await ctx.db.from("lease_date").select("id, lease_id, date_type, label, calculated_date, verification_status")
    .eq("workspace_id", ctx.workspaceId).is("archived_at", null).is("superseded_by", null).in("date_type", IMPORTANT)
    .gte("calculated_date", today).lte("calculated_date", addDays(today, days)).order("calculated_date").limit(40);
  if (error) return section("lease_events", "Important lease events", [], "", { href: "/leases", label: "Leases" }, `Lease dates could not be loaded (${error.message}).`);
  const rows = (data ?? []) as { id: string; lease_id: string; date_type: string; label: string | null; calculated_date: string; verification_status: VerificationStatus }[];
  const ids = [...new Set(rows.map((r) => r.lease_id))];
  const names = new Map<string, string>();
  if (ids.length) for (const l of ((await ctx.db.from("lease").select("id, tenant_name_raw").eq("workspace_id", ctx.workspaceId).in("id", ids)).data ?? []) as { id: string; tenant_name_raw: string | null }[]) names.set(l.id, l.tenant_name_raw ?? "Lease");
  const items = rows.map((r): PlannerItem => {
    const confirmed = r.verification_status === "confirmed";
    return {
      key: `ld:${r.id}`, title: `${names.get(r.lease_id) ?? "Lease"} — ${r.label ?? DATE_LABEL[r.date_type] ?? r.date_type}`, href: `/leases/${r.lease_id}`,
      meta: `${r.calculated_date} · ${confirmed ? VERIFICATION_LABEL.confirmed : `Not verified — ${VERIFICATION_LABEL[r.verification_status]}`}`,
      tone: confirmed ? "bad" : "warn",
    };
  });
  return section("lease_events", "Important lease events", items, `No lease dates in the next ${days} days.`, { href: "/leases", label: "Leases" });
}

/**
 * Review (master spec 2.2 REVIEW / 7.1): transaction approvals waiting for me, lease dates needing review and
 * conflicting lease terms (proposed term versions). Links go to the owning module's screen where the decision is made.
 */
export async function reviewIntegrationSections(ctx: { db: Db; workspaceId: string; userId: string }): Promise<PlannerSection[]> {
  const ws = ctx.workspaceId;
  const [appr, dates, terms] = await Promise.all([
    ctx.db.from("tx_approval").select("id, transaction_id, category, version_label, deadline, status, tx_transaction!inner(archived_at)").eq("workspace_id", ws).eq("reviewer_user_id", ctx.userId)
      .is("invalidated_at", null).is("archived_at", null).is("tx_transaction.archived_at", null).in("status", ["pending", "under_review", "changes_requested"]).order("deadline", { ascending: true, nullsFirst: false }).limit(40),
    ctx.db.from("lease_date").select("id, lease_id, date_type, label, calculated_date, verification_status, review_reason").eq("workspace_id", ws).is("archived_at", null)
      .is("superseded_by", null).in("verification_status", ["needs_review", "conflicting"]).order("calculated_date", { ascending: true, nullsFirst: false }).limit(40),
    ctx.db.from("lease_term_version").select("id, lease_id, version, source, created_at").eq("workspace_id", ws).is("archived_at", null).eq("status", "proposed").order("created_at", { ascending: false }).limit(40),
  ]);
  const leaseIds = [...new Set([...(dates.data ?? []), ...(terms.data ?? [])].map((r) => (r as { lease_id: string }).lease_id))];
  const names = new Map<string, string>();
  if (leaseIds.length) for (const l of ((await ctx.db.from("lease").select("id, tenant_name_raw").eq("workspace_id", ws).in("id", leaseIds)).data ?? []) as { id: string; tenant_name_raw: string | null }[]) names.set(l.id, l.tenant_name_raw ?? "Lease");
  const txIds = [...new Set((appr.data ?? []).map((a) => (a as { transaction_id: string }).transaction_id))];
  const codes = new Map<string, string>();
  if (txIds.length) for (const t of ((await ctx.db.from("tx_transaction").select("id, code").eq("workspace_id", ws).in("id", txIds)).data ?? []) as { id: string; code: string }[]) codes.set(t.id, t.code);
  const fail = (e: { message: string } | null, what: string) => (e ? `${what} could not be loaded (${e.message}).` : null);
  return [
    section("tx_approvals", "Transaction approvals waiting for you", ((appr.data ?? []) as { id: string; transaction_id: string; category: string; version_label: string; deadline: string | null; status: string }[]).map((a) => ({
      key: `txa:${a.id}`, title: `${codes.get(a.transaction_id) ?? "Transaction"} — ${codeLabel(a.category)} approval`, href: `/transactions/${a.transaction_id}`,
      meta: `${a.version_label}${a.deadline ? ` · decide by ${a.deadline}` : ""} · ${codeLabel(a.status)}`, tone: a.deadline ? "bad" : "warn" })),
      "No transaction approvals assigned to you.", { href: "/transactions", label: "Transactions" }, fail(appr.error, "Transaction approvals")),
    section("lease_dates_review", "Lease dates needing review", ((dates.data ?? []) as { id: string; lease_id: string; date_type: string; label: string | null; calculated_date: string | null; verification_status: VerificationStatus; review_reason: string | null }[]).map((d) => ({
      key: `ldr:${d.id}`, title: `${names.get(d.lease_id) ?? "Lease"} — ${d.label ?? DATE_LABEL[d.date_type] ?? d.date_type}`, href: `/leases/${d.lease_id}`,
      meta: `${d.calculated_date ?? "date unknown"} · ${VERIFICATION_LABEL[d.verification_status]}${d.review_reason ? ` · ${d.review_reason.slice(0, 120)}` : ""}`, tone: d.verification_status === "conflicting" ? "bad" : "warn" })),
      "No lease dates waiting for review.", { href: "/leases", label: "Leases" }, fail(dates.error, "Lease dates")),
    section("lease_terms_review", "Lease terms to confirm (possible conflicts)", ((terms.data ?? []) as { id: string; lease_id: string; version: number; source: string }[]).map((t) => ({
      key: `ltv:${t.id}`, title: `${names.get(t.lease_id) ?? "Lease"} — proposed terms v${t.version}`, href: `/leases/${t.lease_id}`, meta: `From ${t.source}. Compare with current terms before confirming.`, tone: "warn" })),
      "No proposed lease terms waiting.", { href: "/leases", label: "Leases" }, fail(terms.error, "Lease terms")),
  ];
}

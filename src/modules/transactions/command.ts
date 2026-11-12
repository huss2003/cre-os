import { localDate } from "@/lib/util/time";
import type { TxCtx } from "./ctx";
import { q } from "./ctx";
import { AGREED_STATUSES, TX_TYPE_LABEL, isOpenIssue, isOverdue, milestoneMatrix } from "./model";
import {
  closureBlockers, depositsView, getTransaction, issuesView, listApprovals, listOffers, listPoints, positionsView, stakeholdersView, timeline,
} from "./service";
import { offerVersionDiffs, type StoredOffer } from "./negotiation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DB rows are untyped here
type Row = any;

/** §15 command view — everything read from records; nothing inferred or invented. */
export async function commandView(ctx: TxCtx, txId: string, asOf = localDate(new Date())) {
  const tx = await getTransaction(ctx, txId);
  const [stages, offers, points, issues, approvals, stakeholders, deposits, msRows, docs, docReqs, inspections, clarifs, fitout, handover, events, blockers, positions] = await Promise.all([
    q<Row[]>(ctx.db.from("tx_stage").select("*").eq("transaction_id", txId).order("sort_order"), "stages"),
    listOffers(ctx, txId), listPoints(ctx, txId), issuesView(ctx, txId, asOf), listApprovals(ctx, txId), stakeholdersView(ctx, txId, asOf), depositsView(ctx, txId, asOf),
    q<Row[]>(ctx.db.from("tx_milestone").select("*").eq("transaction_id", txId), "milestones"),
    q<Row[]>(ctx.db.from("tx_document").select("id, doc_kind, family, version_no, title, status, signing_status, sha256, reconciliation, diff_report, created_at").eq("transaction_id", txId).order("family").order("version_no"), "documents"),
    q<Row[]>(ctx.db.from("tx_doc_request").select("*").eq("transaction_id", txId).is("archived_at", null), "doc requests"),
    q<Row[]>(ctx.db.from("tx_inspection").select("*").eq("transaction_id", txId).is("archived_at", null).order("inspection_date"), "inspections"),
    q<Row[]>(ctx.db.from("tx_clarification").select("*").eq("transaction_id", txId).is("archived_at", null), "clarifications"),
    q<Row | null>(ctx.db.from("tx_fitout").select("*").eq("transaction_id", txId).is("archived_at", null).maybeSingle(), "fitout"),
    q<Row[]>(ctx.db.from("tx_handover_item").select("*").eq("transaction_id", txId).is("archived_at", null).order("created_at"), "handover"),
    timeline(ctx, txId), closureBlockers(ctx, txId), positionsView(ctx, txId),
  ]);
  const counterpartyOffers = offers.filter((o) => ["landlord", "developer", "operator"].includes(o.offering_party));
  const clientOffers = offers.filter((o) => !["landlord", "developer", "operator"].includes(o.offering_party));
  const pendingApprovals = approvals.filter((a) => !a.invalidated_at && ["pending", "under_review", "changes_requested"].includes(a.status));
  const latestDocs = Object.values(docs.reduce<Record<string, Row>>((m, d) => ((m[d.family] = d), m), {}));
  const matrix = milestoneMatrix(msRows as any);

  const dependencies = {
    waitingOnApprovals: pendingApprovals.map((a) => `${a.category.replace(/_/g, " ")}: ${a.version_label}${a.deadline ? ` (by ${a.deadline})` : ""}`),
    documentsWaitingOnSignature: latestDocs.filter((d) => ["agreed", "client_review", "counterparty_review", "submitted"].includes(d.status) && d.signing_status !== "signed").map((d) => `${d.title} v${d.version_no}`),
    inspectionsWaitingOnAccess: inspections.filter((i) => i.status === "waiting_access" || i.status === "scheduled").map((i) => `${i.inspection_type} ${i.inspection_date}`),
    termsWaitingOnDecision: points.filter((p) => ["proposed", "under_negotiation", "pending_clarification", "subject_to_approval"].includes(p.status)).map((p) => `${p.label}: ${p.value ?? "unknown"} (${p.status})`),
    possessionWaitingOnConditions: msRows.filter((m) => m.kind === "possession_completed" && !m.achieved_on && m.outstanding_conditions).map((m) => m.outstanding_conditions),
    fitoutWaitingOnApprovals: fitout && fitout.approvals_status !== "approved" ? [`fit-out approvals ${fitout.approvals_status}`] : [],
    issuesWaitingOnIssues: issues.dependent.map((d) => `${d.issue.title} waits on ${d.waitingOn.length} issue(s)`),
  };

  const nextActions = [
    ...issues.open.filter((i) => i.next_action).map((i) => ({ what: i.next_action as string, why: i.title as string, due: i.due_date as string | null, owner: i.internal_owner_user_id as string, overdue: isOverdue(i as any, asOf), blocking: !!i.blocking })),
    ...pendingApprovals.map((a) => ({ what: `Decide ${a.category.replace(/_/g, " ")} approval`, why: a.version_label as string, due: a.deadline as string | null, owner: a.reviewer_user_id as string, overdue: !!a.deadline && a.deadline < asOf, blocking: true })),
  ].sort((a, b) => Number(b.blocking) - Number(a.blocking) || Number(b.overdue) - Number(a.overdue) || String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));

  const route = [
    ...stages.filter((s) => s.status === "pending" || s.status === "in_progress").map((s) => ({ step: s.title as string, status: s.status as string })),
    ...matrix.filter((m) => !m.achieved).map((m) => ({ step: m.label, status: "milestone not achieved" })),
    ...blockers.map((b) => ({ step: `Resolve ${b}`, status: "closure condition" })),
  ];

  const upcoming = [
    ...offers.filter((o) => o.response_status === "pending" && o.valid_until && o.valid_until >= asOf).map((o) => ({ date: o.valid_until, what: `Offer v${o.version_no} expires` })),
    ...issues.open.filter((i) => i.due_date && i.due_date >= asOf).map((i) => ({ date: i.due_date, what: `Issue due: ${i.title}` })),
    ...pendingApprovals.filter((a) => a.deadline).map((a) => ({ date: a.deadline, what: `Approval deadline: ${a.version_label}` })),
    ...deposits.filter((d) => d.due_date && !d.paid_on).map((d) => ({ date: d.due_date, what: `Deposit due (${d.deposit_type})` })),
    ...msRows.filter((m) => m.expected_on && !m.achieved_on).map((m) => ({ date: m.expected_on, what: `Expected: ${m.kind.replace(/_/g, " ")}` })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    tx, typeLabel: TX_TYPE_LABEL[tx.tx_type] ?? tx.tx_type, stages, currentStage: stages.find((s) => s.key === tx.current_stage) ?? null,
    negotiation: {
      latestOffer: counterpartyOffers[counterpartyOffers.length - 1] ?? null, latestCounteroffer: clientOffers[clientOffers.length - 1] ?? null, versions: offers,
      diffs: offerVersionDiffs(offers as StoredOffer[]),
      agreed: points.filter((p) => AGREED_STATUSES.includes(p.status)), disputed: points.filter((p) => ["under_negotiation", "rejected"].includes(p.status)),
      pendingClarification: points.filter((p) => p.status === "pending_clarification"), proposed: points.filter((p) => p.status === "proposed"),
    },
    positions, points, issues, approvals, pendingApprovals, stakeholders, deposits, milestones: matrix, milestoneRows: msRows, documents: docs, latestDocuments: latestDocs,
    docRequests: docReqs, outstandingDocuments: docReqs.filter((d) => d.status !== "verified"), inspections, clarifications: clarifs,
    discrepancies: clarifs.filter((c) => c.status === "discrepancy"), fitout, handover, openHandover: handover.filter((h) => h.status === "open"),
    dependencies, nextActions, route, upcoming, blockers, events,
    blockingNow: [...issues.blocking.map((i) => `Issue: ${i.title}`), ...issues.overdue.filter((i) => !i.blocking).map((i) => `Overdue issue: ${i.title}`), ...pendingApprovals.map((a) => `Approval pending: ${a.category.replace(/_/g, " ")} — ${a.version_label}`)],
    openIssueCount: issues.open.filter(isOpenIssue).length,
  };
}
export type CommandView = Awaited<ReturnType<typeof commandView>>;

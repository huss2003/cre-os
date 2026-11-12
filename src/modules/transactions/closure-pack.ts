import { createHash, randomUUID } from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { TxCtx } from "./ctx";
import { TxError } from "./ctx";
import { commandView, type CommandView } from "./command";
import { record } from "./events";
import { MILESTONE_LABEL } from "./model";

const BUCKET = "mudar-workspace-files";
export const CLOSURE_PURPOSE = "transaction_closure_pack";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const pointValue = (v: CommandView, key: string) => {
  const p = v.points.find((x) => x.term_key === key && ["agreed", "subject_to_approval", "documented", "verified_executed"].includes(x.status));
  return p ? `${p.value} (${p.status === "verified_executed" ? "verified against executed agreement" : p.status.replace(/_/g, " ")})` : "Not agreed / unknown";
};

/** Pure model of the closure pack (§16). Each milestone is shown from its own record — never inferred from another. */
export function closurePackModel(v: CommandView) {
  const execDoc = v.milestoneRows.find((m) => m.kind === "executed")?.document_id;
  const doc = v.documents.find((d) => d.id === execDoc);
  return {
    title: `Closure pack — ${v.tx.name} (${v.tx.code})`,
    overview: [["Transaction", `${v.tx.name} (${v.tx.code})`], ["Type", v.typeLabel], ["Status", v.tx.status], ["Client org id", v.tx.client_org_id ?? "—"], ["Property", (v.tx.property_labels ?? []).join(", ") || "—"]],
    terms: [["Final agreed area", pointValue(v, "areaSf")], ["Rent ₹/SF/month", pointValue(v, "rentPerSf")], ["CAM ₹/SF/month", pointValue(v, "camPerSf")], ["Deposit (months)", pointValue(v, "depositMonths")],
      ["Escalation %", pointValue(v, "escalationPct")], ["Lock-in (months)", pointValue(v, "lockInMonths")], ["Lease duration (months)", pointValue(v, "tenureMonths")], ["Possession date", pointValue(v, "possessionDate")]],
    executedRef: doc ? `${doc.title} v${doc.version_no} (sha256 ${String(doc.sha256).slice(0, 12)}…)` : "No executed agreement recorded",
    milestones: v.milestones.map((m) => [MILESTONE_LABEL[m.kind], m.achieved ? `Yes — ${m.achievedOn}` : `No${m.expectedOn ? ` (expected ${m.expectedOn})` : ""}`]),
    approvals: v.approvals.filter((a) => a.status === "approved" && !a.invalidated_at).map((a) => [a.category.replace(/_/g, " "), `${a.version_label} — ${a.decided_by_kind === "external_recorded" ? "recorded from counterparty/client" : "decided by assigned reviewer"} ${String(a.decision_on ?? "").slice(0, 10)}`]),
    offers: v.negotiation.versions.map((o) => [`v${o.version_no} ${o.kind} (${o.offering_party})`, `${o.offer_date} — ${o.response_status}${o.reason ? ` — ${o.reason}` : ""}`]),
    deposits: v.deposits.map((d) => [d.deposit_type, `₹${d.amount ?? "unknown"} — ${d.headline}`]),
    outstanding: [...v.issues.open.map((i) => `Issue: ${i.title} — next: ${i.next_action}`), ...v.outstandingDocuments.map((d) => `Document: ${d.title} (${d.status})`), ...v.pendingApprovals.map((a) => `Approval: ${a.category} ${a.version_label}`)],
    handover: v.handover.map((h) => [`${h.item_kind}: ${h.description}`, `${h.status}${h.evidence ? ` — ${h.evidence}` : ""}`]),
    postExecution: [...v.openHandover.map((h) => `Handover: ${h.description}`), ...v.blockers.map((b) => `Closure: ${b}`), v.tx.lease_handoff ? `Lease Lifecycle hand-off: ${v.tx.lease_handoff.status}` : "Lease Lifecycle hand-off: not started"],
  };
}

const cell = (t: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold })] })] });
const table = (rows: string[][]) => (rows.length ? new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map((r) => new TableRow({ children: r.map((c, i) => cell(c, i === 0)) })) }) : new Paragraph("None recorded."));
const h = (t: string) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2 });

export async function buildClosurePackDocx(m: ReturnType<typeof closurePackModel>): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [
    new Paragraph({ text: m.title, heading: HeadingLevel.TITLE }),
    new Paragraph("Milestones below are separate facts: commercially agreed, legally approved, signed, executed, possession, occupancy and handover are never inferred from one another."),
    h("Transaction overview"), table(m.overview), h("Final commercial terms"), table(m.terms), h("Executed agreement"), new Paragraph(m.executedRef),
    h("Milestones"), table(m.milestones), h("Important approvals"), table(m.approvals), h("Offer history"), table(m.offers), h("Deposits"), table(m.deposits),
    h("Outstanding obligations"), ...(m.outstanding.length ? m.outstanding.map((x) => new Paragraph({ text: x, bullet: { level: 0 } })) : [new Paragraph("None.")]),
    h("Handover observations"), table(m.handover), h("Pending post-execution activities"), ...m.postExecution.map((x) => new Paragraph({ text: x, bullet: { level: 0 } })),
  ];
  return Packer.toBuffer(new Document({ title: m.title, sections: [{ children: body }] }));
}

/** Generate + store the pack (document_version, purpose transaction_closure_pack). Available any time; flags open items. */
export async function generateClosurePack(ctx: TxCtx, txId: string) {
  const v = await commandView(ctx, txId);
  const model = closurePackModel(v);
  const buf = await buildClosurePackDocx(model);
  const sha = createHash("sha256").update(buf).digest("hex");
  const path = `${ctx.workspaceId}/transactions/${txId}/${randomUUID()}.docx`;
  const up = await ctx.db.storage.from(BUCKET).upload(path, buf, { contentType: DOCX_MIME, upsert: false });
  if (up.error) throw new TxError(500, `storage upload failed: ${up.error.message}`);
  const ins = await ctx.db.from("document_version").insert({
    workspace_id: ctx.workspaceId, kind: "docx", purpose: CLOSURE_PURPOSE, uri: `${BUCKET}/${path}`, sha256: sha, owner_user_id: ctx.userId,
    linked_entity_type: "tx_transaction", linked_entity_id: txId, input_versions: { transaction_id: txId, blockers: v.blockers, milestones: v.milestones },
  }).select("id, version_no").single();
  if (ins.error) { await ctx.db.storage.from(BUCKET).remove([path]); throw new TxError(500, ins.error.message); }
  await record(ctx, txId, { kind: "closure_pack", summary: `Closure pack generated (version ${ins.data.version_no})${v.blockers.length ? ` — open: ${v.blockers.join("; ")}` : ""}`, subjectType: "document_version", subjectId: ins.data.id });
  return { documentId: ins.data.id as string, versionNo: ins.data.version_no as number, sha256: sha, buffer: buf, model };
}

export async function downloadClosurePack(ctx: TxCtx, documentId: string) {
  const d = (await ctx.db.from("document_version").select("uri, sha256, purpose").eq("workspace_id", ctx.workspaceId).eq("id", documentId).maybeSingle()).data;
  if (!d || d.purpose !== CLOSURE_PURPOSE) throw new TxError(404, "closure pack not found");
  const dl = await ctx.db.storage.from(BUCKET).download(String(d.uri).slice(BUCKET.length + 1));
  if (dl.error || !dl.data) throw new TxError(404, "file not found");
  const buf = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buf).digest("hex") !== d.sha256) throw new TxError(409, "file integrity check failed");
  return buf;
}

/**
 * Finance CSV import → reconciliation (RLS-scoped, user context). Idempotent per file hash: importing the same export
 * twice returns the first result and proposes nothing new. Differences become change proposals on fee_milestone
 * (risk high_value, approved by a human in /approvals) — recorded amounts are never written here.
 */
import { createHash } from "node:crypto";
import { proposeChange } from "@/lib/services/changes";
import { type DealsCtx, DealsError, dbError, owned } from "../ctx";
import { parseFinanceCsv, reconcile, type FeeForRecon } from "./reconcile";

export const MAX_IMPORT_BYTES = 2_000_000;

export async function importFinanceCsv(ctx: DealsCtx, input: { fileName: string; text: string; sourceSystem?: string | null }) {
  if (!input.text?.trim()) throw new DealsError(400, "the file is empty");
  if (Buffer.byteLength(input.text) > MAX_IMPORT_BYTES) throw new DealsError(413, "file too large (max 2 MB)");
  const sha256 = createHash("sha256").update(input.text).digest("hex");
  const prior = await ctx.db.from("fee_recon_import").select("*").eq("workspace_id", ctx.workspaceId).eq("sha256", sha256).maybeSingle();
  if (prior.data) return { import: prior.data, replayed: true };

  const parsed = parseFinanceCsv(input.text);
  if (parsed.error) throw new DealsError(400, parsed.error, { columns: parsed.unmappedColumns });
  const [feesR, oppsR] = await Promise.all([
    ctx.db.from("fee_milestone").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(5000),
    ctx.db.from("opportunity").select("id, crm_external_id").eq("workspace_id", ctx.workspaceId).is("archived_at", null).limit(5000),
  ]);
  if (feesR.error) throw dbError(feesR.error, "fee_milestone");
  if (oppsR.error) throw dbError(oppsR.error, "opportunity");
  const fees = (feesR.data ?? []) as (FeeForRecon & { classification: string; evidence: string | null })[];
  const report = reconcile(parsed.rows, fees, (oppsR.data ?? []) as { id: string; crm_external_id: string | null }[]);

  const summary: Record<string, number> = { matched: 0, mismatch: 0, missing_in_cre_os: 0, unmatched: 0, invalid: 0, not_in_export: report.notInExport.length, proposals: 0 };
  for (const r of report.results) summary[r.status]++;
  const imp = await ctx.db.from("fee_recon_import").insert({
    ...owned(ctx), file_name: input.fileName.slice(0, 200), sha256, source_system: input.sourceSystem?.slice(0, 100) ?? null,
    row_count: parsed.rows.length, totals: { ...report.totals, notInExport: report.notInExport }, summary, status: "processed",
  }).select("*").single();
  if (imp.error) {
    if (imp.error.code === "23505") {
      const again = await ctx.db.from("fee_recon_import").select("*").eq("workspace_id", ctx.workspaceId).eq("sha256", sha256).maybeSingle();
      if (again.data) return { import: again.data, replayed: true };
    }
    throw dbError(imp.error, "fee_recon_import");
  }
  const importId = (imp.data as { id: string }).id;
  const feeById = new Map(fees.map((f) => [f.id, f]));
  const rows = [];
  for (const r of report.results) {
    const proposalIds: string[] = [];
    if (r.feeMilestoneId && Object.keys(r.patch).length) {
      const f = feeById.get(r.feeMilestoneId)!;
      const note = `Official finance import "${input.fileName}" row ${r.row.rowNo}${r.row.invoiceNo ? ` (invoice ${r.row.invoiceNo})` : ""}`;
      const patch = [...Object.entries(r.patch).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })),
        { op: "replace" as const, path: "/evidence", value: [f.evidence, note].filter(Boolean).join("\n") }];
      try {
        const p = await proposeChange(ctx.db, ctx.workspaceId, {
          targetType: "fee_milestone", targetId: f.id, patch, expectedVersion: Number(f.row_version),
          reason: `${note}: ${r.exceptions.join("; ")}. Official finance records are authoritative — approve to align CRE OS.`,
          idempotencyKey: `deals.feerecon:${sha256.slice(0, 32)}:${r.row.rowNo}`, classification: f.classification, ownerUserId: ctx.userId,
        });
        proposalIds.push(String(p.id));
        summary.proposals++;
      } catch (e) {
        r.exceptions.push(`could not create a change proposal: ${(e as Error).message}`);
      }
    }
    rows.push({
      ...owned(ctx), import_id: importId, row_no: r.row.rowNo, raw: r.row.raw, invoice_no: r.row.invoiceNo, deal_ref: r.row.dealRef,
      invoice_date: r.row.invoiceDate, invoice_amount: r.row.invoiceAmount, due_date: r.row.dueDate, collected_amount: r.row.collectedAmount,
      collected_date: r.row.collectedDate, currency: r.row.currency, fee_milestone_id: r.feeMilestoneId, match_method: r.matchMethod,
      status: r.status, exceptions: r.exceptions, proposal_ids: proposalIds,
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const ins = await ctx.db.from("fee_recon_row").insert(rows.slice(i, i + 200));
    if (ins.error) throw dbError(ins.error, "fee_recon_row");
  }
  const upd = await ctx.db.from("fee_recon_import").update({ summary }).eq("id", importId).select("*").single();
  return { import: upd.data ?? imp.data, replayed: false, report };
}

export async function listImports(ctx: DealsCtx, limit = 20) {
  const r = await ctx.db.from("fee_recon_import").select("*").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(limit);
  if (r.error) throw dbError(r.error, "fee_recon_import");
  return r.data ?? [];
}

export async function importRows(ctx: DealsCtx, importId: string) {
  const r = await ctx.db.from("fee_recon_row").select("*").eq("import_id", importId).order("row_no");
  if (r.error) throw dbError(r.error, "fee_recon_row");
  return r.data ?? [];
}

/** Reconciliation exceptions touching one deal (latest import first) — shown on /deals/[id]. */
export async function dealReconExceptions(ctx: DealsCtx, opportunityId: string) {
  const fees = ((await ctx.db.from("fee_milestone").select("id").eq("opportunity_id", opportunityId)).data ?? []) as { id: string }[];
  if (!fees.length) return [];
  const r = await ctx.db.from("fee_recon_row").select("id, import_id, row_no, invoice_no, status, exceptions, proposal_ids, created_at, fee_milestone_id")
    .in("fee_milestone_id", fees.map((f) => f.id)).neq("status", "matched").order("created_at", { ascending: false }).limit(50);
  return r.data ?? [];
}

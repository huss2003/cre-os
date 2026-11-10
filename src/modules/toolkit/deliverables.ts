/**
 * Module 8 — Client deliverables. From one requirement + any saved analyses, builds:
 *   (a) an editable proposal DOCX, (b) an XLSX with one sheet per analysis (inputs, outputs, formula version),
 *   (c) a decision summary DOCX (options, recommendation, financial implications, trade-offs, risks, assumptions,
 *       outstanding approvals).
 * Figures are copied from stored analysis versions — never recomputed or invented here (S5/S6). Any figure from an
 * analysis that needs info, is not approved, or sits under an estimated/reported/AI-inferred status is LABELLED.
 * Files go to storage <ws>/toolkit/deliverables/<id>/…; the file references + analysis versions used are saved via
 * saveAnalysis(kind "deliverable"). Brand comes from the tenant's template_asset / workspace (deals brandFrom).
 */
import { createHash, randomUUID } from "node:crypto";
import { Document, HeadingLevel, Packer, Paragraph, Table, TextRun } from "docx";
import ExcelJS from "exceljs";
import type { Db } from "@/lib/supabase/server";
import { brandFrom, type Brand } from "@/modules/deals/documents/model";
import { table as docTable } from "@/modules/deals/documents/docx";
import { BUCKET, mimeFor } from "@/modules/deals/documents/service";
import { buildBrief, type Brief } from "./brief";
import { saveAnalysis } from "./store";

export const DELIVERABLE_FORMULA = "deliverable-1.0";
export const KIND_LABEL: Record<string, string> = {
  brief: "Requirement brief", property_comparison: "Property comparison", lease_economics: "Lease economics", occupancy: "Occupancy economics",
  conventional_vs_managed: "Conventional vs managed", renewal_vs_relocation: "Renewal vs relocation", fitout: "Fit-out", financing: "Financing",
  negotiation: "Negotiation", deliverable: "Client deliverable",
};
const UNVERIFIED = new Set(["estimated", "reported", "ai_inference", "assumption", "unknown", "unverified", "indicative"]);

export interface AnalysisIn { id: string; kind: string; title: string; status: string; version: number; formula_version: string | null; missing: string[]; inputs: unknown; outputs: unknown; approved_at?: string | null }
export interface Line { path: string; value: string; flag: string | null }
export interface PreparedAnalysis extends AnalysisIn { flags: string[]; inputLines: Line[]; outputLines: Line[]; recommendation: string | null }

/** Whole-analysis labels: missing info / not approved. */
export function analysisFlags(a: Pick<AnalysisIn, "status" | "missing">): string[] {
  const f: string[] = [];
  if ((a.missing ?? []).length || a.status === "needs_info") f.push(`MISSING INFO: ${(a.missing ?? []).join(", ") || "analysis marked as needing information"}`);
  if (a.status !== "approved") f.push("UNVERIFIED: analysis not approved");
  return f;
}

const fmt = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

/** Flatten inputs/outputs into labelled lines. Leaves under an object whose status/fact_status is estimated etc. are flagged. */
export function flatten(value: unknown, prefix = "", inherited: string | null = null, out: Line[] = [], cap = 600): Line[] {
  if (out.length >= cap) return out;
  if (value === null || value === undefined || value === "") { out.push({ path: prefix || "(value)", value: "—", flag: "MISSING" }); return out; }
  if (Array.isArray(value)) {
    if (value.every((x) => x === null || typeof x !== "object")) { out.push({ path: prefix || "(list)", value: value.map(fmt).join(", ") || "—", flag: inherited }); return out; }
    value.forEach((x, i) => flatten(x, `${prefix}[${i + 1}]`, inherited, out, cap));
    return out;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const st = [o.fact_status, o.status, o.basis_status, o.confidence_status].find((x) => typeof x === "string" && UNVERIFIED.has(String(x).toLowerCase())) as string | undefined;
    const flag = st ? `${st.toUpperCase().replace(/_/g, " ")} — not confirmed` : inherited;
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, flag, out, cap);
    return out;
  }
  out.push({ path: prefix || "(value)", value: fmt(value), flag: inherited });
  return out;
}

function recommendationOf(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== "object") return null;
  const o = outputs as Record<string, unknown>;
  const r = o.recommended ?? o.recommendation ?? o.recommended_option ?? o.winner;
  if (r === null || r === undefined || r === "") return null;
  if (typeof r === "object") { const x = r as Record<string, unknown>; return String(x.name ?? x.label ?? x.title ?? x.option ?? JSON.stringify(r)); }
  return String(r);
}

export function prepare(a: AnalysisIn): PreparedAnalysis {
  return { ...a, flags: analysisFlags(a), inputLines: flatten(a.inputs), outputLines: flatten(a.outputs), recommendation: recommendationOf(a.outputs) };
}

export interface DeliverableModel { brand: Brand; title: string; preparedFor: string | null; asOf: string; brief: Brief; analyses: PreparedAnalysis[] }

const pick = (lines: Line[], re: RegExp) => lines.filter((l) => re.test(l.path));
const show = (l: Line) => `${l.path}: ${l.value}${l.flag ? `  [${l.flag}]` : ""}`;

function kit(m: DeliverableModel) {
  const font = m.brand.font;
  const H = (t: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, children: [new TextRun({ text: t, font: m.brand.headingFont ?? font, color: m.brand.primary })] });
  const P = (t: string, o: { italic?: boolean; color?: string; bold?: boolean } = {}) => new Paragraph({ children: [new TextRun({ text: t, font, italics: o.italic, color: o.color, bold: o.bold })] });
  const B = (t: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: t, font })] });
  const W = (t: string) => P(t, { color: m.brand.accent, bold: true });
  const T = (head: string[], rows: string[][]) => docTable(head, rows, m.brand.primary, font);
  const pack = async (title: string, body: (Paragraph | Table)[]) => Packer.toBuffer(new Document({ creator: m.brand.name, title, styles: { default: { document: { run: { font } } } }, sections: [{ children: body }] }));
  const footer = (): Paragraph[] => [H("Sources and versions", HeadingLevel.HEADING_2),
    B(`Requirement "${m.brief.title}" at row version ${m.brief.rowVersion}`),
    ...m.analyses.map((a) => B(`${KIND_LABEL[a.kind] ?? a.kind} "${a.title}" — version ${a.version}, formula ${a.formula_version ?? "—"}, status ${a.status}`)),
    ...(m.brand.disclaimer ? [P(m.brand.disclaimer, { italic: true })] : [])];
  return { H, P, B, W, T, pack, footer };
}

/** (a) Editable proposal. */
export async function buildProposal(m: DeliverableModel): Promise<Buffer> {
  const { H, P, B, W, T, pack, footer } = kit(m);
  const body: (Paragraph | Table)[] = [H(m.title, HeadingLevel.TITLE), P(`${m.brief.organisation ?? "Client"} · prepared ${m.asOf}${m.preparedFor ? ` for ${m.preparedFor}` : ""} · draft — edit before sending`, { italic: true })];
  body.push(H("Your requirement"));
  for (const s of m.brief.sections) {
    body.push(H(s.title, HeadingLevel.HEADING_2));
    body.push(T(["Item", "Value", "Status"], s.fields.map((f) => [f.label, f.value ?? "—", f.status])));
  }
  if (m.brief.openQuestions.length) { body.push(H("Still to confirm", HeadingLevel.HEADING_2)); for (const q of m.brief.openQuestions.slice(0, 20)) body.push(B(q.question)); }
  body.push(H("Our analysis"));
  if (!m.analyses.length) body.push(P("No analyses were selected for this proposal."));
  for (const a of m.analyses) {
    body.push(H(`${KIND_LABEL[a.kind] ?? a.kind}: ${a.title}`, HeadingLevel.HEADING_2));
    for (const f of a.flags) body.push(W(f));
    if (a.recommendation) body.push(P(`Recommended: ${a.recommendation}`, { bold: true }));
    const key = a.outputLines.slice(0, 25);
    body.push(T(["Result", "Value", "Label"], key.map((l) => [l.path, l.value, l.flag ?? (a.flags.length ? "Unverified" : "")])));
  }
  body.push(...footer());
  return pack(m.title, body);
}

/** (c) Decision summary. */
export async function buildDecisionSummary(m: DeliverableModel): Promise<Buffer> {
  const { H, P, B, W, T, pack, footer } = kit(m);
  const body: (Paragraph | Table)[] = [H(`Decision summary — ${m.brief.title}`, HeadingLevel.TITLE), P(`As of ${m.asOf}`, { italic: true })];
  const recs = m.analyses.filter((a) => a.recommendation);
  body.push(H("Options considered"));
  if (!m.analyses.length) body.push(P("No analyses selected."));
  for (const a of m.analyses) body.push(B(`${KIND_LABEL[a.kind] ?? a.kind}: ${a.title}${a.flags.length ? ` [${a.flags.join("; ")}]` : ""}`));
  body.push(H("Recommended option"));
  if (!recs.length) body.push(P("Not determined — none of the selected analyses states a recommendation."));
  for (const a of recs) body.push(P(`${a.recommendation} (from ${KIND_LABEL[a.kind] ?? a.kind} "${a.title}" v${a.version})${a.flags.length ? " — UNVERIFIED" : ""}`));
  const section = (title: string, re: RegExp, empty: string) => {
    body.push(H(title));
    const rows = m.analyses.flatMap((a) => pick(a.outputLines, re).slice(0, 15).map((l) => [a.title, l.path, l.value, l.flag ?? (a.flags.length ? "Unverified" : "")]));
    if (rows.length) body.push(T(["Analysis", "Item", "Value", "Label"], rows)); else body.push(P(empty, { italic: true }));
  };
  section("Financial implications", /(rent|cost|tco|npv|total|saving|fee|capex|emi|monthly|annual|per_sf|per_seat|deposit|irr|payback)/i, "No financial figures in the selected analyses.");
  section("Trade-offs", /(trade|pro|con|advantage|disadvantage)/i, "No trade-offs recorded in the selected analyses.");
  section("Risks", /risk/i, "No risks recorded in the selected analyses.");
  body.push(H("Assumptions and unconfirmed items"));
  const assumed = m.brief.sections.flatMap((s) => s.fields).filter((f) => f.status === "Estimated" || f.status === "Assumption");
  for (const f of assumed) body.push(B(`${f.label}: ${f.value} (${f.status})`));
  for (const a of m.analyses) for (const l of pick(a.outputLines.concat(a.inputLines), /assum/i).slice(0, 10)) body.push(B(`${a.title} — ${show(l)}`));
  for (const a of m.analyses) for (const l of a.inputLines.filter((x) => x.flag).slice(0, 10)) body.push(B(`${a.title} input — ${show(l)}`));
  if (m.brief.missing.length) body.push(W(`Missing requirement information: ${m.brief.missing.join(", ")}`));
  body.push(H("Outstanding approvals"));
  const out = [...m.analyses.filter((a) => a.status !== "approved").map((a) => `Analysis "${a.title}" (${a.status.replace(/_/g, " ")})`),
    ...m.brief.pendingApprovals.map((p) => `Requirement change ${p.id.slice(0, 8)} — ${p.state}${p.reason ? `: ${p.reason}` : ""}`)];
  if (out.length) for (const o of out) body.push(B(o)); else body.push(P("None."));
  body.push(...footer());
  return pack(`Decision summary — ${m.brief.title}`, body);
}

/** (b) Spreadsheet: a summary sheet + one sheet per analysis. */
export async function buildWorkbook(m: DeliverableModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = m.brand.name;
  const head = (ws: ExcelJS.Worksheet, cols: string[]) => { const r = ws.addRow(cols); r.font = { bold: true, color: { argb: "FFFFFFFF" } }; r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${m.brand.primary}` } }; };
  const sum = wb.addWorksheet("Summary");
  sum.addRow([m.title]).font = { bold: true, size: 14 };
  sum.addRow([`Requirement: ${m.brief.title}`, `Row version ${m.brief.rowVersion}`, `As of ${m.asOf}`]);
  sum.addRow([]);
  head(sum, ["Sheet", "Kind", "Title", "Version", "Formula", "Status", "Labels"]);
  const used = new Set<string>(["Summary"]);
  m.analyses.forEach((a, i) => {
    let name = `${i + 1} ${(KIND_LABEL[a.kind] ?? a.kind)}`.replace(/[\\/?*[\]:']/g, " ").slice(0, 31).trim();
    while (used.has(name)) name = name.slice(0, 28) + `_${i}`;
    used.add(name);
    sum.addRow([name, KIND_LABEL[a.kind] ?? a.kind, a.title, a.version, a.formula_version ?? "—", a.status, a.flags.join("; ")]);
    const ws = wb.addWorksheet(name);
    ws.addRow([a.title]).font = { bold: true, size: 13 };
    ws.addRow(["Formula version", a.formula_version ?? "—", "Analysis version", a.version, "Status", a.status]);
    for (const f of a.flags) ws.addRow([f]).font = { bold: true, color: { argb: `FF${m.brand.accent}` } };
    ws.addRow([]);
    head(ws, ["Section", "Item", "Value", "Label"]);
    for (const l of a.inputLines) ws.addRow(["Input", l.path, l.value, l.flag ?? ""]);
    for (const l of a.outputLines) ws.addRow(["Output", l.path, l.value, l.flag ?? (a.flags.length ? "Unverified" : "")]);
    ws.columns = [{ width: 10 }, { width: 44 }, { width: 28 }, { width: 36 }];
  });
  sum.columns = [{ width: 26 }, { width: 24 }, { width: 36 }, { width: 9 }, { width: 14 }, { width: 12 }, { width: 60 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------------ service
type Row = Record<string, any>;
export interface DeliverableFile { name: string; label: string; kind: "docx" | "xlsx"; path: string; sha256: string; bytes: number }

export async function loadBriefFor(db: Db, ws: string, requirementId: string): Promise<Brief> {
  const { data: req, error } = await db.from("requirement").select("*, organisation:org_id(display_name)").eq("workspace_id", ws).eq("id", requirementId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!req) throw new Error("Requirement not found.");
  const r = req as Row;
  const geoIds = [...new Set([...(r.preferred_geography_ids ?? []), ...(r.excluded_geography_ids ?? [])])];
  const [stake, props, geos, meets] = await Promise.all([
    db.from("stakeholder").select("role, person:person_id(full_name)").eq("requirement_id", requirementId).is("archived_at", null),
    db.from("change_proposal").select("id, state, reason").eq("target_type", "requirement").eq("target_id", requirementId).in("state", ["proposed", "approved", "clarify"]),
    geoIds.length ? db.from("geography").select("id, name").in("id", geoIds) : Promise.resolve({ data: [] as Row[] }),
    db.from("meeting_prep").select("outcome, meeting:meeting_visit_id(title, start_at)").eq("workspace_id", ws).eq("requirement_id", requirementId).is("archived_at", null).not("outcome", "is", null).limit(20),
  ]);
  return buildBrief({
    requirement: r as never, stakeholders: (stake.data ?? []) as never, pendingProposals: (props.data ?? []) as never, geographies: (geos.data ?? []) as never,
    meetings: ((meets.data ?? []) as Row[]).map((m) => ({ outcome: m.outcome, title: m.meeting?.title ?? null, start_at: m.meeting?.start_at ?? null })),
  });
}

export interface GenerateDeliverablesInput { requirementId: string; analysisIds: string[]; preparedFor?: string | null; title?: string | null }

export async function generateDeliverables(db: Db, ws: string, userId: string, g: GenerateDeliverablesInput, asOf = new Date().toISOString().slice(0, 10)) {
  const brief = await loadBriefFor(db, ws, g.requirementId);
  let analyses: AnalysisIn[] = [];
  if (g.analysisIds.length) {
    const { data, error } = await db.from("deal_analysis").select("id, kind, title, status, current_version, formula_version, missing, inputs, outputs, approved_at").eq("workspace_id", ws).in("id", g.analysisIds).neq("kind", "deliverable");
    if (error) throw new Error(error.message);
    analyses = ((data ?? []) as Row[]).map((a) => ({ id: a.id, kind: a.kind, title: a.title, status: a.status, version: a.current_version, formula_version: a.formula_version, missing: a.missing ?? [], inputs: a.inputs, outputs: a.outputs, approved_at: a.approved_at }));
    analyses.sort((a, b) => g.analysisIds.indexOf(a.id) - g.analysisIds.indexOf(b.id));
  }
  const tpl = (await db.from("template_asset").select("brand_json").eq("workspace_id", ws).eq("purpose", "proposal").is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as { brand_json: Record<string, unknown> } | null;
  const wsRow = (await db.from("workspace").select("name").eq("id", ws).maybeSingle()).data as { name: string } | null;
  const model: DeliverableModel = { brand: brandFrom(tpl?.brand_json, wsRow?.name ?? "CRE OS"), title: g.title?.trim() || `Proposal — ${brief.title}`, preparedFor: g.preparedFor ?? null, asOf, brief, analyses: analyses.map(prepare) };
  const folder = `${ws}/toolkit/deliverables/${randomUUID()}`;
  const built: [string, string, "docx" | "xlsx", Buffer][] = [
    ["proposal.docx", "Proposal (editable)", "docx", await buildProposal(model)],
    ["analysis-workbook.xlsx", "Analysis workbook", "xlsx", await buildWorkbook(model)],
    ["decision-summary.docx", "Decision summary", "docx", await buildDecisionSummary(model)],
  ];
  const files: DeliverableFile[] = [];
  for (const [name, label, kind, buf] of built) {
    const path = `${folder}/${name}`;
    const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: mimeFor(kind), upsert: false });
    if (up.error) { if (files.length) await db.storage.from(BUCKET).remove(files.map((f) => f.path)); throw new Error(`storage upload failed: ${up.error.message}`); }
    files.push({ name, label, kind, path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
  }
  const used = analyses.map((a) => ({ id: a.id, kind: a.kind, title: a.title, version: a.version, formula_version: a.formula_version, status: a.status, flags: analysisFlags(a) }));
  const missing = [...brief.missing.map((m) => `requirement: ${m}`), ...analyses.filter((a) => a.missing.length || a.status === "needs_info").map((a) => `analysis "${a.title}" needs info`)];
  const saved = await saveAnalysis(db, ws, userId, {
    kind: "deliverable", title: model.title, requirementId: g.requirementId, orgId: ((await db.from("requirement").select("org_id").eq("id", g.requirementId).maybeSingle()).data as Row | null)?.org_id ?? null,
    inputs: { requirementId: g.requirementId, requirementRowVersion: brief.rowVersion, analyses: used, preparedFor: g.preparedFor ?? null, asOf },
    outputs: { files, labelledAnalyses: used.filter((u) => u.flags.length).length }, formulaVersion: DELIVERABLE_FORMULA, missing,
  });
  return { ...saved, files, missing };
}

/** Download one stored deliverable file (path must belong to this workspace + hash must match). */
export async function downloadDeliverable(db: Db, ws: string, analysisId: string, name: string) {
  const { data } = await db.from("deal_analysis").select("outputs, kind").eq("workspace_id", ws).eq("id", analysisId).maybeSingle();
  if (!data || (data as Row).kind !== "deliverable") throw new Error("Deliverable not found.");
  const f = (((data as Row).outputs?.files ?? []) as DeliverableFile[]).find((x) => x.name === name);
  if (!f || !f.path.startsWith(`${ws}/toolkit/deliverables/`)) throw new Error("File not found.");
  const dl = await db.storage.from(BUCKET).download(f.path);
  if (dl.error || !dl.data) throw new Error("File not found in storage.");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buffer).digest("hex") !== f.sha256) throw new Error("Stored file does not match its recorded hash.");
  return { buffer, mime: mimeFor(f.kind), fileName: f.name };
}

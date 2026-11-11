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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export const DELIVERABLE_FORMULA = "deliverable-1.0";
export const KIND_LABEL: Record<string, string> = {
  brief: "Requirement brief", property_comparison: "Property comparison", lease_economics: "Lease economics", occupancy: "Occupancy economics",
  conventional_vs_managed: "Conventional vs managed", renewal_vs_relocation: "Renewal vs relocation", fitout: "Fit-out", financing: "Financing",
  negotiation: "Negotiation", deliverable: "Client deliverable", bts: "Built-to-suit", investment: "Investment analysis",
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

/** Readable recommendation text: never raw JSON. {key, explanation} → explanation (or the matching property's NAME). */
export function recommendationOf(outputs: unknown): string | null {
  if (!outputs || typeof outputs !== "object") return null;
  const o = outputs as Record<string, unknown>;
  const r = o.recommended ?? o.recommendation ?? o.recommended_option ?? o.winner;
  if (r === null || r === undefined || r === "") {
    const top = ((o.comparison as Record<string, unknown> | undefined)?.rows as Record<string, unknown>[] | undefined)?.find((x) => x.rank === 1);
    return top ? `${String(top.name)} — lowest present value of occupancy cost over the equal horizon` : null;
  }
  if (typeof r !== "object") return String(r);
  const x = r as Record<string, unknown>;
  const nameOfKey = (k: unknown) => (k ? (((o.properties ?? o.offers ?? []) as Record<string, unknown>[]).find((p) => p.key === k)?.name as string | undefined) ?? null : null);
  const text = [x.explanation, x.text, x.reason].find((t) => typeof t === "string" && t.trim()) as string | undefined;
  if (text) return text;
  const named = x.name ?? x.label ?? x.title ?? x.option ?? nameOfKey(x.key);
  if (named) return String(named);
  return x.key === null ? "No option can be recommended yet — see missing information." : null;
}

export function prepare(a: AnalysisIn): PreparedAnalysis {
  return { ...a, flags: analysisFlags(a), inputLines: flatten(a.inputs), outputLines: flatten(a.outputs), recommendation: recommendationOf(a.outputs) };
}

export interface DeliverableModel { brand: Brand; templateNote?: string; title: string; preparedFor: string | null; asOf: string; brief: Brief; analyses: PreparedAnalysis[] }

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
    B(m.templateNote ?? "Neutral layout (no corporate template configured)"),
    ...m.analyses.map((a) => B(`${KIND_LABEL[a.kind] ?? a.kind} "${a.title}" — version ${a.version}, formula ${a.formula_version ?? "—"}, status ${a.status}`)),
    ...(m.brand.disclaimer ? [P(m.brand.disclaimer, { italic: true })] : [])];
  return { H, P, B, W, T, pack, footer };
}

type K = ReturnType<typeof kit>;
type Block = Paragraph | Table;
const money = (x: unknown) => (x === null || x === undefined || x === "" ? "Not provided" : `₹${Number(x).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const txt = (x: unknown, none = "Unknown") => (x === null || x === undefined || x === "" ? none : typeof x === "number" ? x.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(x));
const arr = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);
const strList = (x: unknown): string[] => arr(x).map((y) => (typeof y === "string" ? y : String((y as Row)?.label ?? (y as Row)?.text ?? ""))).filter(Boolean);
const leaseOffers = (out: Row): Row[] => (out.mode === "compare" ? arr(out.comparison?.offers) : out.result ? [out.result] : arr(out.comparison?.offers));

/** Structured, readable content per analysis kind (copied from stored outputs — no recomputation, S5). */
function analysisContent(m: DeliverableModel, k: K) {
  const { P, B, T, W } = k;
  const details: Block[] = [], commercial: Block[] = [], occupancy: Block[] = [], pros: Block[] = [], cons: Block[] = [], feedback: Block[] = [], other: Block[] = [];
  const assumptions: string[] = [], missing: string[] = [], recs: string[] = [], evidence: string[] = [];
  for (const a of m.analyses) {
    const out = (a.outputs ?? {}) as Row, inp = (a.inputs ?? {}) as Row;
    const lbl = a.flags.length ? " (unverified)" : "";
    const src = `${KIND_LABEL[a.kind] ?? a.kind} "${a.title}"`;
    for (const f of a.flags) assumptions.push(`${src}: ${f}`);
    for (const x of a.missing ?? []) missing.push(`${src}: ${x}`);
    if (a.recommendation) recs.push(`${a.recommendation} — from ${src} v${a.version}${lbl}`);
    switch (a.kind) {
      case "property_comparison": {
        const ins = arr(inp.properties);
        details.push(P(`From ${src}:`, { italic: true }));
        details.push(T(["Property", "Micro-market", "Grade", "Area (SF)", "Rent ₹/SF/mo", "CAM ₹/SF/mo", "Deposit (months)", "Rent-free (months)", "Escalation"], ins.map((p) => [txt(p.name), txt(p.microMarket), txt(p.grade), `${txt(p.areaSf)}${p.areaBasis ? ` ${p.areaBasis}` : ""}`, txt(p.rent), txt(p.cam), txt(p.depositMonths), txt(p.rentFreeMonths), p.escalationPct == null ? "Unknown" : `${p.escalationPct}% every ${txt(p.escalationEveryMonths)} months`])));
        const ps = arr(out.properties).slice().sort((x, y) => (x.rank ?? 99) - (y.rank ?? 99));
        commercial.push(P(`Weighted rating (${txt(out.model?.name)} model, ${txt(out.termMonths)}-month term${out.termAssumed ? ", assumed" : ""})${lbl}:`, { italic: true }));
        commercial.push(T(["Rank", "Property", "Score /100", "Effective occupancy cost ₹/SF/mo", "Eligibility", "Evidence"], ps.map((p) => [txt(p.rank, "—"), txt(p.name), txt(p.score), txt(p.occupancyCost), String(p.eligibility ?? "").replace(/_/g, " "), txt(p.evidence)])));
        for (const p of ps) {
          if (arr(p.advantages).length) { pros.push(P(String(p.name), { bold: true })); for (const x of strList(p.advantages)) pros.push(B(x)); }
          if (arr(p.disadvantages).length || arr(p.limitations).length) { cons.push(P(String(p.name), { bold: true })); for (const x of [...strList(p.disadvantages), ...strList(p.limitations)]) cons.push(B(x)); }
          for (const x of strList(p.missing)) missing.push(`${p.name}: ${x}`);
          for (const x of strList(p.verification)) evidence.push(`${p.name}: ${x}`);
        }
        if (out.termAssumed) assumptions.push(`${src}: term assumed ${out.termMonths} months for cost comparison`);
        assumptions.push(`${src}: occupancy cost = rent with escalation, less rent-free, plus CAM, averaged per month over the term; refundable deposit excluded`);
        for (const f of arr(out.siteVisitFeedback)) {
          feedback.push(P(`${f.name} — ${f.meeting}${f.date ? `, ${f.date}` : ""}${f.interest ? ` · interest: ${f.interest}` : ""}${f.overall ? ` · ${f.overall}/5` : ""}${f.clientRejected ? " · client clearly rejected it" : ""}`, { bold: true }));
          for (const c of strList(f.comments)) feedback.push(B(c));
          for (const c of strList(f.concerns)) feedback.push(B(`Concern — ${c}`));
        }
        break;
      }
      case "lease_economics": {
        const offers = leaseOffers(out);
        occupancy.push(P(`From ${src}${lbl}. Monthly figures are for the first rent-paying month; the refundable deposit is shown separately and is not a cost.`, { italic: true }));
        occupancy.push(T(["Option", "Area", "Monthly rent", "Monthly CAM", "Total before other charges", "CAM escalation", "Other charges", "Refundable deposit"], offers.map((o) => [txt(o.name), `${txt(o.areaSf)} SF ${txt(o.areaBasis, "")}`, money(o.monthly?.baseRent), money(o.monthly?.cam), money(o.monthly?.totalBeforeOther ?? (o.monthly?.cam != null ? Number(o.monthly.baseRent) + Number(o.monthly.cam) : null)), txt(o.camEscalation, "none"), o.monthly?.other == null ? "Not provided" : money(o.monthly.other), o.deposit ? `${money(o.deposit.amount)} (refunded month ${o.deposit.refundMonth})` : "Unknown"])));
        const yrs = offers.length ? Math.max(...offers.map((o) => arr(o.years).length)) : 0;
        occupancy.push(P(`${yrs}-year totals:`, { bold: true }));
        occupancy.push(T(["Option", "Total rent", "Total CAM", "Total contractual cost", "Present value (NPV)", "Rent-free benefit", "Completeness"], offers.map((o) => [txt(o.name), money(o.totals?.rent), money(o.totals?.cam), money(o.totals?.contractualExpenditure), money(o.totals?.npv), money(o.rentFreeBenefit), txt(o.totalsLabel)])));
        for (const o of offers) { for (const g of strList(o.gaps)) missing.push(`${o.name}: ${g}`); for (const w of strList(o.warnings)) assumptions.push(`${o.name}: ${w}`); }
        assumptions.push(`${src}: rates are ₹ per SF per month on the stated area basis; unknown charges are excluded, never counted as 0`);
        break;
      }
      case "negotiation": {
        const offers = arr(out.offers);
        commercial.push(P(`Offer history — ${src}${lbl}:`, { italic: true }));
        commercial.push(T(["#", "Offer", "Total rent", "Nominal total", "NPV", "Deposit (refundable)"], offers.map((o) => [txt(o.no), txt(o.label), money(o.rentTotal), money(o.nominalTotal), money(o.npv), money(o.depositAmount)])));
        for (const w of strList(out.warnings)) assumptions.push(`${src}: ${w}`);
        break;
      }
      default: {
        other.push(P(src, { bold: true }));
        other.push(T(["Result", "Value", "Label"], a.outputLines.slice(0, 25).map((l) => [l.path, l.value, l.flag ?? (a.flags.length ? "Unverified" : "")])));
        for (const x of strList(out.assumptions)) assumptions.push(`${src}: ${x}`);
      }
    }
    for (const l of a.inputLines.filter((x) => x.flag && x.flag !== "MISSING").slice(0, 10)) assumptions.push(`${src} input — ${show(l)}`);
  }
  for (const f of m.brief.sections.flatMap((x) => x.fields).filter((f) => f.status === "Estimated" || f.status === "Assumption")) assumptions.push(`Requirement — ${f.label}: ${f.value} (${f.status})`);
  for (const x of m.brief.missing) missing.push(`Requirement: ${x}`);
  void W;
  return { details, commercial, occupancy, pros, cons, feedback, other, assumptions: [...new Set(assumptions)], missing: [...new Set(missing)], recs, evidence: [...new Set(evidence)] };
}

function sectionBlocks(m: DeliverableModel, k: K, c: ReturnType<typeof analysisContent>, opts: { requirement: boolean; decision?: boolean }): Block[] {
  const { H, P, B, T } = k;
  const body: Block[] = [];
  const sec = (title: string, blocks: Block[], empty: string) => { body.push(H(title)); body.push(...(blocks.length ? blocks : [P(empty, { italic: true })])); };
  if (opts.requirement) {
    body.push(H("Your requirement"));
    for (const s of m.brief.sections) { body.push(H(s.title, HeadingLevel.HEADING_2)); body.push(T(["Item", "Value", "Status"], s.fields.map((f) => [f.label, f.value ?? "—", f.status]))); }
    if (m.brief.openQuestions.length) { body.push(H("Still to confirm", HeadingLevel.HEADING_2)); for (const q of m.brief.openQuestions.slice(0, 20)) body.push(B(q.question)); }
  }
  if (!m.analyses.length) body.push(P("No analyses were selected for this document."));
  sec("Property details", c.details, "No property comparison selected.");
  if (opts.decision) body.push(H("Financial implications"));
  sec("Commercial comparison", c.commercial, "No commercial comparison selected.");
  sec("Occupancy costs", c.occupancy, "No lease economics selected — occupancy costs not calculated.");
  if (opts.decision) body.push(H("Trade-offs"));
  sec("Advantages", c.pros, "No advantages recorded.");
  sec("Shortcomings", c.cons, "No shortcomings recorded.");
  if (c.feedback.length) sec("Site-visit feedback", [P("Client feedback from site visits — shown for context; it does not change the rating or exclude any option.", { italic: true }), ...c.feedback], "");
  if (c.other.length) sec("Other analyses", c.other, "");
  sec("Assumptions", c.assumptions.map((x) => B(x)), "No assumptions recorded.");
  sec("Missing information", c.missing.map((x) => B(x)), "None — all required inputs were provided.");
  body.push(H("Recommendation"));
  if (!c.recs.length) body.push(P("Recommended: not determined — none of the selected analyses states a recommendation."));
  for (const r of c.recs) body.push(P(`Recommended: ${r}`, { bold: true }));
  body.push(H("Supporting evidence"));
  for (const e of c.evidence) body.push(B(e));
  return body;
}

/** (a) Editable proposal. */
export async function buildProposal(m: DeliverableModel): Promise<Buffer> {
  const k = kit(m);
  const body: Block[] = [k.H(m.title, HeadingLevel.TITLE), k.P(`${m.brief.organisation ?? "Client"} · prepared ${m.asOf}${m.preparedFor ? ` for ${m.preparedFor}` : ""} · draft — edit before sending`, { italic: true })];
  body.push(...sectionBlocks(m, k, analysisContent(m, k), { requirement: true }), ...k.footer());
  return k.pack(m.title, body);
}

/** (c) Decision summary. */
export async function buildDecisionSummary(m: DeliverableModel): Promise<Buffer> {
  const k = kit(m);
  const { H, P, B } = k;
  const body: Block[] = [H(`Decision summary — ${m.brief.title}`, HeadingLevel.TITLE), P(`As of ${m.asOf}`, { italic: true })];
  body.push(H("Options considered"));
  if (!m.analyses.length) body.push(P("No analyses selected."));
  for (const a of m.analyses) body.push(B(`${KIND_LABEL[a.kind] ?? a.kind}: ${a.title}${a.flags.length ? ` [${a.flags.join("; ")}]` : ""}`));
  body.push(H("Recommended option"));
  const recs = m.analyses.filter((a) => a.recommendation);
  if (!recs.length) body.push(P("Not determined — none of the selected analyses states a recommendation."));
  for (const a of recs) body.push(P(`${a.recommendation} (from ${KIND_LABEL[a.kind] ?? a.kind} "${a.title}" v${a.version})${a.flags.length ? " — UNVERIFIED" : ""}`));
  body.push(...sectionBlocks(m, k, analysisContent(m, k), { requirement: false, decision: true }));
  body.push(H("Risks"));
  const risks = m.analyses.flatMap((a) => pick(a.outputLines, /risk/i).slice(0, 10).map((l) => `${a.title} — ${l.value}`));
  if (risks.length) for (const r of risks) body.push(B(r)); else body.push(P("No risks recorded in the selected analyses.", { italic: true }));
  body.push(H("Outstanding approvals"));
  const out = [...m.analyses.filter((a) => a.status !== "approved").map((a) => `Analysis "${a.title}" (${a.status.replace(/_/g, " ")})`),
    ...m.brief.pendingApprovals.map((p) => `Requirement change ${p.id.slice(0, 8)} — ${p.state}${p.reason ? `: ${p.reason}` : ""}`)];
  if (out.length) for (const o of out) body.push(B(o)); else body.push(P("None."));
  body.push(...k.footer());
  return k.pack(`Decision summary — ${m.brief.title}`, body);
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
export interface DeliverableFile { name?: string; label: string; kind: "docx" | "xlsx" | "pdf" | "pptx" | string; path: string; sha256: string; bytes: number }

/** Stable download key for a stored file: its name, else the basename of its path (older pack rows had no name). */
export function deliverableFileName(f: Pick<DeliverableFile, "name" | "path">, index = 0): string {
  return f.name || (f.path ? f.path.split("/").pop() : "") || String(index);
}

const FILE_MIME: Record<string, string> = { pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };

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
  const tpl = (await db.from("template_asset").select("id, name, version, approved, brand_json").eq("workspace_id", ws).eq("purpose", "proposal").is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as { id: string; name: string; version: number; approved: boolean; brand_json: Record<string, unknown> } | null;
  const wsRow = (await db.from("workspace").select("name").eq("id", ws).maybeSingle()).data as { name: string } | null;
  const model: DeliverableModel = { brand: brandFrom(tpl?.brand_json, wsRow?.name ?? "CRE OS"), templateNote: tpl ? `Corporate template "${tpl.name}" v${tpl.version}${tpl.approved ? "" : " (not approved)"}` : undefined, title: g.title?.trim() || `Proposal — ${brief.title}`, preparedFor: g.preparedFor ?? null, asOf, brief, analyses: analyses.map(prepare) };
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
    inputs: { requirementId: g.requirementId, template: tpl ? { id: tpl.id, version: tpl.version } : null, requirementRowVersion: brief.rowVersion, analyses: used, preparedFor: g.preparedFor ?? null, asOf },
    outputs: { files, labelledAnalyses: used.filter((u) => u.flags.length).length }, formulaVersion: DELIVERABLE_FORMULA, missing,
  });
  return { ...saved, files, missing };
}

/** Download one stored deliverable file (path must belong to this workspace + hash must match). */
export async function downloadDeliverable(db: Db, ws: string, analysisId: string, name: string) {
  const { data } = await db.from("deal_analysis").select("outputs, kind").eq("workspace_id", ws).eq("id", analysisId).maybeSingle();
  if (!data || (data as Row).kind !== "deliverable") throw new Error("Deliverable not found.");
  const list = ((data as Row).outputs?.files ?? []) as DeliverableFile[];
  const f = list.find((x, i) => deliverableFileName(x, i) === name) ?? (/^\d+$/.test(name) ? list[Number(name)] : undefined);
  if (!f || !(f.path.startsWith(`${ws}/toolkit/deliverables/`) || f.path.startsWith(`${ws}/packs/`))) throw new Error("File not found.");
  const dl = await db.storage.from(BUCKET).download(f.path);
  if (dl.error || !dl.data) throw new Error("File not found in storage.");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buffer).digest("hex") !== f.sha256) throw new Error("Stored file does not match its recorded hash.");
  return { buffer, mime: FILE_MIME[f.kind] ?? mimeFor(f.kind), fileName: deliverableFileName(f) };
}

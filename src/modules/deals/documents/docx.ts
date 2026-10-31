/** Editable proposal (native Word headings, paragraphs, tables and native charts). Market note: ./market-note.ts. */
import { AlignmentType, Document, Footer, Header, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { DocModel } from "./model";
import { chartMarker, injectDocxCharts, type DocxChart } from "./ooxml-charts";
import { chartSpecs } from "./visuals";

export const inr = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export function table(head: string[], rows: string[][], color: string, font: string) {
  const cell = (t: string, bold = false, fill?: string) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: t, bold, font, color: fill ? "FFFFFF" : undefined, size: 18 })] })],
    shading: fill ? { fill } : undefined,
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: head.map((h) => cell(h, true, color)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))],
  });
}

/** Shared building blocks for the Word builders (brand font/colours, logo header, watermark, sources section). */
export function wordKit(m: DocModel) {
  const font = m.brand.font, hfont = m.brand.headingFont ?? font;
  const H = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
    new Paragraph({ heading: level, children: [new TextRun({ text, font: hfont, color: m.brand.primary })] });
  const P = (text: string, opts: { italic?: boolean; color?: string; size?: number } = {}) => new Paragraph({ children: [new TextRun({ text, font, italics: opts.italic, color: opts.color, size: opts.size })] });
  const B = (text: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text, font })] });
  const charts: DocxChart[] = [];
  const colors = [m.brand.primary, m.brand.accent, "7F8C8D", "2E86AB"];
  const chart = (c: Omit<DocxChart, "n" | "colors">) => { const n = charts.length + 1; charts.push({ ...c, n, colors }); return new Paragraph({ children: [new TextRun({ text: chartMarker(n) })] }); };
  const header = () => {
    const kids: (TextRun | ImageRun)[] = [];
    if (m.brand.logo) {
      const h = 28, w = Math.max(1, Math.round((m.brand.logo.width / Math.max(1, m.brand.logo.height)) * h));
      kids.push(new ImageRun({ type: m.brand.logo.type, data: Buffer.from(m.brand.logo.data, "base64"), transformation: { width: Math.min(w, 160), height: h } }), new TextRun({ text: "   " }));
    }
    kids.push(new TextRun({ text: m.watermark, italics: true, color: m.brand.accent, size: 16, font }));
    return new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: kids })] });
  };
  const footer = () => new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `${m.brand.name} · ${m.template.name} v${m.template.version ?? 0}${m.version ? ` · document v${m.version.no}` : ""}`, size: 14, color: "666666", font })] })] });
  /** "Sources and versions" — every input + calculation version the document was built from. */
  const sources = (): Paragraph[] => {
    const out = [H("Sources and calculation versions", HeadingLevel.HEADING_2)];
    for (const s of m.sources ?? []) out.push(B(s));
    for (const s of m.templateCarryOver ?? []) out.push(B(s));
    return out;
  };
  const visuals = (): Paragraph[] => {
    const out: Paragraph[] = [];
    const specs = chartSpecs(m);
    if (specs.length) out.push(H("Charts", HeadingLevel.HEADING_2));
    for (const s of specs) {
      out.push(chart({ title: s.title, kind: "bar", spec: s, widthIn: 6, heightIn: 3.2 }));
      for (const n of s.notes) out.push(P(n, { italic: true, size: 16 }));
    }
    out.push(H("Location map (schematic)", HeadingLevel.HEADING_2));
    if (m.map) {
      const w = 6, h = Math.min(4.5, Math.max(2.5, w / m.map.aspect));
      out.push(chart({ title: "Options and preferred areas", kind: "map", map: m.map, widthIn: w, heightIn: h }));
      out.push(P(`${m.map.note} Plot width ≈ ${m.map.widthKm.toFixed(1)} km (scale ${m.map.scaleKm} km ≈ ${(m.map.scaleFraction * 100).toFixed(0)} % of the width). Circles = options, diamonds = preferred areas.`, { italic: true, size: 16 }));
    } else out.push(P("No map: none of the options or preferred areas has stored coordinates (add latitude/longitude to the buildings or micro-markets).", { italic: true }));
    return out;
  };
  const pack = async (title: string, body: (Paragraph | Table)[]) => {
    const doc = new Document({
      creator: m.brand.name, title, description: `${m.template.name} v${m.template.version ?? 0}`,
      styles: { default: { document: { run: { font } } } },
      sections: [{ headers: { default: header() }, footers: { default: footer() }, children: body }],
    });
    return injectDocxCharts(await Packer.toBuffer(doc), charts);
  };
  return { font, H, P, B, chart, sources, visuals, pack };
}

export async function buildProposalDocx(m: DocModel): Promise<Buffer> {
  const { font, H, P, B, sources, visuals, pack } = wordKit(m);
  const body: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, font: m.brand.headingFont ?? font, color: m.brand.primary })] }),
    P(`Prepared for ${m.clientName}${m.preparedFor ? ` · ${m.preparedFor}` : ""} · ${m.generatedAt.slice(0, 10)}${m.version ? ` · version ${m.version.no}` : ""}`),
  ];
  if (m.requirement) {
    body.push(H("Requirement"));
    body.push(P(m.requirement.status === "client_confirmed" ? "Status: client confirmed." : "Status: provisional — not yet confirmed by the client.", { italic: true }));
    body.push(table(["Item", "Value"], m.requirement.lines.map(([k, v]) => [k, v]), m.brand.primary, font));
    if (m.requirement.missing.length) { body.push(H("Open questions", HeadingLevel.HEADING_2)); m.requirement.missing.forEach((q) => body.push(B(q))); }
  }
  const opts = m.options.filter((o) => o.eligibility !== "ineligible");
  if (opts.length) {
    body.push(H("Recommended options"));
    body.push(table(["#", "Option", "Status", "Fit", "Data", "Area", "All-in cost", "Availability"],
      opts.slice(0, 15).map((o) => [String(o.rank), o.label, o.eligibility === "eligible" ? "Eligible" : "Needs verification", o.fitScore === null ? "—" : String(o.fitScore), o.completenessScore === null ? "—" : `${o.completenessScore}%`, o.area, o.cost, o.availability]),
      m.brand.primary, font));
    for (const o of opts.slice(0, 15)) for (const v of [...o.flags, ...o.verification]) body.push(B(`${o.label}: ${v}`));
  }
  if (m.comparison.length) {
    body.push(H("Financial comparison"));
    body.push(P("All scenarios use the same horizon, base date and discount rate. Figures are produced by the deterministic finance engine; see the comparison workbook for the monthly cash flows."));
    body.push(table(["Scenario", "NPV", "Nominal TCO", "Equivalent monthly", "₹/chargeable SF/mo", "Rank"],
      m.comparison.map((c) => [c.name, inr(c.npv), inr(c.nominalTco), inr(c.equivalentMonthly), inr(c.perChargeableSfMonth), String(c.rank)]), m.brand.primary, font));
  }
  body.push(...visuals());
  for (const n of m.notes ?? []) body.push(P(n));
  body.push(H("Assumptions and sources"));
  m.assumptions.forEach((a) => body.push(B(a)));
  body.push(H("Data freshness", HeadingLevel.HEADING_2));
  m.freshness.forEach((a) => body.push(B(a)));
  body.push(...sources());
  if (m.brand.disclaimer) body.push(P(m.brand.disclaimer, { italic: true }));
  return pack(m.title, body);
}

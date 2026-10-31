/** Editable proposal / market note (native Word headings, paragraphs and tables). */
import { AlignmentType, Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import type { DocModel } from "./model";

const inr = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

function table(head: string[], rows: string[][], color: string, font: string) {
  const cell = (t: string, bold = false, fill?: string) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: t, bold, font, color: fill ? "FFFFFF" : undefined, size: 18 })] })],
    shading: fill ? { fill } : undefined,
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: head.map((h) => cell(h, true, color)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))],
  });
}

export async function buildProposalDocx(m: DocModel): Promise<Buffer> {
  const font = m.brand.font;
  const H = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) =>
    new Paragraph({ heading: level, children: [new TextRun({ text, font, color: m.brand.primary })] });
  const P = (text: string, opts: { italic?: boolean; color?: string } = {}) => new Paragraph({ children: [new TextRun({ text, font, italics: opts.italic, color: opts.color })] });
  const B = (text: string) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text, font })] });

  const body: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, font, color: m.brand.primary })] }),
    P(`Prepared for ${m.clientName}${m.preparedFor ? ` · ${m.preparedFor}` : ""} · ${m.generatedAt.slice(0, 10)}`),
  ];
  if (m.requirement) {
    body.push(H(m.purpose === "market_note" ? "Context" : "Requirement"));
    body.push(P(m.requirement.status === "client_confirmed" ? "Status: client confirmed." : "Status: provisional — not yet confirmed by the client.", { italic: true }));
    body.push(table(["Item", "Value"], m.requirement.lines.map(([k, v]) => [k, v]), m.brand.primary, font));
    if (m.requirement.missing.length) { body.push(H("Open questions", HeadingLevel.HEADING_2)); m.requirement.missing.forEach((q) => body.push(B(q))); }
  }
  const opts = m.options.filter((o) => o.eligibility !== "ineligible");
  if (opts.length) {
    body.push(H(m.purpose === "market_note" ? "Relevant availability" : "Recommended options"));
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
  for (const n of m.notes ?? []) body.push(P(n));
  body.push(H("Assumptions and sources"));
  m.assumptions.forEach((a) => body.push(B(a)));
  body.push(H("Data freshness", HeadingLevel.HEADING_2));
  m.freshness.forEach((a) => body.push(B(a)));
  if (m.brand.disclaimer) body.push(P(m.brand.disclaimer, { italic: true }));

  const doc = new Document({
    creator: m.brand.name, title: m.title, description: `${m.template.name} v${m.template.version ?? 0}`,
    styles: { default: { document: { run: { font } } } },
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: m.watermark, italics: true, color: m.brand.accent, size: 16, font })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `${m.brand.name} · ${m.template.name} v${m.template.version ?? 0}`, size: 14, color: "666666", font })] })] }) },
      children: body,
    }],
  });
  return Packer.toBuffer(doc);
}

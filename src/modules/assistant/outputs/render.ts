/**
 * One-click deliverables from assistant blocks (Module 12 round 2, upgrade 10).
 * Pure renderers: blocks -> neutral section model -> PPTX (pptxgenjs) / DOCX (docx) / PDF (pdf-lib).
 * Values are copied verbatim from the blocks (S5: no arithmetic here); unknowns stay "Unknown" (S6).
 */
import type { Block, SourceRef } from "../types";
import { DEFAULT_BRAND, type Brand } from "@/modules/deals/documents/model";

export type ExportFormat = "pptx" | "docx" | "pdf";
export interface Section { heading: string; paragraphs: string[]; bullets: string[]; table?: { columns: string[]; rows: string[][] }; note?: string }
export interface ExportModel { title: string; subtitle: string; brand: Brand; sections: Section[]; sources: SourceRef[]; missing: string[] }

const cell = (v: unknown) => (v === null || v === undefined || v === "" ? "Unknown" : String(v));
/** Markdown -> plain lines (renderers never interpret markup). */
export function mdPlain(md: string): { paragraphs: string[]; bullets: string[] } {
  const paragraphs: string[] = []; const bullets: string[] = [];
  const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").trim();
  for (const raw of md.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, "")).split(/\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const b = l.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (b) bullets.push(clean(b[1])); else paragraphs.push(clean(l.replace(/^#+\s*/, "")));
  }
  return { paragraphs, bullets };
}

/** Does this message have anything worth exporting beyond plain text? */
export const hasStructured = (blocks: Block[]) => blocks.some((b) => !["text", "status", "approval", "download", "draft"].includes(b.kind));

export function toSections(blocks: Block[], leadText?: string | null): { sections: Section[]; sources: SourceRef[]; missing: string[] } {
  const sections: Section[] = []; const sources: SourceRef[] = []; const missing: string[] = [];
  if (leadText?.trim()) { const p = mdPlain(leadText); sections.push({ heading: "Summary", ...p }); }
  for (const b of blocks) {
    switch (b.kind) {
      case "text": { const p = mdPlain(b.markdown); if (p.paragraphs.length || p.bullets.length) sections.push({ heading: "Notes", ...p }); break; }
      case "entity_card":
        sections.push({ heading: b.entity.label, paragraphs: [], bullets: [], table: { columns: ["Field", "Value", "Status"], rows: b.fields.map((f) => [f.label, cell(f.value), f.status ?? "unknown"]) } });
        sources.push(...(b.sources ?? [])); break;
      case "table":
        sections.push({ heading: b.title ?? "Table", paragraphs: [], bullets: [], table: { columns: b.columns, rows: b.rows.map((r) => b.columns.map((_, i) => cell(r[i]))) }, note: b.note });
        sources.push(...(b.sources ?? [])); break;
      case "ranked_list":
        sections.push({ heading: b.title ?? "Ranked list", paragraphs: [], bullets: [], table: { columns: ["#", "Name", "Score", "Why", "Next"], rows: b.items.map((i) => [String(i.rank), i.entity.label, cell(i.score), i.why, i.next ?? ""]) } }); break;
      case "brief":
        for (const s of b.sections) sections.push({ heading: `${b.title} — ${s.heading}`, paragraphs: [], bullets: s.bullets }); break;
      case "tasks":
        sections.push({ heading: b.title ?? "Tasks", paragraphs: [], bullets: b.items.map((t) => `[${t.done ? "x" : " "}] ${t.title}${t.due ? ` (due ${t.due})` : ""}${t.entity ? ` — ${t.entity.label}` : ""}`) }); break;
      case "map":
        sections.push({ heading: b.title ?? "Map points", paragraphs: [b.note], bullets: [], table: { columns: ["Place", "Type", "Lat", "Lon"], rows: b.points.map((p) => [p.label, p.kind, String(p.lat), String(p.lon)]) } }); break;
      case "draft":
        sections.push({ heading: `Draft ${b.channel}${b.subject ? `: ${b.subject}` : ""}`, paragraphs: [b.preview, "Draft only — not sent."], bullets: [] }); break;
      case "sources": sources.push(...b.items); break;
      case "missing": missing.push(...b.items); break;
      default: break; // status / approval / download are UI-only
    }
  }
  const seen = new Set<string>();
  const uniqSources = sources.filter((s) => { const k = `${s.label}|${s.href ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { sections, sources: uniqSources, missing: [...new Set(missing)] };
}

export function buildModel(blocks: Block[], o: { title: string; leadText?: string | null; brand?: Brand | null; generatedAt: string }): ExportModel {
  const { sections, sources, missing } = toSections(blocks, o.leadText);
  return { title: o.title, subtitle: `Prepared ${o.generatedAt.slice(0, 10)} from an assistant answer — check sources before sharing`, brand: o.brand ?? DEFAULT_BRAND, sections, sources, missing };
}

const srcLine = (s: SourceRef) => `${s.label}${s.observedAt ? ` (${String(s.observedAt).slice(0, 10)})` : " (date unknown)"} [${s.status ?? "unknown"}]${s.href ? ` ${s.href}` : ""}`;
/** Appendix is always present so the reader sees provenance and gaps even when empty. */
function appendix(m: ExportModel): Section[] {
  return [
    { heading: "Appendix — Sources", paragraphs: m.sources.length ? [] : ["No sources were attached to this answer."], bullets: m.sources.map(srcLine) },
    { heading: "Appendix — Missing information & assumptions", paragraphs: m.missing.length ? [] : ["None recorded."], bullets: m.missing },
  ];
}
const chunk = <T,>(a: T[], n: number) => { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out.length ? out : [[]]; };

// ------------------------------------------------------------------------------------------------ PPTX
export async function buildPptx(m: ExportModel): Promise<Buffer> {
  const { default: Pptx } = await import("pptxgenjs");
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; p.author = m.brand.name; p.company = m.brand.name; p.title = m.title;
  const font = m.brand.font; const hfont = m.brand.headingFont ?? font;
  const logo = m.brand.logo ? [{ image: { x: 11.9, y: 0.42, w: Math.min(1.2, 0.5 * (m.brand.logo.width / Math.max(1, m.brand.logo.height))), h: 0.5, data: `image/${m.brand.logo.type === "jpg" ? "jpeg" : m.brand.logo.type};base64,${m.brand.logo.data}` } }] : [];
  p.defineSlideMaster({ title: "BRAND", background: { color: "FFFFFF" }, objects: [
    { rect: { x: 0, y: 0, w: "100%", h: 0.3, fill: { color: m.brand.primary } } }, ...logo,
    { text: { text: `${m.brand.name} · ${m.title}`, options: { x: 0.4, y: 7.05, w: 12.5, h: 0.3, fontSize: 8, color: "666666", fontFace: font } } },
  ] });
  const t = p.addSlide({ masterName: "BRAND" });
  t.addText(m.title, { x: 0.6, y: 2.4, w: 12, h: 1.2, fontSize: 34, bold: true, color: m.brand.primary, fontFace: hfont });
  t.addText(m.subtitle, { x: 0.6, y: 3.7, w: 12, h: 0.5, fontSize: 14, color: "444444", fontFace: font });
  if (m.brand.disclaimer) t.addText(m.brand.disclaimer, { x: 0.6, y: 6.3, w: 12, h: 0.5, fontSize: 10, italic: true, color: m.brand.accent, fontFace: font });
  for (const s of [...m.sections, ...appendix(m)]) {
    const head = (sl: ReturnType<typeof p.addSlide>, h: string) => sl.addText(h, { x: 0.4, y: 0.45, w: 11.3, h: 0.7, fontSize: 24, bold: true, color: m.brand.primary, fontFace: hfont });
    if (s.table) {
      const pages = chunk(s.table.rows, 10);
      pages.forEach((rows, i) => {
        const sl = p.addSlide({ masterName: "BRAND" });
        head(sl, pages.length > 1 ? `${s.heading} (${i + 1}/${pages.length})` : s.heading);
        const hdr = s.table!.columns.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: m.brand.primary } } }));
        sl.addTable([hdr, ...rows.map((r) => r.map((v) => ({ text: v.slice(0, 220) })))], { x: 0.4, y: 1.3, w: 12.5, fontSize: 10, fontFace: font, border: { type: "solid", pt: 0.5, color: "CCCCCC" }, autoPage: false });
        if (s.note && i === pages.length - 1) sl.addText(s.note, { x: 0.4, y: 6.55, w: 12.5, h: 0.4, fontSize: 9, italic: true, color: "555555", fontFace: font });
      });
      if (!s.paragraphs.length && !s.bullets.length) continue;
    }
    const lines = [...s.paragraphs.map((x) => ({ text: x, bullet: false })), ...s.bullets.map((x) => ({ text: x, bullet: true }))];
    for (const [i, part] of chunk(lines, 9).entries()) {
      const sl = p.addSlide({ masterName: "BRAND" });
      head(sl, i ? `${s.heading} (cont.)` : s.heading);
      sl.addText(part.map((l) => ({ text: l.text.slice(0, 400), options: { bullet: l.bullet, breakLine: true } })), { x: 0.5, y: 1.3, w: 12.3, h: 5.5, fontSize: 14, color: "222222", fontFace: font, valign: "top" });
    }
  }
  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}

// ------------------------------------------------------------------------------------------------ DOCX
export async function buildDocx(m: ExportModel): Promise<Buffer> {
  const { Document, Footer, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const font = m.brand.font;
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, color: m.brand.primary, font })] }),
    new Paragraph({ children: [new TextRun({ text: m.subtitle, italics: true, color: "555555", font })] }),
  ];
  if (m.brand.disclaimer) children.push(new Paragraph({ children: [new TextRun({ text: m.brand.disclaimer, italics: true, color: m.brand.accent, font, size: 18 })] }));
  for (const s of [...m.sections, ...appendix(m)]) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240 }, children: [new TextRun({ text: s.heading, color: m.brand.primary, font })] }));
    for (const x of s.paragraphs) children.push(new Paragraph({ children: [new TextRun({ text: x, font })] }));
    for (const x of s.bullets) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: x, font })] }));
    if (s.table) {
      const row = (vals: string[], header = false) => new TableRow({ tableHeader: header, children: vals.map((v) => new TableCell({ shading: header ? { fill: m.brand.primary } : undefined, children: [new Paragraph({ children: [new TextRun({ text: v, bold: header, color: header ? "FFFFFF" : undefined, font, size: 18 })] })] })) });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(s.table.columns, true), ...s.table.rows.map((r) => row(r))] }));
      if (s.note) children.push(new Paragraph({ children: [new TextRun({ text: s.note, italics: true, size: 16, color: "555555", font })] }));
    }
  }
  const doc = new Document({ creator: m.brand.name, title: m.title, sections: [{ footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: `${m.brand.name} · ${m.title}`, size: 16, color: "777777", font })] })] }) }, children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ------------------------------------------------------------------------------------------------ PDF
/** Standard PDF fonts are WinAnsi-only: transliterate what we can, replace the rest. */
export function pdfSafe(s: string): string {
  return s.replace(/₹/g, "Rs ").replace(/[‐-‒]/g, "-").replace(/[✓✔]/g, "x").replace(/[   ]/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ–—‘’“”•…€]/g, "?");
}
const rgbHex = (h: string) => [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255] as const;

export async function buildPdf(m: ExportModel): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(m.title)); pdf.setAuthor(pdfSafe(m.brand.name)); pdf.setCreator("CRE OS assistant");
  const reg = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [pr, pg, pb] = rgbHex(m.brand.primary); const brand = rgb(pr, pg, pb);
  const W = 595.28, H = 841.89, M = 48, maxW = W - 2 * M;
  let page = pdf.addPage([W, H]); let y = H - M;
  const footer = () => { page.drawRectangle({ x: 0, y: H - 10, width: W, height: 10, color: brand }); page.drawText(pdfSafe(`${m.brand.name} · ${m.title}`).slice(0, 110), { x: M, y: 24, size: 7, font: reg, color: rgb(0.45, 0.45, 0.45) }); };
  footer();
  const need = (h: number) => { if (y - h < 50) { page = pdf.addPage([W, H]); footer(); y = H - M; } };
  const wrap = (text: string, f: typeof reg, size: number, width: number) => {
    const out: string[] = []; let cur = "";
    for (const w of pdfSafe(text).split(/\s+/)) {
      let word = w;
      while (f.widthOfTextAtSize(word, size) > width && word.length > 1) { // hard-break very long tokens (urls)
        let k = word.length; while (k > 1 && f.widthOfTextAtSize(word.slice(0, k), size) > width) k--;
        if (cur) { out.push(cur); cur = ""; } out.push(word.slice(0, k)); word = word.slice(k);
      }
      const nxt = cur ? `${cur} ${word}` : word;
      if (f.widthOfTextAtSize(nxt, size) > width && cur) { out.push(cur); cur = word; } else cur = nxt;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const text = (s: string, o: { size?: number; f?: typeof reg; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) => {
    const size = o.size ?? 10; const f = o.f ?? reg; const ind = o.indent ?? 0;
    for (const line of wrap(s, f, size, maxW - ind)) { need(size + 4); page.drawText(line, { x: M + ind, y: y - size, size, font: f, color: o.color ?? rgb(0.13, 0.13, 0.13) }); y -= size + 4; }
    y -= o.gap ?? 2;
  };
  text(m.title, { size: 22, f: bold, color: brand, gap: 4 });
  text(m.subtitle, { size: 10, color: rgb(0.35, 0.35, 0.35), gap: 6 });
  if (m.brand.disclaimer) text(m.brand.disclaimer, { size: 9, gap: 6 });
  for (const s of [...m.sections, ...appendix(m)]) {
    y -= 8; need(40);
    text(s.heading, { size: 14, f: bold, color: brand, gap: 4 });
    for (const p of s.paragraphs) text(p, { gap: 4 });
    for (const b of s.bullets) text(`•  ${b}`, { indent: 8 });
    if (s.table) {
      const cols = s.table.columns.length; const cw = maxW / Math.max(1, cols); const size = cols > 5 ? 7 : 8;
      const drawRow = (vals: string[], header: boolean) => {
        const cells = vals.map((v) => wrap(v, header ? bold : reg, size, cw - 6).slice(0, 8));
        const h = Math.max(...cells.map((c) => c.length)) * (size + 3) + 6;
        need(h);
        if (header) page.drawRectangle({ x: M, y: y - h, width: maxW, height: h, color: brand });
        else page.drawLine({ start: { x: M, y: y - h }, end: { x: M + maxW, y: y - h }, thickness: 0.4, color: rgb(0.8, 0.8, 0.8) });
        cells.forEach((lines, ci) => lines.forEach((ln, li) => page.drawText(ln, { x: M + ci * cw + 3, y: y - 3 - (li + 1) * (size + 3) + 3, size, font: header ? bold : reg, color: header ? rgb(1, 1, 1) : rgb(0.13, 0.13, 0.13) })));
        y -= h;
      };
      drawRow(s.table.columns, true);
      for (const r of s.table.rows) drawRow(r, false);
      y -= 4;
      if (s.note) text(s.note, { size: 8, color: rgb(0.35, 0.35, 0.35) });
    }
  }
  return Buffer.from(await pdf.save());
}

export async function render(format: ExportFormat, m: ExportModel): Promise<Buffer> {
  return format === "pptx" ? buildPptx(m) : format === "docx" ? buildDocx(m) : buildPdf(m);
}
export const MIME: Record<ExportFormat, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};
/** "Acme shortlist" + 2026-11-11 -> "acme-shortlist-2026-11-11.pptx" */
export function exportFileName(title: string | null | undefined, date: string, format: ExportFormat) {
  const slug = (title ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "assistant-answer";
  return `${slug}-${date.slice(0, 10)}.${format}`;
}

/**
 * Editable shortlist deck (native text boxes, tables and native PowerPoint charts — no images of text). Brand comes
 * from the tenant template (brand_json, plus theme colours / fonts / logo extracted from an uploaded master).
 * The location map is a schematic drawn with shapes from stored coordinates (no map tiles, no network).
 */
import PptxGenJS from "pptxgenjs";
import type { DocModel } from "./model";
import { chartSpecs, fitBox } from "./visuals";

const inr = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export async function buildShortlistPptx(m: DocModel): Promise<Buffer> {
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";
  p.author = m.brand.name;
  p.company = m.brand.name;
  p.title = m.title;
  const font = m.brand.font;
  const hfont = m.brand.headingFont ?? font;
  const logo = m.brand.logo ? [{ image: { x: 11.9, y: 0.42, w: Math.min(1.2, 0.5 * (m.brand.logo.width / Math.max(1, m.brand.logo.height))), h: 0.5, data: `image/${m.brand.logo.type === "jpg" ? "jpeg" : m.brand.logo.type};base64,${m.brand.logo.data}` } }] : [];
  p.defineSlideMaster({
    title: "BRAND",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: "100%", h: 0.35, fill: { color: m.brand.primary } } },
      ...logo,
      { text: { text: m.watermark, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: m.brand.accent, fontFace: font, italic: true } } },
      { text: { text: `${m.brand.name} · ${m.template.name} v${m.template.version ?? 0}${m.version ? ` · deck v${m.version.no}` : ""} · generated ${m.generatedAt.slice(0, 10)}`, options: { x: 8.4, y: 7.05, w: 4.6, h: 0.3, fontSize: 8, color: "666666", fontFace: font, align: "right" } } },
    ],
  });
  const slide = () => p.addSlide({ masterName: "BRAND" });
  const h1 = (s: PptxGenJS.Slide, t: string) => s.addText(t, { x: 0.4, y: 0.5, w: 11.3, h: 0.7, fontSize: 26, bold: true, color: m.brand.primary, fontFace: hfont });

  // title
  const t = slide();
  t.addText(m.title, { x: 0.6, y: 2.2, w: 12, h: 1.2, fontSize: 36, bold: true, color: m.brand.primary, fontFace: hfont });
  t.addText(`Prepared for ${m.clientName}`, { x: 0.6, y: 3.5, w: 12, h: 0.6, fontSize: 18, color: "333333", fontFace: font });

  // requirement
  if (m.requirement) {
    const s = slide();
    h1(s, `Requirement — ${m.requirement.status === "client_confirmed" ? "client confirmed" : "provisional (not yet client confirmed)"}`);
    s.addTable(m.requirement.lines.map(([k, v]) => [{ text: k, options: { bold: true } }, { text: v }]), { x: 0.4, y: 1.4, w: 12.5, fontSize: 12, fontFace: font, border: { type: "solid", color: "DDDDDD", pt: 0.5 }, colW: [3.5, 9] });
    if (m.requirement.missing.length) s.addText(`Open questions: ${m.requirement.missing.slice(0, 6).join("; ")}`, { x: 0.4, y: 6.3, w: 12.5, h: 0.6, fontSize: 11, color: m.brand.accent, fontFace: font });
  }

  // options table
  const opts = m.options.filter((o) => o.eligibility !== "ineligible");
  const s2 = slide();
  h1(s2, "Shortlist");
  if (!opts.length) s2.addText("No eligible or verifiable options in this run.", { x: 0.4, y: 1.5, w: 12, h: 0.5, fontSize: 14, fontFace: font });
  else s2.addTable([
    ["#", "Option", "Status", "Fit", "Data", "Area", "All-in cost", "Availability"].map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: m.brand.primary } } })),
    ...opts.slice(0, 12).map((o) => [String(o.rank), o.label, o.eligibility === "eligible" ? "Eligible" : "Needs verification", o.fitScore === null ? "—" : String(o.fitScore), o.completenessScore === null ? "—" : `${o.completenessScore}%`, o.area, o.cost, o.availability].map((x) => ({ text: x }))),
  ], { x: 0.4, y: 1.4, w: 12.5, fontSize: 10, fontFace: font, border: { type: "solid", color: "DDDDDD", pt: 0.5 }, colW: [0.4, 3.2, 1.6, 0.7, 0.8, 1.6, 1.8, 2.4] });

  // one slide per option (top 8)
  for (const o of opts.slice(0, 8)) {
    const s = slide();
    h1(s, `${o.rank}. ${o.label}`);
    const lines = [
      `Status: ${o.eligibility === "eligible" ? "eligible" : "needs verification"} · fit ${o.fitScore ?? "—"} · data completeness ${o.completenessScore ?? "—"}%`,
      `Area (space snapshot): ${o.area}`, `All-in cost: ${o.cost}`, `Availability: ${o.availability}`,
      ...o.flags.map((f) => `⚠ ${f}`), ...o.verification.map((v) => `To verify: ${v}`),
    ];
    s.addText(lines.map((l) => ({ text: l, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.4, w: 12.3, h: 5.2, fontSize: 14, fontFace: font, valign: "top" });
  }

  // finance
  if (m.comparison.length) {
    const s = slide();
    h1(s, "Financial comparison (equal horizon)");
    s.addTable([
      ["Scenario", "NPV", "Nominal TCO", "Equivalent monthly", "₹/chargeable SF/mo", "Rank"].map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: m.brand.primary } } })),
      ...m.comparison.map((c) => [c.name, inr(c.npv), inr(c.nominalTco), inr(c.equivalentMonthly), inr(c.perChargeableSfMonth), String(c.rank)].map((x) => ({ text: x }))),
    ], { x: 0.4, y: 1.4, w: 12.5, fontSize: 11, fontFace: font, border: { type: "solid", color: "DDDDDD", pt: 0.5 } });
  }

  // native charts (editable: right-click → Edit Data in PowerPoint)
  for (const c of chartSpecs(m)) {
    const s = slide();
    h1(s, c.title);
    s.addChart(p.ChartType.bar, c.series.map((x) => ({ name: x.name, labels: c.categories, values: x.values })), {
      x: 0.5, y: 1.3, w: 12.3, h: 5.0, barDir: "col", barGrouping: "clustered", chartColors: [m.brand.primary, m.brand.accent, "7F8C8D"],
      showLegend: c.series.length > 1, legendPos: "b", valAxisTitle: c.unit, showValAxisTitle: true, valAxisLabelFormatCode: "#,##0", valAxisMinVal: 0,
      catAxisLabelFontFace: font, valAxisLabelFontFace: font, legendFontFace: font, catAxisLabelFontSize: 10,
    });
    if (c.notes.length) s.addText(c.notes.join(" "), { x: 0.5, y: 6.4, w: 12.3, h: 0.5, fontSize: 10, italic: true, color: "555555", fontFace: font });
  }

  // schematic location map (shapes) or a clear note when coordinates are missing
  {
    const s = slide();
    h1(s, "Location map (schematic)");
    if (!m.map) s.addText("No map: none of the options or preferred areas has stored coordinates. Add latitude/longitude to the buildings or micro-markets to plot them.", { x: 0.5, y: 1.5, w: 12, h: 1, fontSize: 14, fontFace: font, color: "555555" });
    else {
      const box = fitBox(m.map.aspect, { x: 0.6, y: 1.3, w: 12.1, h: 4.9 });
      s.addShape(p.ShapeType.rect, { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: "F4F6F8" }, line: { color: "BBBBBB", width: 0.75 } });
      for (const pt of m.map.points) {
        const cx = box.x + pt.x * box.w, cy = box.y + pt.y * box.h, r = pt.kind === "option" ? 0.11 : 0.08;
        s.addShape(pt.kind === "option" ? p.ShapeType.ellipse : p.ShapeType.diamond, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: pt.kind === "option" ? m.brand.primary : m.brand.accent }, line: { color: "FFFFFF", width: 0.5 } });
        // option labels to the right, preferred-area labels below, so co-located points stay readable
        s.addText(pt.label, pt.kind === "option" ? { x: cx + r + 0.03, y: cy - 0.15, w: 2.6, h: 0.3, fontSize: 9, fontFace: font, color: "222222" }
          : { x: cx - 0.6, y: cy + r, w: 2.4, h: 0.28, fontSize: 8, italic: true, fontFace: font, color: m.brand.accent });
      }
      // scale bar + north arrow
      const sw = m.map.scaleFraction * box.w, sx = box.x + 0.2, sy = box.y + box.h - 0.25;
      s.addShape(p.ShapeType.line, { x: sx, y: sy, w: sw, h: 0, line: { color: "222222", width: 2 } });
      s.addText(`${m.map.scaleKm} km`, { x: sx, y: sy - 0.32, w: Math.max(sw, 0.8), h: 0.28, fontSize: 9, fontFace: font });
      s.addText("N ↑", { x: box.x + box.w - 0.6, y: box.y + 0.05, w: 0.5, h: 0.3, fontSize: 10, bold: true, fontFace: font });
      s.addText(`● option   ◆ preferred area. ${m.map.note}`, { x: 0.6, y: 6.3, w: 12.1, h: 0.6, fontSize: 9, italic: true, color: "555555", fontFace: font });
    }
  }

  // assumptions + freshness
  const a = slide();
  h1(a, "Assumptions, sources and data freshness");
  a.addText([...m.assumptions, ...m.freshness, ...(m.brand.disclaimer ? [m.brand.disclaimer] : [])].map((l) => ({ text: l, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y: 1.4, w: 12.3, h: 5.4, fontSize: 12, fontFace: font, valign: "top" });

  // source data + calculation versions (traceability)
  const sv = slide();
  h1(sv, "Sources and calculation versions");
  sv.addText([...(m.sources ?? []), ...(m.templateCarryOver ?? [])].map((l) => ({ text: l, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y: 1.4, w: 12.3, h: 5.4, fontSize: 10, fontFace: font, valign: "top" });

  const out = await p.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

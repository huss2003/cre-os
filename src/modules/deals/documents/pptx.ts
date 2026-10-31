/** Editable shortlist deck (native text boxes and tables — no images of text). Brand comes from the tenant template. */
import PptxGenJS from "pptxgenjs";
import type { DocModel } from "./model";

const inr = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);

export async function buildShortlistPptx(m: DocModel): Promise<Buffer> {
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";
  p.author = m.brand.name;
  p.company = m.brand.name;
  p.title = m.title;
  const font = m.brand.font;
  p.defineSlideMaster({
    title: "BRAND",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: "100%", h: 0.35, fill: { color: m.brand.primary } } },
      { text: { text: m.watermark, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: m.brand.accent, fontFace: font, italic: true } } },
      { text: { text: `${m.brand.name} · ${m.template.name} v${m.template.version ?? 0} · generated ${m.generatedAt.slice(0, 10)}`, options: { x: 8.4, y: 7.05, w: 4.6, h: 0.3, fontSize: 8, color: "666666", fontFace: font, align: "right" } } },
    ],
  });
  const slide = () => p.addSlide({ masterName: "BRAND" });
  const h1 = (s: PptxGenJS.Slide, t: string) => s.addText(t, { x: 0.4, y: 0.5, w: 12.5, h: 0.7, fontSize: 26, bold: true, color: m.brand.primary, fontFace: font });

  // title
  const t = slide();
  t.addText(m.title, { x: 0.6, y: 2.2, w: 12, h: 1.2, fontSize: 36, bold: true, color: m.brand.primary, fontFace: font });
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

  // assumptions + freshness
  const a = slide();
  h1(a, "Assumptions, sources and data freshness");
  a.addText([...m.assumptions, ...m.freshness, ...(m.brand.disclaimer ? [m.brand.disclaimer] : [])].map((l) => ({ text: l, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y: 1.4, w: 12.3, h: 5.4, fontSize: 12, fontFace: font, valign: "top" });

  const out = await p.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

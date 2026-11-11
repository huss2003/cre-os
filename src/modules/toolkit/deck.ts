/**
 * Module 8 §8.10 — presentation deck from ANY saved toolkit analysis (editable PPTX, pptxgenjs).
 * Slides: title · executive recommendation · options table · cost charts (NATIVE pptx charts built from the stored,
 * deterministically computed numbers — nothing recomputed here, S5) · assumptions · missing information · sources ·
 * appendix (every input/output line, labelled). Brand: the tenant's pptx template_asset (deck purpose preferred) or the
 * workspace name on a neutral layout. Each generation is stored as a new document_version (purpose "analysis_deck",
 * linked to the analysis; requirement + analysis version recorded in input_versions) and can be downloaded again.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@/lib/supabase/server";
import { brandFrom, type Brand } from "@/modules/deals/documents/model";
import { BUCKET } from "@/modules/deals/documents/service";
import { analysisFlags, flatten, KIND_LABEL, type Line } from "./deliverables";
import { getAnalysis, getVersion } from "./store";

export const DECK_FORMULA = "deck-1.0";
export const DECK_PURPOSE = "analysis_deck";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
type Row = Record<string, any>;

export interface DeckChart { title: string; type: "bar" | "line"; labels: string[]; series: { name: string; values: number[] }[]; unit: string; note?: string }
export interface DeckTable { title: string; head: string[]; rows: string[][] }
export interface DeckModel {
  title: string; subtitle: string; kind: string; kindLabel: string; brand: Brand; generatedAt: string;
  formula: string; version: number; flags: string[];
  recommendation: string[]; tables: DeckTable[]; charts: DeckChart[];
  assumptions: string[]; missing: string[]; sources: string[]; appendix: Line[];
}

// ───────────── shape-tolerant extraction (copies stored values; Number() only to feed the chart) ─────────────
const v = (x: unknown): string => (x === null || x === undefined || x === "" ? "Unknown" : typeof x === "number" ? x.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(x));
const rs = (x: unknown) => (x === null || x === undefined || x === "" ? "Unknown" : `₹${Number(x).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const isNum = (x: unknown) => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x));
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map((y) => (typeof y === "string" ? y : y?.label ?? y?.text ?? JSON.stringify(y))) : []);

/** Bar/line chart from (label, value) pairs; unknown values are left out and named in the note (never plotted as 0). */
export function chartOf(title: string, unit: string, pairs: [string, unknown][], seriesName = title, type: "bar" | "line" = "bar"): DeckChart | null {
  const ok = pairs.filter(([, x]) => isNum(x));
  if (!ok.length) return null;
  const skipped = pairs.filter(([, x]) => !isNum(x)).map(([l]) => l);
  return { title, type, unit, labels: ok.map(([l]) => l), series: [{ name: seriesName, values: ok.map(([, x]) => Number(x)) }], note: skipped.length ? `Not charted (unknown): ${skipped.join(", ")}` : undefined };
}
function multiLine(title: string, unit: string, series: [string, unknown[] | null | undefined][], step = 1): DeckChart | null {
  const ss = series.filter(([, a]) => Array.isArray(a) && a.length && a.every(isNum)) as [string, unknown[]][];
  if (!ss.length) return null;
  const n = Math.min(...ss.map(([, a]) => a.length));
  const idx = Array.from({ length: n }, (_, k) => k).filter((k) => (k + 1) % step === 0 || k === n - 1);
  return { title, type: "line", unit, labels: idx.map((k) => String(k + 1)), series: ss.map(([name, a]) => ({ name, values: idx.map((k) => Number(a[k])) })) };
}

export function extract(kind: string, out: Row, inp: Row): Pick<DeckModel, "recommendation" | "tables" | "charts" | "assumptions"> {
  const charts: (DeckChart | null)[] = []; const tables: DeckTable[] = []; let rec: string[] = []; let asm: string[] = strs(out.assumptions);
  switch (kind) {
    case "property_comparison": {
      const ps = ((out.properties ?? []) as Row[]).slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      tables.push({ title: "Options", head: ["Rank", "Property", "Score", "Occupancy cost", "Eligibility", "Evidence"], rows: ps.map((p) => [v(p.rank), v(p.name), v(p.score), rs(p.occupancyCost), v(p.eligibility), v(p.evidence)]) });
      charts.push(chartOf("Weighted score", "points", ps.map((p) => [String(p.name), p.score])), chartOf("Occupancy cost over the term", "₹", ps.map((p) => [String(p.name), p.occupancyCost])));
      const rq = (inp.requirement ?? {}) as Row;
      if (Object.keys(rq).length) tables.unshift({ title: "Your requirement — summary", head: ["Item", "Value"], rows: [
        ["Requirement", v(rq.title)], ["Area (SF)", `${v(rq.areaMinSf)} – ${v(rq.areaMaxSf)} (target ${v(rq.areaTargetSf)}) ${rq.areaBasis ?? ""}`.trim()],
        ["Preferred micro-markets", Array.isArray(rq.microMarkets) && rq.microMarkets.length ? rq.microMarkets.join(", ") : "Unknown"],
        ["Rent budget ₹/SF/month", rq.budgetMax != null ? `${v(rq.budgetMax)} (client-confirmed)` : rq.budgetEstimate != null ? `${v(rq.budgetEstimate)} (estimated — unconfirmed, not used to exclude)` : "Not set"],
        ["Term (months)", v(rq.termMonths)]] });
      const pc = ps.map((p) => [v(p.name), [...strs(p.advantages)].join("; ") || "None recorded", [...strs(p.disadvantages), ...strs(p.limitations)].join("; ") || "None recorded"]);
      tables.push({ title: "Advantages and shortcomings", head: ["Property", "Advantages", "Shortcomings / disadvantages"], rows: pc });
      const fb = (out.siteVisitFeedback ?? []) as Row[];
      if (fb.length) tables.push({ title: "Site-visit feedback (context only — never excludes)", head: ["Property", "Visit", "Interest", "Comments", "Concerns"], rows: fb.map((f) => [v(f.name), `${v(f.meeting)} ${f.date ?? ""}`.trim(), v(f.interest), strs(f.comments).join("; ") || "—", strs(f.concerns).join("; ") || "—"]) });
      if (out.recommendation?.explanation) rec = [`Recommended: ${String(out.recommendation.explanation)}`];
      break;
    }
    case "lease_economics": {
      const offers: Row[] = out.mode === "compare" ? out.comparison?.offers ?? [] : out.result ? [out.result] : [];
      tables.push({ title: "Options", head: ["Option", "Label", "Month-1 rent", "Total rent", "Contractual spend", "NPV", "Deposit (refundable)"], rows: offers.map((r) => [v(r.name), v(r.label), rs(r.monthly?.baseRent), rs(r.totals?.rent), rs(r.totals?.contractualExpenditure), rs(r.totals?.npv), rs(r.deposit?.amount)]) });
      charts.push(chartOf("Total contractual spend", "₹", offers.map((r) => [String(r.name), r.totals?.contractualExpenditure])), chartOf("NPV of occupancy cost", "₹", offers.map((r) => [String(r.name), r.totals?.npv])));
      const top = ((out.comparison?.rows ?? []) as Row[]).find((r) => r.rank === 1);
      rec = top ? [`${top.name} has the lowest NPV over the equal horizon (₹${v(top.npv)}).`] : offers.map((r) => String(r.totalsLabel ?? "")).filter(Boolean);
      for (const r of offers) asm.push(...strs(r.warnings));
      break;
    }
    case "occupancy": {
      const r = out.result ?? {};
      tables.push({ title: `Occupancy cost — ${v(r.name)}`, head: ["Measure", "Value"], rows: [["Nominal rent ₹/SF/mo", v(r.nominalRentPerSf)], ["Effective rent ₹/SF/mo", v(r.effectiveRentPerSf)], ["PV-equivalent rent ₹/SF/mo", v(r.pvEffectiveRentPerSf)], ["Up-front cash", rs(r.cashFundingTotal)], ["Present value", rs(r.presentValue)], ["Nominal total", rs(r.nominalTotal)], ["Peak cash requirement", rs(r.peakCashRequirement)]] });
      charts.push(chartOf("Rent per SF per month", "₹/SF/mo", [["Nominal", r.nominalRentPerSf], ["Effective", r.effectiveRentPerSf], ["PV-equivalent", r.pvEffectiveRentPerSf]]), chartOf("Up-front cash", "₹", ((r.cashFunding ?? []) as Row[]).map((c) => [String(c.label), c.amount])));
      rec = [r.totalsLabel].filter(Boolean).map(String); asm.push(...strs(r.warnings));
      break;
    }
    case "conventional_vs_managed": {
      const sides: [string, Row | null][] = [["Conventional", out.conventional], ["Managed", out.managed]];
      tables.push({ title: "Options", head: ["Measure", "Conventional", "Managed"], rows: ([["Month-1 monthly", "month1Monthly"], ["Effective monthly", "effectiveMonthly"], ["Total commitment", "totalCommitment"], ["Cost per seat", "costPerSeat"], ["Initial cash (excl. deposit)", "initialCashExDeposit"], ["Refundable deposit", "refundableDeposit"], ["Fit-out investment", "fitoutInvestment"]] as [string, string][]).map(([l, k]) => [l, rs(out.conventional?.[k]), rs(out.managed?.[k])]) });
      charts.push(chartOf("Total commitment", "₹", sides.map(([n, s]) => [n, s?.totalCommitment])), multiLine("Cumulative cost by month", "₹", sides.map(([n, s]) => [n, s?.cumulative]), 3));
      rec = [out.recommendation?.text, ...strs(out.recommendation?.reasons)].filter(Boolean).map(String); asm.push(...strs(out.warnings));
      break;
    }
    case "renewal_vs_relocation": {
      const sides: [string, Row | null][] = [["Renewal", out.renewal], ["Relocation", out.relocation]];
      tables.push({ title: "Options", head: ["Measure", "Renewal", "Relocation"], rows: ([["Total cost", "total"], ["Present value", "pv"], ["Annual average", "annualAverage"], ["Initial cash (incl. deposit)", "initialCashInclDeposit"], ["Net deposit (refundable)", "depositNet"]] as [string, string][]).map(([l, k]) => [l, rs(out.renewal?.[k]), rs(out.relocation?.[k])]) });
      charts.push(chartOf("Total cost over the period", "₹", sides.map(([n, s]) => [n, s?.total])), multiLine("Cumulative cost by month", "₹", sides.map(([n, s]) => [n, s?.cumulative]), 3));
      rec = [out.verdict, out.breakEven?.text].filter(Boolean).map(String);
      break;
    }
    case "fitout": {
      const b = out.budget ?? out;
      tables.push({ title: "Fit-out budget (gross incl. tax)", head: ["Category", "Estimated", "Approved", "Actual"], rows: [...((b.byCategory ?? []) as Row[]).map((c) => [v(c.label), rs(c.estimated?.gross), rs(c.approved?.gross), rs(c.actual?.gross)]), ["Total", rs(b.totals?.estimated?.gross), rs(b.totals?.approved?.gross), rs(b.totals?.actual?.gross)]] });
      charts.push(chartOf("Estimated cost by category", "₹", ((b.byCategory ?? []) as Row[]).map((c) => [String(c.label), c.estimated?.gross])));
      const q = out.quotes as Row | undefined;
      if (q?.rows?.length) tables.push({ title: "Partner quotes", head: ["Partner", "Score", "Total incl. tax"], rows: (q.rows as Row[]).map((r) => [v(r.partner ?? r.name), v(r.score), rs(r.totalInclTax ?? r.total)]) });
      rec = q?.preferred?.reason ? [String(q.preferred.reason)] : [];
      break;
    }
    case "financing": {
      tables.push({ title: "Loan", head: ["Measure", "Value"], rows: [["Financed amount", rs(out.financed)], ["Monthly EMI", rs(out.emi)], ["Total interest", rs(out.totals?.interest)], ["Fees", rs(out.totals?.fee)], ["Total cost of financing", rs(out.totals?.costOfFinancing)], ["Effective annual rate", out.effectiveAnnualRatePct ? `${out.effectiveAnnualRatePct}%` : "Unknown"]] });
      const sch = (out.schedule ?? []) as Row[];
      charts.push(chartOf("Outstanding balance (every 6th month)", "₹", sch.filter((s, k) => (k + 1) % 6 === 0 || k === sch.length - 1).map((s) => [`M${s.month}`, s.closing]), "Closing balance", "line"));
      break;
    }
    case "negotiation": {
      const offers = (out.offers ?? []) as Row[];
      tables.push({ title: "Offer versions", head: ["#", "Offer", "NPV", "Nominal total", "Deposit", "Complete"], rows: offers.map((o) => [v(o.no), v(o.label), rs(o.npv), rs(o.nominalTotal), rs(o.depositAmount), o.complete ? "Yes" : "No"]) });
      charts.push(chartOf("NPV by offer version", "₹", offers.map((o) => [String(o.label ?? o.no), o.npv])));
      rec = [out.strategy?.preferredOutcome, out.strategy?.acceptableAlternative && `Acceptable alternative: ${out.strategy.acceptableAlternative}`].filter(Boolean).map(String);
      asm.push(...strs(out.warnings), ...strs(out.strategy?.risks).map((r) => `Risk: ${r}`));
      break;
    }
    case "brief": {
      for (const s of (out.sections ?? []) as Row[]) tables.push({ title: String(s.title ?? "Section"), head: ["Item", "Value", "Status"], rows: ((s.fields ?? []) as Row[]).map((f) => [v(f.label ?? f.key), f.value == null ? "Missing" : v(f.value), v(f.status)]) });
      rec = [`Requirement brief for ${v(out.title)}${out.organisation ? ` (${out.organisation})` : ""}.`];
      break;
    }
    case "bts": {
      const pc = out.projectCost ?? {};
      tables.push({ title: "Built-to-suit economics", head: ["Measure", "Value"], rows: [["Total project cost", rs(pc.total)], ["Cost per SF", rs(pc.perSf)], ["Required rent ₹/SF/month", v(out.rent?.requiredRentPerSfMonth)], ["Yield on cost", out.rent?.impliedYieldPct ? `${out.rent.impliedYieldPct}%` : "Unknown"], ["Tenant cost (nominal)", rs(out.tenant?.nominal)], ["Tenant cost (NPV)", rs(out.tenant?.npv)], ["Refundable deposit (separate)", rs(out.tenant?.deposit)]] });
      if (out.comparison) tables.push({ title: `BTS vs ${out.comparison.name}`, head: ["Measure", "BTS", out.comparison.name], rows: [["Nominal", rs(out.tenant?.nominal), rs(out.comparison.alternative?.nominal)], ["NPV", rs(out.tenant?.npv), rs(out.comparison.alternative?.npv)], ["Deposit", rs(out.tenant?.deposit), rs(out.comparison.alternative?.deposit)]] });
      charts.push(chartOf("Project cost breakdown", "₹", [["Land", pc.land], ["Construction", pc.hard], ["Soft costs", pc.soft], ["Interest", pc.interest]]), chartOf("Rent paid by lease year", "₹", ((out.schedule ?? []) as Row[]).map((y) => [`Year ${y.year}`, y.rentPaid])));
      if (out.comparison?.comparable) charts.push(chartOf("Tenant total occupancy cost (NPV)", "₹", [["BTS", out.tenant?.npv], [String(out.comparison.name), out.comparison.alternative?.npv]]));
      rec = [out.comparison ? (out.comparison.comparable ? `Lower cost for the tenant: ${out.comparison.cheaper === "bts" ? "built-to-suit" : out.comparison.cheaper === "alternative" ? out.comparison.name : "equal"}.` : `Not compared: ${out.comparison.reason}`) : null, out.rent?.requiredRentPerSfMonth ? `Required rent ₹${out.rent.requiredRentPerSfMonth}/SF/month (${out.areaBasis ?? "basis not stated"}).` : null].filter(Boolean) as string[];
      break;
    }
    case "investment": {
      tables.push({ title: "Returns", head: ["Measure", "Unlevered", "Levered"], rows: [["IRR", out.unlevered?.irrPct ? `${out.unlevered.irrPct}%` : "Unknown", out.levered ? (out.levered.irrPct ? `${out.levered.irrPct}%` : "Unknown") : "No debt"], ["NPV", rs(out.unlevered?.npv), out.levered ? rs(out.levered.npv) : "—"], ["Equity multiple", v(out.unlevered?.equityMultiple), out.levered ? v(out.levered.equityMultiple) : "—"]] });
      tables.push({ title: "Sensitivities", head: ["Case", "Exit value", "Unlevered IRR", "Levered IRR", "NPV"], rows: ((out.sensitivities ?? []) as Row[]).map((s) => [v(s.label), rs(s.exitValue), s.unleveredIrrPct ? `${s.unleveredIrrPct}%` : "Unknown", s.leveredIrrPct ? `${s.leveredIrrPct}%` : "—", rs(s.npv)]) });
      charts.push(chartOf("NOI by year", "₹", ((out.years ?? []) as Row[]).map((y) => [`Year ${y.year}`, y.noi])), chartOf("Unlevered cash flow by year", "₹", ((out.years ?? []) as Row[]).map((y) => [`Year ${y.year}`, y.unlevered])));
      rec = [out.unlevered?.irrPct ? `Unlevered IRR ${out.unlevered.irrPct}% vs discount rate ${v(inp.discountRatePct)}%; NPV ₹${v(out.unlevered.npv)}.` : "IRR not determined — see missing information.", out.yieldOnCostPct ? `Yield on cost ${out.yieldOnCostPct}%.` : null, out.minDscr ? `Minimum DSCR ${out.minDscr}.` : null].filter(Boolean) as string[];
      break;
    }
  }
  if (!rec.length) for (const k of ["recommended", "recommendation", "recommended_option", "winner"]) if (out[k]) { rec = [typeof out[k] === "string" ? out[k] : v(out[k]?.text ?? out[k]?.explanation ?? JSON.stringify(out[k]))]; break; }
  return { recommendation: rec, tables, charts: charts.filter(Boolean) as DeckChart[], assumptions: [...new Set(asm)] };
}

export function deckModel(a: { kind: string; title: string; status: string; missing: string[]; version: number; formula_version: string | null; inputs: unknown; outputs: unknown; requirementTitle?: string | null; orgName?: string | null; approved_at?: string | null }, brand: Brand, templateNote: string, generatedAt = new Date().toISOString()): DeckModel {
  const out = (a.outputs ?? {}) as Row, inp = (a.inputs ?? {}) as Row;
  const x = extract(a.kind, out, inp);
  const missing = [...new Set([...(a.missing ?? []), ...strs(out.missing)])];
  return {
    title: a.title, subtitle: [KIND_LABEL[a.kind] ?? a.kind, a.requirementTitle, a.orgName].filter(Boolean).join(" · "),
    kind: a.kind, kindLabel: KIND_LABEL[a.kind] ?? a.kind, brand, generatedAt, formula: a.formula_version ?? "unknown", version: a.version,
    flags: analysisFlags({ status: a.status, missing }), ...x, missing,
    assumptions: [...x.assumptions, ...strs(out.method).map((m) => `Method: ${m}`)],
    sources: [`${KIND_LABEL[a.kind] ?? a.kind} "${a.title}" version ${a.version}, formula ${a.formula_version ?? "?"}`, templateNote, `Generated ${generatedAt.slice(0, 10)} with ${DECK_FORMULA}`],
    appendix: [...flatten(a.inputs, "input", null, [], 200), ...flatten(a.outputs, "output", null, [], 300)],
  };
}

// ───────────── PPTX ─────────────
export async function buildAnalysisDeck(m: DeckModel): Promise<Buffer> {
  const { default: Pptx } = await import("pptxgenjs");
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; p.author = m.brand.name; p.company = m.brand.name; p.title = m.title; p.subject = m.kindLabel;
  const font = m.brand.font, hfont = m.brand.headingFont ?? font;
  const watermark = m.flags.length ? "DRAFT — " + m.flags.map((f) => f.split(":")[0]).join(" · ") : "Confidential";
  p.defineSlideMaster({ title: "BRAND", background: { color: "FFFFFF" }, objects: [
    { rect: { x: 0, y: 0, w: "100%", h: 0.3, fill: { color: m.brand.primary } } },
    ...(m.brand.logo ? [{ image: { data: `image/${m.brand.logo.type};base64,${m.brand.logo.data}`, x: 12.1, y: 0.4, w: 0.9, h: 0.9 * (m.brand.logo.height / Math.max(1, m.brand.logo.width)) } }] : []),
    { text: { text: watermark, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: m.brand.accent, fontFace: font, italic: true } } },
    { text: { text: `${m.brand.name} · ${m.formula} v${m.version} · ${m.generatedAt.slice(0, 10)}`, options: { x: 8.4, y: 7.05, w: 4.6, h: 0.3, fontSize: 8, color: "666666", fontFace: font, align: "right" } } },
  ] });
  type S = ReturnType<typeof p.addSlide>;
  const slide = () => p.addSlide({ masterName: "BRAND" });
  const h1 = (s: S, t: string) => s.addText(t, { x: 0.4, y: 0.45, w: 11.5, h: 0.7, fontSize: 24, bold: true, color: m.brand.primary, fontFace: hfont });
  const bullets = (s: S, lines: string[], y = 1.4, h = 5.4, size = 14) => s.addText(lines.map((l) => ({ text: l, options: { bullet: true, breakLine: true } })), { x: 0.5, y, w: 12.3, h, fontSize: size, fontFace: font, valign: "top", fit: "shrink" });
  const hdr = (cols: string[]) => cols.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: m.brand.primary } } }));

  const t = slide();
  t.addText(m.title, { x: 0.6, y: 2.1, w: 12, h: 1.2, fontSize: 34, bold: true, color: m.brand.primary, fontFace: hfont });
  t.addText(m.subtitle, { x: 0.6, y: 3.4, w: 12, h: 0.6, fontSize: 18, color: "333333", fontFace: font });
  t.addText(`Prepared by ${m.brand.name} · ${m.generatedAt.slice(0, 10)}`, { x: 0.6, y: 4.1, w: 12, h: 0.5, fontSize: 12, color: "666666", fontFace: font });
  if (m.flags.length) t.addText(m.flags.join("\n"), { x: 0.6, y: 5.0, w: 12, h: 1, fontSize: 11, color: m.brand.accent, fontFace: font });

  const r = slide(); h1(r, "Executive recommendation");
  bullets(r, m.recommendation.length ? m.recommendation : ["No recommendation could be determined from this analysis — see missing information."], 1.4, 4.2, 16);
  if (m.flags.length) r.addText(m.flags.join("\n"), { x: 0.5, y: 5.8, w: 12.3, h: 1, fontSize: 11, color: m.brand.accent, fontFace: font });

  for (const tb of m.tables) {
    const rows = tb.rows.slice(0, 14);
    const s = slide(); h1(s, tb.title);
    if (!rows.length) { s.addText("No rows.", { x: 0.5, y: 1.5, w: 12, h: 0.5, fontSize: 14, fontFace: font }); continue; }
    s.addTable([hdr(tb.head), ...rows.map((rw) => rw.map((c) => ({ text: c })))], { x: 0.4, y: 1.35, w: 12.5, fontSize: tb.head.length > 5 ? 10 : 12, fontFace: font, border: { type: "solid", color: "DDDDDD", pt: 0.5 }, autoPage: false });
    if (tb.rows.length > rows.length) s.addText(`${tb.rows.length - rows.length} more rows in the appendix / workbook.`, { x: 0.4, y: 6.6, w: 12, h: 0.3, fontSize: 10, italic: true, color: "555555", fontFace: font });
  }

  for (const c of m.charts) {
    const s = slide(); h1(s, c.title);
    const type = c.type === "line" ? p.ChartType.line : p.ChartType.bar;
    s.addChart(type, c.series.map((x) => ({ name: x.name, labels: c.labels, values: x.values })), {
      x: 0.5, y: 1.3, w: 12.3, h: 5.2, barDir: "col", chartColors: [m.brand.primary, m.brand.accent, "7F8C8D", "2E86AB"],
      showLegend: c.series.length > 1, legendPos: "b", showValue: c.type === "bar" && c.labels.length <= 8, dataLabelFormatCode: "#,##0",
      valAxisLabelFormatCode: "#,##0", valAxisTitle: c.unit, showValAxisTitle: true, catAxisLabelFontFace: font, valAxisLabelFontFace: font, lineDataSymbol: "none",
    });
    s.addText(`Values from the saved analysis (${m.formula} v${m.version}).${c.note ? ` ${c.note}.` : ""}`, { x: 0.5, y: 6.6, w: 12.3, h: 0.35, fontSize: 10, italic: true, color: "555555", fontFace: font });
  }

  const as = slide(); h1(as, "Assumptions and method"); bullets(as, m.assumptions.length ? m.assumptions : ["No assumptions recorded."], 1.4, 5.4, 12);
  const mi = slide(); h1(mi, "Missing information"); bullets(mi, m.missing.length ? m.missing : ["None — all required inputs were provided."], 1.4, 5.4, 13);
  const so = slide(); h1(so, "Sources"); bullets(so, [...m.sources, ...(m.brand.disclaimer ? [m.brand.disclaimer] : [])], 1.4, 5.4, 13);

  const chunk = 16;
  for (let k = 0; k < Math.min(m.appendix.length, chunk * 8); k += chunk) {
    const s = slide(); h1(s, `Appendix — inputs and outputs (${k / chunk + 1})`);
    s.addTable([hdr(["Field", "Value", "Label"]), ...m.appendix.slice(k, k + chunk).map((l) => [l.path, l.value, l.flag ?? ""].map((x) => ({ text: x.slice(0, 120) })))], { x: 0.4, y: 1.3, w: 12.5, colW: [5, 4.5, 3], fontSize: 9, fontFace: font, border: { type: "solid", color: "DDDDDD", pt: 0.5 }, autoPage: false });
  }
  const outBuf = await p.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(outBuf) ? outBuf : Buffer.from(outBuf as ArrayBuffer);
}

// ───────────── persistence (user-scoped db; RLS applies) ─────────────
export async function loadBrand(db: Db, ws: string) {
  const tpls = ((await db.from("template_asset").select("id, name, version, kind, purpose, brand_json, approved").eq("workspace_id", ws).is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(20)).data ?? []) as Row[];
  const tpl = tpls.find((t) => t.kind === "pptx" && /deck/i.test(String(t.purpose))) ?? tpls.find((t) => t.kind === "pptx") ?? tpls[0] ?? null;
  const wsRow = (await db.from("workspace").select("name").eq("id", ws).maybeSingle()).data as Row | null;
  return { tpl, brand: brandFrom(tpl?.brand_json, wsRow?.name ?? "CRE OS"), note: tpl ? `Template "${tpl.name}" v${tpl.version}${tpl.approved ? "" : " (not approved)"}` : "Neutral layout (no workspace template configured)" };
}

export async function generateDeck(db: Db, ws: string, userId: string, analysisId: string, version?: number | null) {
  const a = (await getAnalysis(db, ws, analysisId)) as Row | null;
  if (!a) throw new Error("Analysis not found.");
  if (a.kind === "deliverable") throw new Error("Decks are made from analyses, not from deliverables.");
  const ver = version && version !== a.current_version ? await getVersion(db, ws, analysisId, version) : null;
  if (version && version !== a.current_version && !ver) throw new Error("Version not found.");
  const src = ver ?? a;
  const { tpl, brand, note } = await loadBrand(db, ws);
  const model = deckModel({ kind: a.kind, title: a.title, status: ver ? "draft" : a.status, missing: ver ? [] : a.missing ?? [], version: ver?.version ?? a.current_version, formula_version: src.formula_version, inputs: src.inputs, outputs: src.outputs, requirementTitle: a.requirement?.title ?? null, orgName: a.org?.display_name ?? null, approved_at: a.approved_at }, brand, note);
  const buf = await buildAnalysisDeck(model);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const path = `${ws}/toolkit/decks/${analysisId}/${randomUUID()}.pptx`;
  const up = await db.storage.from(BUCKET).upload(path, buf, { contentType: PPTX_MIME, upsert: false });
  if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);
  const ins = await db.from("document_version").insert({
    workspace_id: ws, kind: "pptx", purpose: DECK_PURPOSE, uri: `${BUCKET}/${path}`, sha256, owner_user_id: userId,
    template_asset_id: tpl?.id ?? null, template_version: tpl?.version ?? null, linked_entity_type: "deal_analysis", linked_entity_id: analysisId,
    input_versions: { analysis_id: analysisId, analysis_version: model.version, kind: a.kind, formula: model.formula, requirement_id: a.requirement_id ?? null, deck_formula: DECK_FORMULA },
  }).select("id, version_no").single();
  if (ins.error) { await db.storage.from(BUCKET).remove([path]); throw new Error(ins.error.message); }
  return { documentId: ins.data.id as string, versionNo: ins.data.version_no as number, fileName: fileName(a.title), sha256, bytes: buf.length, buffer: buf };
}
const fileName = (title: string) => `${title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "analysis"}-deck.pptx`;

export async function listDecks(db: Db, ws: string, analysisId: string) {
  return ((await db.from("document_version").select("id, version_no, created_at, input_versions").eq("workspace_id", ws).eq("purpose", DECK_PURPOSE).eq("linked_entity_type", "deal_analysis").eq("linked_entity_id", analysisId).is("archived_at", null).order("version_no", { ascending: false }).limit(10)).data ?? []) as Row[];
}
export async function downloadDeck(db: Db, ws: string, documentId: string) {
  const d = (await db.from("document_version").select("uri, sha256, linked_entity_id, purpose").eq("workspace_id", ws).eq("id", documentId).maybeSingle()).data as Row | null;
  if (!d || d.purpose !== DECK_PURPOSE || !String(d.uri).startsWith(`${BUCKET}/${ws}/toolkit/decks/`)) throw new Error("Deck not found.");
  const dl = await db.storage.from(BUCKET).download(String(d.uri).slice(BUCKET.length + 1));
  if (dl.error || !dl.data) throw new Error("File not found in storage.");
  const buf = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buf).digest("hex") !== d.sha256) throw new Error("File integrity check failed.");
  const a = (await db.from("deal_analysis").select("title").eq("workspace_id", ws).eq("id", d.linked_entity_id).maybeSingle()).data as Row | null;
  return { buffer: buf, mime: PPTX_MIME, fileName: fileName(a?.title ?? "analysis") };
}

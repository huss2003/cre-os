/**
 * Module 8 — client packs for a requirement + chosen buildings:
 *  (a) Site visit pack (DOCX): per property details, location, amenities, commercial terms with verification labels,
 *      inspection checklist (meetings SITE_VISIT rules) and a blank client feedback section;
 *  (b) Presentation deck (PPTX): requirement, shortlist, location, commercial terms, comparison figures from the latest
 *      saved property_comparison / lease_economics analysis, recommendation. Unverified / estimated figures are labelled.
 * Brand comes from the tenant template_asset (never hardcoded). Each generation is recorded via saveAnalysis
 * (kind "deliverable", formula "packs-1.0") with the analysis versions and quote versions it used.
 * No arithmetic on money here: figures are copied from stored quotes / saved deterministic analyses (S5).
 */
import { createHash } from "node:crypto";
import { AlignmentType, Document, Footer, Header, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { type DealsCtx, DealsError, must } from "@/modules/deals/ctx";
import { brandFrom, type Brand } from "@/modules/deals/documents/model";
import { SITE_VISIT } from "@/modules/meetings/rules";
import { localDate } from "@/lib/util/time";
import { saveAnalysis } from "./store";
import { isExpired } from "./quote-intake";

export const PACKS_FORMULA = "packs-1.0";
export const PACK_BUCKET = "mudar-workspace-files";
export type VerificationLabel = "Verified" | "Unverified" | "Estimated" | "Conflicting" | "Unknown";

/** Site-visit checklist topics (§8.10 site visit pack) — rated 1–5 with notes for every property. */
export const PACK_CHECKLIST: { key: string; label: string; prompt: string }[] = [
  { key: "commute", label: "Commute", prompt: "Travel time from main employee catchments; public transport; peak-hour access" },
  { key: "connectivity", label: "Connectivity", prompt: "Metro / bus / highway access; telecom & ISP options; mobile signal" },
  { key: "layout", label: "Layout", prompt: "Floor plate shape, column grid, core position, efficiency, natural light" },
  { key: "building_quality", label: "Building quality", prompt: "Grade, façade, lobby, lifts, HVAC, power back-up, maintenance, certifications" },
  { key: "amenities", label: "Amenities", prompt: "Food court, crèche, gym, retail, breakout areas" },
  { key: "parking", label: "Parking", prompt: "Ratio offered vs needed; 2/4-wheeler; visitor parking; cost" },
  { key: "operational", label: "Operational constraints", prompt: "Working hours, 24×7 access, security, loading, fit-out rules, signage" },
  { key: "price", label: "Price concerns", prompt: "Rent vs budget, CAM, escalations, deposit, hidden charges" },
  { key: "stakeholders", label: "Stakeholder reactions", prompt: "What each attendee liked / disliked; decision-maker's view" },
  { key: "suitability", label: "Overall suitability", prompt: "Fit against the requirement; keep / drop / maybe" },
];
export interface PackMedia { kind: "photo" | "floor_plan"; title: string; image?: { data: Buffer; type: "png" | "jpg"; width: number; height: number } | null }

export interface PackTerm { label: string; value: string; verification: VerificationLabel; source: string }
export interface PackProperty {
  id: string; name: string; address: string | null; location: string | null; grade: string | null; floors: string | null;
  amenities: string[]; specs: [string, string][]; commercial: PackTerm[]; notes: string[];
  media?: PackMedia[];
}
export interface PackFigureRow { name: string; cells: string[]; estimated: boolean }
export interface PackFigures { title: string; source: string; head: string[]; rows: PackFigureRow[] }
export interface PackModel {
  title: string; clientName: string; generatedAt: string; brand: Brand; watermark: string;
  requirement: { title: string; lines: [string, string][]; missing: string[] };
  properties: PackProperty[];
  figures: PackFigures[];
  recommendation: string[];
  sources: string[];
}

const LABEL_NOTE: Record<VerificationLabel, string> = {
  Verified: "from an approved quote or verified evidence",
  Unverified: "stated in a quote/brochure that has not been verified",
  Estimated: "estimate (asking rent snapshot or calculation input) — not a quote",
  Conflicting: "sources disagree — confirm before relying on it",
  Unknown: "not provided",
};
export const tagged = (t: PackTerm) => (t.verification === "Verified" ? t.value : `${t.value} [${t.verification}]`);

// ───────────────────────── DOCX: site visit pack ─────────────────────────
function tbl(head: string[], rows: string[][], color: string, font: string) {
  const cell = (t: string, bold = false, fill?: string) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: t, bold, font, color: fill ? "FFFFFF" : undefined, size: 18 })] })],
    shading: fill ? { fill } : undefined,
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: head.map((h) => cell(h, true, color)) }), ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))] });
}

export async function buildSiteVisitDocx(m: PackModel): Promise<Buffer> {
  const font = m.brand.font, color = m.brand.primary;
  const p = (text: string, o: { bold?: boolean; italic?: boolean; color?: string } = {}) => new Paragraph({ children: [new TextRun({ text, font, ...o })] });
  const h = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel] = HeadingLevel.HEADING_1) => new Paragraph({ heading: level, children: [new TextRun({ text, font, color })] });
  const blankLine = (label: string) => p(`${label}: ______________________________________________`);
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, font, color, bold: true })] }),
    p(`Prepared for ${m.clientName} · ${m.brand.name} · ${m.generatedAt.slice(0, 10)}`, { italic: true }),
    h("Requirement"),
    tbl(["Item", "Detail"], m.requirement.lines.map(([k, v]) => [k, v]), color, font),
    ...(m.requirement.missing.length ? [p(`Open questions: ${m.requirement.missing.join("; ")}`, { color: m.brand.accent })] : []),
    h("How to read the labels"),
    ...(Object.keys(LABEL_NOTE) as VerificationLabel[]).map((k) => p(`[${k}] — ${LABEL_NOTE[k]}`)),
    h("Before the visit"),
    ...SITE_VISIT.before.map((c) => p(`☐ ${c.label}`)),
  ];
  for (const [i, pr] of m.properties.entries()) {
    children.push(h(`${i + 1}. ${pr.name}`));
    children.push(tbl(["Property details", ""], [
      ["Address", pr.address ?? "Unknown"], ["Location", pr.location ?? "Unknown"], ["Grade", pr.grade ?? "Unknown"], ["Floors", pr.floors ?? "Unknown"],
      ...pr.specs,
    ], color, font));
    children.push(h("Amenities", HeadingLevel.HEADING_2), p(pr.amenities.length ? pr.amenities.join(", ") : "Not recorded — check on site."));
    children.push(h("Key commercials", HeadingLevel.HEADING_2));
    children.push(pr.commercial.length ? tbl(["Term", "Value", "Verification", "Source"], pr.commercial.map((t) => [t.label, t.value, t.verification, t.source]), color, font) : p("No quote or asking rent on record. Ask for a written quote.", { italic: true }));
    for (const n of pr.notes) children.push(p(`⚠ ${n}`, { color: m.brand.accent }));
    const media = pr.media ?? [];
    children.push(h("Photos and layouts", HeadingLevel.HEADING_2));
    if (!media.length) children.push(p("No photos or floor plans attached — attach them as evidence on the requirement's analysis to include them here.", { italic: true }));
    for (const md of media) {
      children.push(p(`${md.kind === "floor_plan" ? "Floor plan" : "Photo"}: ${md.title}`, { bold: true }));
      if (md.image) { const w = Math.min(520, md.image.width), hh = Math.round(md.image.height * (w / Math.max(1, md.image.width))); children.push(new Paragraph({ children: [new ImageRun({ type: md.image.type, data: md.image.data, transformation: { width: w, height: hh } })] })); }
      else children.push(p("(file not embeddable — open it from the evidence list)", { italic: true }));
    }
    children.push(h("Inspection checklist", HeadingLevel.HEADING_2));
    children.push(tbl(["Check", "OK?", "Notes"], SITE_VISIT.during.map((c) => [c.label, "☐", ""]), color, font));
    children.push(h("Site assessment (rate 1–5)", HeadingLevel.HEADING_2));
    children.push(tbl(["Topic", "What to look for", "Rating 1–5", "Notes"], PACK_CHECKLIST.map((c) => [c.label, c.prompt, "", ""]), color, font));
    children.push(h("Client feedback form", HeadingLevel.HEADING_2));
    children.push(blankLine("Overall impression (1–5)"), blankLine("Liked"), blankLine("Concerns / objections"), blankLine("Price concerns"), blankLine("Stakeholder reactions (who said what)"), blankLine("Information requested"), blankLine("Keep on shortlist? (Yes / No / Maybe)"), blankLine("Attendee signatures"));
  }
  children.push(h("After the visit"), ...SITE_VISIT.after.map((c) => p(`☐ ${c.label}`)));
  children.push(h("Sources"), ...m.sources.map((s) => p(s)));
  if (m.brand.disclaimer) children.push(p(m.brand.disclaimer, { italic: true }));
  const doc = new Document({
    creator: m.brand.name, title: m.title,
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: m.brand.name, font, color, size: 16 })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: m.watermark, font, italics: true, color: m.brand.accent, size: 16 })] })] }) },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ───────────────────────── PDF: site visit pack (print version) ─────────────────────────
/** Same content as the DOCX, rendered with the shared pdf-lib renderer (text only; photos stay in the DOCX). */
export async function buildSiteVisitPdf(m: PackModel): Promise<Buffer> {
  const { buildPdf } = await import("@/modules/assistant/outputs/render");
  const blank = "________________________________";
  const sections = [
    { heading: "Requirement", paragraphs: m.requirement.missing.length ? [`Open questions: ${m.requirement.missing.join("; ")}`] : [], bullets: [], table: { columns: ["Item", "Detail"], rows: m.requirement.lines.map(([k, v]) => [k, v]) } },
    { heading: "How to read the labels", paragraphs: [], bullets: (Object.keys(LABEL_NOTE) as VerificationLabel[]).map((k) => `[${k}] — ${LABEL_NOTE[k]}`) },
    { heading: "Before the visit", paragraphs: [], bullets: SITE_VISIT.before.map((c) => `[ ] ${c.label}`) },
    ...m.properties.flatMap((pr, i) => [
      { heading: `${i + 1}. ${pr.name}`, paragraphs: [], bullets: [], table: { columns: ["Property details", ""], rows: [["Address", pr.address ?? "Unknown"], ["Location", pr.location ?? "Unknown"], ["Grade", pr.grade ?? "Unknown"], ["Floors", pr.floors ?? "Unknown"], ["Amenities", pr.amenities.join(", ") || "Not recorded — check on site"], ...pr.specs] } },
      { heading: "Key commercials", paragraphs: pr.commercial.length ? pr.notes.map((n) => `! ${n}`) : ["No quote or asking rent on record. Ask for a written quote."], bullets: [], table: pr.commercial.length ? { columns: ["Term", "Value", "Verification", "Source"], rows: pr.commercial.map((t) => [t.label, t.value, t.verification, t.source]) } : undefined },
      { heading: "Photos and layouts", paragraphs: [(pr.media ?? []).length ? "Attached (see the Word pack for images):" : "None attached."], bullets: (pr.media ?? []).map((md) => `${md.kind === "floor_plan" ? "Floor plan" : "Photo"}: ${md.title}`) },
      { heading: "Inspection checklist", paragraphs: [], bullets: SITE_VISIT.during.map((c) => `[ ] ${c.label}`) },
      { heading: "Site assessment (rate 1–5)", paragraphs: [], bullets: [], table: { columns: ["Topic", "What to look for", "Rating", "Notes"], rows: PACK_CHECKLIST.map((c) => [c.label, c.prompt, "", ""]) } },
      { heading: "Client feedback form", paragraphs: ["Overall impression (1–5)", "Liked", "Concerns / objections", "Price concerns", "Stakeholder reactions (who said what)", "Information requested", "Keep on shortlist? (Yes / No / Maybe)", "Attendee signatures"].map((l) => `${l}: ${blank}`), bullets: [] },
    ]),
    { heading: "After the visit", paragraphs: [], bullets: SITE_VISIT.after.map((c) => `[ ] ${c.label}`) },
  ];
  return buildPdf({ title: m.title, subtitle: `Prepared for ${m.clientName} · ${m.brand.name} · ${m.generatedAt.slice(0, 10)} · ${m.watermark}`, brand: m.brand, sections, sources: m.sources.map((label) => ({ label })), missing: m.requirement.missing });
}

/** Width/height from a PNG or JPEG header (pure); null when not recognised. */
export function imageInfo(buf: Buffer): { type: "png" | "jpg"; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1], len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "jpg", height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      o += 2 + len;
    }
  }
  return null;
}

// ───────────────────────── PPTX: presentation deck ─────────────────────────
export async function buildPackPptx(m: PackModel): Promise<Buffer> {
  const { default: Pptx } = await import("pptxgenjs");
  const p = new Pptx();
  p.layout = "LAYOUT_WIDE"; p.author = m.brand.name; p.company = m.brand.name; p.title = m.title;
  const font = m.brand.font, hfont = m.brand.headingFont ?? font;
  p.defineSlideMaster({ title: "BRAND", background: { color: "FFFFFF" }, objects: [
    { rect: { x: 0, y: 0, w: "100%", h: 0.35, fill: { color: m.brand.primary } } },
    { text: { text: m.watermark, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontSize: 9, color: m.brand.accent, fontFace: font, italic: true } } },
    { text: { text: `${m.brand.name} · ${PACKS_FORMULA} · ${m.generatedAt.slice(0, 10)}`, options: { x: 8.4, y: 7.05, w: 4.6, h: 0.3, fontSize: 8, color: "666666", fontFace: font, align: "right" } } },
  ] });
  const slide = () => p.addSlide({ masterName: "BRAND" });
  const h1 = (s: ReturnType<typeof slide>, t: string) => s.addText(t, { x: 0.4, y: 0.5, w: 12.4, h: 0.7, fontSize: 26, bold: true, color: m.brand.primary, fontFace: hfont });
  const hdr = (cols: string[]) => cols.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: m.brand.primary } } }));
  const tOpts = { x: 0.4, y: 1.4, w: 12.5, fontSize: 11, fontFace: font, border: { type: "solid" as const, color: "DDDDDD", pt: 0.5 } };
  const bullets = (s: ReturnType<typeof slide>, lines: string[], y = 1.4) => s.addText(lines.map((l) => ({ text: l, options: { bullet: true, breakLine: true } })), { x: 0.5, y, w: 12.3, h: 5.4, fontSize: 13, fontFace: font, valign: "top" });

  const t = slide();
  t.addText(m.title, { x: 0.6, y: 2.2, w: 12, h: 1.2, fontSize: 34, bold: true, color: m.brand.primary, fontFace: hfont });
  t.addText(`Prepared for ${m.clientName}`, { x: 0.6, y: 3.5, w: 12, h: 0.6, fontSize: 18, color: "333333", fontFace: font });

  const r = slide(); h1(r, "Requirement");
  r.addTable(m.requirement.lines.map(([k, v]) => [{ text: k, options: { bold: true } }, { text: v }]), { ...tOpts, colW: [3.5, 9] });
  if (m.requirement.missing.length) r.addText(`Open questions: ${m.requirement.missing.slice(0, 6).join("; ")}`, { x: 0.4, y: 6.3, w: 12.5, h: 0.6, fontSize: 11, color: m.brand.accent, fontFace: font });

  const s = slide(); h1(s, "Shortlist");
  if (!m.properties.length) s.addText("No buildings selected.", { x: 0.4, y: 1.5, w: 12, h: 0.5, fontSize: 14, fontFace: font });
  else s.addTable([hdr(["#", "Building", "Location", "Grade", "Rent", "Verification"]), ...m.properties.map((pr, i) => {
    const rent = pr.commercial.find((c) => c.label.startsWith("Rent"));
    return [String(i + 1), pr.name, pr.location ?? "Unknown", pr.grade ?? "—", rent?.value ?? "Unknown", rent?.verification ?? "Unknown"].map((x) => ({ text: x }));
  })], { ...tOpts, colW: [0.4, 3.4, 2.8, 1, 2.6, 2.3] });

  const l = slide(); h1(l, "Location");
  bullets(l, m.properties.map((pr) => `${pr.name} — ${[pr.location, pr.address].filter(Boolean).join(" · ") || "location not recorded"}`));

  for (const pr of m.properties) {
    const c = slide(); h1(c, `Commercial terms — ${pr.name}`);
    if (!pr.commercial.length) c.addText("No quote or asking rent on record.", { x: 0.4, y: 1.5, w: 12, h: 0.5, fontSize: 14, fontFace: font });
    else c.addTable([hdr(["Term", "Value", "Verification", "Source"]), ...pr.commercial.map((x) => [x.label, x.value, x.verification, x.source].map((v) => ({ text: v })))], { ...tOpts, colW: [3, 3.5, 2, 4] });
    if (pr.notes.length) c.addText(pr.notes.map((n) => `⚠ ${n}`).join("\n"), { x: 0.4, y: 6.2, w: 12.5, h: 0.7, fontSize: 10, color: m.brand.accent, fontFace: font });
  }

  for (const f of m.figures) {
    const c = slide(); h1(c, f.title);
    c.addTable([hdr(["Option", ...f.head]), ...f.rows.map((r) => [r.estimated ? `${r.name} [Estimated]` : r.name, ...r.cells].map((v) => ({ text: v })))], tOpts);
    c.addText(`Source: ${f.source}. Rows marked [Estimated] use estimated inputs, not quotes.`, { x: 0.4, y: 6.4, w: 12.5, h: 0.5, fontSize: 10, italic: true, color: "555555", fontFace: font });
  }

  const rec = slide(); h1(rec, "Recommendation");
  bullets(rec, m.recommendation.length ? m.recommendation : ["No saved property comparison yet — run one in the Toolkit to add a recommendation."]);

  const src = slide(); h1(src, "Labels and sources");
  bullets(src, [...(Object.keys(LABEL_NOTE) as VerificationLabel[]).map((k) => `[${k}] ${LABEL_NOTE[k]}`), ...m.sources, ...(m.brand.disclaimer ? [m.brand.disclaimer] : [])]);

  const out = await p.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

// ───────────────────────── model assembly (DB, user-scoped) ─────────────────────────
type Row = Record<string, any>;
const fmtInr = (v: unknown) => (v === null || v === undefined || v === "" ? null : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

/** Commercial terms from a stored quote version, labelled. Pure. */
export function quoteTerms(q: Row, asOf: string, conflicting = false): { terms: PackTerm[]; notes: string[] } {
  const t = (q.terms_json ?? {}) as Row;
  const label: VerificationLabel = conflicting ? "Conflicting" : q.approved_at ? "Verified" : "Unverified";
  const src = `Quote v${q.version}${q.approved_at ? " (approved)" : ""}`;
  const unit = t.rent_basis === "seat" ? "/seat" : `/SF ${t.rent_basis ?? "(basis not stated)"}`;
  const per = t.rent_periodicity === "annual" ? "/year" : "/month";
  const rows: [string, string | null][] = [
    ["Rent", fmtInr(t.rent) ? `${fmtInr(t.rent)}${unit}${per}` : null],
    ["CAM", t.cam_included === true ? "Included" : fmtInr(t.cam_per_sf) ? `${fmtInr(t.cam_per_sf)}/SF/month` : null],
    ["Parking", fmtInr(t.parking_per_slot) ? `${fmtInr(t.parking_per_slot)}/slot/month` : null],
    ["Security deposit", s(t.deposit_months) && `${t.deposit_months} months`],
    ["Escalation", s(t.escalation_pct) && `${t.escalation_pct}%${t.escalation_every_months ? ` every ${t.escalation_every_months} months` : ""}`],
    ["Rent-free", s(t.rent_free_months) && `${t.rent_free_months} months`],
    ["Fit-out", s(t.fitout) ?? (fmtInr(t.capex_support) ? `Support ${fmtInr(t.capex_support)}` : null)],
    ["Lock-in", s(t.lockin_months) && `${t.lockin_months} months`],
    ["Notice", s(t.notice_months) && `${t.notice_months} months`],
    ["Taxes", s(t.taxes) ?? (t.gst ? `GST ${t.gst}` : null)],
    ["Valid until", s(q.valid_until)],
  ];
  const terms = rows.map(([label0, v]) => ({ label: label0, value: v ?? "Unknown", verification: v ? label : "Unknown" as VerificationLabel, source: v ? src : "—" }));
  const notes: string[] = [];
  if (isExpired(q.valid_until, asOf)) notes.push(`Quote v${q.version} expired on ${q.valid_until} — ask for a fresh quote before sharing.`);
  if (!q.approved_at) notes.push("Quote figures are unverified (quote not approved).");
  if (conflicting) notes.push("Evidence attached to the comparison is marked conflicting.");
  return { terms, notes };
}

/** Comparison figures from a saved analysis' outputs (shape-tolerant; figures copied, never recomputed). Pure. */
export function figuresFromAnalysis(a: { kind: string; title: string; current_version: number; outputs: Row }): PackFigures | null {
  const o = a.outputs ?? {};
  const source = `${a.kind === "property_comparison" ? "Property comparison" : "Lease economics"} "${a.title}" v${a.current_version}`;
  if (Array.isArray(o.properties)) {
    return { title: "Property comparison", source, head: ["Rank", "Score", "Occupancy cost ₹/SF/mo", "Eligibility"], rows: (o.properties as Row[]).map((p) => ({
      name: String(p.name ?? p.key), estimated: p.evidence === "estimated" || p.evidence == null,
      cells: [s(p.rank) ?? "—", s(p.score) ?? "—", s(p.occupancyCost) ?? "Unknown", String(p.eligibility ?? "—").replace("_", " ")],
    })) };
  }
  const offers: Row[] = o.comparison?.offers ?? (o.result ? [o.result] : []);
  if (offers.length) {
    return { title: "Lease economics", source, head: ["Nominal rent ₹/SF", "Effective rent ₹/SF", "PV-effective ₹/SF"], rows: offers.map((r) => ({
      name: String(r.name ?? "Offer"), estimated: /estimat/i.test(String(r.label ?? r.valueLabel ?? "")),
      cells: [s(r.nominalRentPerSf) ?? "—", s(r.effectiveRentPerSf) ?? "—", s(r.pvEffectiveRentPerSf) ?? "—"],
    })) };
  }
  return null;
}

export interface PackRequest { requirementId: string; assetIds: string[]; preparedFor?: string | null }

export async function assemblePackModel(ctx: DealsCtx, g: PackRequest, asOf = localDate()) {
  if (!g.assetIds.length) throw new DealsError(400, "Choose at least one building.");
  const req = must(await ctx.db.from("requirement").select("*, org:org_id(display_name)").eq("workspace_id", ctx.workspaceId).eq("id", g.requirementId).maybeSingle(), "requirement") as Row;
  const assets = ((await ctx.db.from("asset").select("id, name, address, grade, floors, specs, lat, lon, locality:locality_id(name), micro:micro_market_id(name)").eq("workspace_id", ctx.workspaceId).in("id", g.assetIds)).data ?? []) as Row[];
  const spaces = ((await ctx.db.from("space").select("id, asset_id").eq("workspace_id", ctx.workspaceId).in("asset_id", g.assetIds)).data ?? []) as Row[];
  const spaceAsset = new Map(spaces.map((x) => [x.id as string, x.asset_id as string]));
  const quotes = spaces.length ? ((await ctx.db.from("quote").select("*").eq("workspace_id", ctx.workspaceId).eq("requirement_id", g.requirementId).is("superseded_by", null).is("archived_at", null).in("space_id", spaces.map((x) => x.id))).data ?? []) as Row[] : [];
  const avail = spaces.length ? ((await ctx.db.from("availability").select("space_id, asking_rent_min, asking_rent_max, observed_at:created_at").eq("workspace_id", ctx.workspaceId).in("space_id", spaces.map((x) => x.id)).order("created_at", { ascending: false })).data ?? []) as Row[] : [];

  const analyses = ((await ctx.db.from("deal_analysis").select("id, kind, title, current_version, outputs, updated_at").eq("workspace_id", ctx.workspaceId).eq("requirement_id", g.requirementId).in("kind", ["property_comparison", "lease_economics"]).is("archived_at", null).order("updated_at", { ascending: false })).data ?? []) as Row[];
  const used = ["property_comparison", "lease_economics"].map((k) => analyses.find((a) => a.kind === k)).filter(Boolean) as Row[];
  const ev = used.length ? ((await ctx.db.from("deal_evidence").select("analysis_id, verification").eq("workspace_id", ctx.workspaceId).in("analysis_id", used.map((a) => a.id)).is("archived_at", null)).data ?? []) as Row[] : [];
  const conflicting = ev.some((e) => e.verification === "conflicting");

  const tpl = (await ctx.db.from("template_asset").select("id, name, version, brand_json, approved").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as Row | null;
  const ws = (await ctx.db.from("workspace").select("name").eq("id", ctx.workspaceId).maybeSingle()).data as Row | null;
  const brand = brandFrom(tpl?.brand_json, ws?.name ?? "CRE OS");

  const properties: PackProperty[] = g.assetIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean).map((a) => {
    const aq = quotes.filter((q) => spaceAsset.get(q.space_id) === a!.id).sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))[0];
    const specs = (a!.specs ?? {}) as Row;
    const amenities = Array.isArray(specs.amenities) ? specs.amenities.map(String) : [];
    let commercial: PackTerm[] = [], notes: string[] = [];
    if (aq) ({ terms: commercial, notes } = quoteTerms(aq, asOf, conflicting));
    else {
      const av = avail.find((x) => spaceAsset.get(x.space_id) === a!.id && (x.asking_rent_min != null || x.asking_rent_max != null));
      if (av) commercial = [{ label: "Rent (asking)", value: [fmtInr(av.asking_rent_min), fmtInr(av.asking_rent_max)].filter(Boolean).join(" – ") + "/SF/month", verification: "Estimated", source: "Availability snapshot (asking)" }];
      notes = ["No quote on record for this building and requirement."];
    }
    return {
      id: a!.id, name: a!.name, address: a!.address ?? null, location: [a!.micro?.name, a!.locality?.name].filter(Boolean).join(", ") || null,
      grade: a!.grade ?? null, floors: a!.floors != null ? String(a!.floors) : null, amenities,
      specs: Object.entries(specs).filter(([k, v]) => k !== "amenities" && v != null && typeof v !== "object").slice(0, 8).map(([k, v]) => [k.replace(/_/g, " "), String(v)] as [string, string]),
      commercial, notes,
    };
  });
  const missingAssets = g.assetIds.filter((id) => !assets.some((a) => a.id === id));
  if (missingAssets.length) throw new DealsError(404, "One or more buildings were not found.");

  // Photos / floor plans attached as evidence to any analysis of this requirement; matched to a building by name in the title.
  const reqAnalysisIds = ((await ctx.db.from("deal_analysis").select("id").eq("workspace_id", ctx.workspaceId).eq("requirement_id", g.requirementId).is("archived_at", null)).data ?? []).map((x: Row) => x.id as string);
  const mediaEv = reqAnalysisIds.length ? ((await ctx.db.from("deal_evidence").select("kind, title, storage_path").eq("workspace_id", ctx.workspaceId).in("analysis_id", reqAnalysisIds).in("kind", ["photo", "floor_plan"]).is("archived_at", null).order("created_at").limit(40)).data ?? []) as Row[] : [];
  let embedded = 0;
  for (const e of mediaEv) {
    const target = properties.find((pr) => String(e.title).toLowerCase().includes(pr.name.toLowerCase())) ?? (properties.length === 1 ? properties[0] : null);
    if (!target) continue;
    let image: PackMedia["image"] = null;
    if (e.storage_path && String(e.storage_path).startsWith(`${ctx.workspaceId}/`) && embedded < 12) {
      const dl = await ctx.db.storage.from(PACK_BUCKET).download(e.storage_path);
      if (!dl.error && dl.data && dl.data.size <= 4_000_000) {
        const data = Buffer.from(await dl.data.arrayBuffer()); const info = imageInfo(data);
        if (info) { image = { data, ...info }; embedded++; }
      }
    }
    (target.media ??= []).push({ kind: e.kind, title: String(e.title), image });
  }
  const figures = used.map((a) => figuresFromAnalysis(a as never)).filter(Boolean) as PackFigures[];
  const cmp = used.find((a) => a.kind === "property_comparison");
  const recommendation = cmp?.outputs?.recommendation?.explanation ? [String(cmp.outputs.recommendation.explanation), `From ${cmp.title} v${cmp.current_version}.`] : [];
  const area = [req.area_min_sf, req.area_target_sf, req.area_max_sf].some((x) => x != null) ? `${req.area_min_sf ?? "?"} – ${req.area_max_sf ?? "?"} SF (target ${req.area_target_sf ?? "?"})` : "Unknown";
  const lines: [string, string][] = [["Requirement", req.title ?? "—"], ["Client", req.org?.display_name ?? "Unknown"], ["Area", area], ["Seats", s(req.seats_target) ?? "Unknown"], ["Budget", req.budget_max != null ? `${fmtInr(req.budget_max)} (${req.budget_basis ?? "basis not stated"})` : "Unknown"], ["Occupation date", s(req.occupation_date) ?? "Unknown"]];
  const model: PackModel = {
    title: `${req.title ?? "Requirement"} — property pack`, clientName: g.preparedFor || req.org?.display_name || "Client",
    generatedAt: new Date().toISOString(), brand, watermark: "Confidential — prepared for the named client only",
    requirement: { title: req.title ?? "", lines, missing: lines.filter(([, v]) => v === "Unknown").map(([k]) => k) },
    properties, figures, recommendation,
    sources: [
      tpl ? `Template "${tpl.name}" v${tpl.version}${tpl.approved ? "" : " (not approved)"}` : "Built-in neutral layout (no tenant template configured)",
      ...used.map((a) => `${a.kind} "${a.title}" v${a.current_version}`),
      ...quotes.map((q) => `Quote ${String(q.id).slice(0, 8)} v${q.version}${q.approved_at ? " approved" : ""}`),
      `Generated ${asOf} with ${PACKS_FORMULA}`,
    ],
  };
  return { model, analysisRefs: used.map((a) => ({ id: a.id, kind: a.kind, version: a.current_version })), quoteRefs: quotes.map((q) => ({ id: q.id, version: q.version })), orgId: req.org_id as string | null };
}

/** Build both files, store them, and record the generation (kind "deliverable", formula packs-1.0). */
export async function generatePacks(ctx: DealsCtx, g: PackRequest) {
  const { model, analysisRefs, quoteRefs, orgId } = await assemblePackModel(ctx, g);
  const [docx, pptx, pdf] = await Promise.all([buildSiteVisitDocx(model), buildPackPptx(model), buildSiteVisitPdf(model)]);
  const stamp = Date.now();
  const files = [{ kind: "docx", label: "Site visit pack", buf: docx, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { kind: "pdf", label: "Site visit pack (print)", buf: pdf, mime: "application/pdf" },
    { kind: "pptx", label: "Presentation deck", buf: pptx, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }];
  const stored: { label: string; kind: string; path: string; sha256: string; bytes: number }[] = [];
  for (const f of files) {
    const path = `${ctx.workspaceId}/packs/${g.requirementId}/${stamp}-${f.kind === "pptx" ? "deck" : "site-visit"}.${f.kind}`;
    const up = await ctx.db.storage.from(PACK_BUCKET).upload(path, f.buf, { contentType: f.mime, upsert: false });
    if (up.error) throw new DealsError(500, `storage upload failed: ${up.error.message}`);
    stored.push({ label: f.label, kind: f.kind, path, sha256: createHash("sha256").update(f.buf).digest("hex"), bytes: f.buf.length });
  }
  const saved = await saveAnalysis(ctx.db, ctx.workspaceId, ctx.userId, {
    kind: "deliverable", title: `Packs: ${model.title}`, requirementId: g.requirementId, orgId, assetIds: g.assetIds, quoteRefs,
    inputs: { pack: "site_visit+deck", requirementId: g.requirementId, assetIds: g.assetIds, preparedFor: g.preparedFor ?? null, analysisRefs, quoteRefs },
    outputs: { files: stored, sources: model.sources }, formulaVersion: PACKS_FORMULA, missing: [],
  });
  return { ...saved, files: stored };
}

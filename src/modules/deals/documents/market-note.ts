/**
 * Market note — its own template (not the proposal): market context for the client's preferred micro-markets,
 * availability picture from stored snapshots, observed asking-rent range, stored market observations (each with
 * period, source and as-of), schematic map, caveats and sources. All figures are stored facts or deterministic
 * min/max/counts; nothing is estimated by a model.
 */
import { HeadingLevel, Paragraph, Table, TextRun } from "docx";
import type { DocModel } from "./model";
import { table, wordKit } from "./docx";

export async function buildMarketNoteDocx(m: DocModel): Promise<Buffer> {
  const { font, H, P, B, sources, visuals, pack } = wordKit(m);
  const mk = m.market;
  const body: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: m.title, font: m.brand.headingFont ?? font, color: m.brand.primary })] }),
    P(`Market note for ${m.clientName}${m.preparedFor ? ` · ${m.preparedFor}` : ""} · ${m.generatedAt.slice(0, 10)}${m.version ? ` · version ${m.version.no}` : ""}`),
    H("Summary"),
  ];
  const geos = mk?.geographies.length ? mk.geographies.join(", ") : "no preferred micro-markets recorded";
  const avail = mk?.availabilitySummary.length ? mk.availabilitySummary.map((a) => `${a.count} ${a.status.replace(/_/g, " ")}`).join(", ") : "no availability snapshots";
  body.push(B(`Focus: ${geos}.`));
  body.push(B(`Options tracked for this requirement: ${m.options.length} (${avail}).`));
  if (mk && mk.askingRent.observations) body.push(B(`Asking rent observed: ₹${mk.askingRent.min ?? "?"}–₹${mk.askingRent.max ?? "?"}${mk.askingRent.basis ? ` per ${mk.askingRent.basis}` : ""} across ${mk.askingRent.observations} snapshot(s)${mk.askingRent.asOfRange ? `, as of ${mk.askingRent.asOfRange}` : ""}.`));
  else body.push(B("Asking rent: no stored observations — unknown."));

  body.push(H("Market observations"));
  if (mk?.observations.length) {
    body.push(table(["Metric", "Geography", "Period", "Value", "Source"], mk.observations.map((o) => [o.metric, o.geography, o.period, `${o.value} ${o.unit}`, o.source]), m.brand.primary, font));
    body.push(P("Observations are shown as stored, with their period and source; definitions differ between sources — do not add or average across sources.", { italic: true, size: 16 }));
  } else body.push(P("No market observations stored for these micro-markets. Import a licensed market report to populate this section.", { italic: true }));

  body.push(H("Availability picture"));
  const opts = m.options.filter((o) => o.eligibility !== "ineligible");
  if (opts.length) body.push(table(["Option", "Locality", "Area", "All-in cost", "Availability (as of)"], opts.slice(0, 20).map((o) => [o.label, o.locality ?? "—", o.area, o.cost, o.availability]), m.brand.primary, font));
  else body.push(P("No shortlisted options yet — run the shortlist on the requirement first.", { italic: true }));
  const unverified = m.options.filter((o) => o.flags.some((f) => /unverified|stale/i.test(f))).length;
  if (unverified) body.push(P(`${unverified} option(s) have unverified or stale availability — recheck before sharing.`, { color: m.brand.accent }));

  body.push(...visuals());
  body.push(H("Caveats"));
  m.assumptions.forEach((a) => body.push(B(a)));
  m.freshness.forEach((a) => body.push(B(a)));
  body.push(...sources());
  if (m.brand.disclaimer) body.push(P(m.brand.disclaimer, { italic: true }));
  return pack(m.title, body);
}

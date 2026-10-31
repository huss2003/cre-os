/**
 * intel-B round 2 — pure acceptance tests for Legal Desk (16), Market Analyst (19) and Content Editor (20).
 * Test names follow the acceptance criterion they prove.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Document, Packer, Paragraph } from "docx";
import { extractClauses, validateClauses, documentRedline, exposureChecklist, compareClauses, locatorLabel, type ExtractedClause } from "./legal/clauses";
import { extractDocumentText } from "./legal/upload";
import { analyseMarket, caveatsFor, type SourceInfo } from "./market/analysis";
import { factsFromTrend, marketDisclaimer, type Observation } from "./market/series";
import { MarketChart } from "./market/chart";
import { makePdf } from "./intel-b.fixtures";
import { factCheck, reviewChecklist, checklistPasses, parseBrandRule, privateShareable, weeklyPlan, type EvidenceFact } from "./content/editor";

const LEASE = `LEASE DEED

1. Rent
The monthly rent shall be Rs. 85 per sq ft on chargeable area.

2. Escalation
Rent shall escalate by 5% every 12 months.

3. Tenant Obligations
The Tenant shall maintain the premises in good repair and comply with all statutory approvals.

4. Assignment
The Tenant shall not assign or sub-let the premises without the prior written consent of the Landlord.

5. Rent Commencement
Handover of the premises shall be on 1 April 2026 and rent commencement on 1 July 2026.

6. Force Majeure
Neither party is liable for delay caused by force majeure events.

7. Governing Law
Disputes shall be referred to arbitration seated in Pune.
`;

describe("Legal Desk (16)", () => {
  it("PDF upload: text extracted with page locators on every clause", async () => {
    const pdf = makePdf([["1. Rent", "The monthly rent shall be Rs. 85 per sq ft."], ["2. Lock-in", "The lock-in period shall be 36 months for the Tenant."]]);
    const t = await extractDocumentText("loi.pdf", pdf);
    expect(t.kind).toBe("pdf");
    expect(t.pageCount).toBe(2);
    expect(t.ocrStatus).toBe("not_needed");
    const cs = extractClauses(t.text, { paged: true });
    expect(cs.find((c) => c.clause_type === "rent")!.locator.page).toBe(1);
    expect(cs.find((c) => c.clause_type === "lock_in")!.locator.page).toBe(2);
    expect(locatorLabel(cs.find((c) => c.clause_type === "lock_in")!.locator, 3)).toMatch(/^v3 · p\.2 · ¶\d+ · line/);
  });

  it("scanned PDF with no text layer is marked OCR-needed, nothing is guessed", async () => {
    const t = await extractDocumentText("scan.pdf", makePdf([[], []]));
    expect(t.ocrStatus).toBe("ocr_needed");
    expect(t.text).toBe("");
    expect(t.notes.join(" ")).toMatch(/OCR is needed/);
  });

  it("DOCX upload keeps paragraph locators", async () => {
    const doc = new Document({ sections: [{ children: ["1. Rent", "The monthly rent shall be Rs. 85 per sq ft.", "2. Lock-in", "Lock-in of 36 months for the Tenant."].map((x) => new Paragraph(x)) }] });
    const t = await extractDocumentText("loi.docx", new Uint8Array(await Packer.toBuffer(doc)));
    expect(t.kind).toBe("docx");
    const lock = extractClauses(t.text).find((c) => c.clause_type === "lock_in")!;
    expect(lock.locator.para_start).toBe(3);
    expect(lock.locator.page).toBeNull();
  });

  it("extracts obligations and other common clause types (assignment, possession dates, force majeure, disputes)", () => {
    const types = extractClauses(LEASE).map((c) => c.clause_type);
    expect(types).toEqual(expect.arrayContaining(["rent", "escalation", "obligations", "assignment", "possession", "force_majeure", "dispute_resolution"]));
    const pos = extractClauses(LEASE).find((c) => c.clause_type === "possession")!;
    expect(pos.extracted_values.dates).toEqual(["1 April 2026", "1 July 2026"]);
    const items = exposureChecklist(extractClauses(LEASE), undefined, { document: { id: "d", title: "Lease", version: 2 } });
    expect(items.some((i) => i.clause_type === "obligations")).toBe(true);
    expect(items.some((i) => i.clause_type === "force_majeure" && /abatement/.test(i.exposure))).toBe(true);
  });

  it("validateAgainstSource checks the WHOLE clause and re-checks model values against the source wording", () => {
    const esc = extractClauses(LEASE).find((c) => c.clause_type === "escalation")!;
    const v = validateClauses(LEASE, [
      { ...esc, clause_text: "Rent shall escalate by 5% every 12 months and the landlord may terminate at will." }, // starts right, rest invented
      { ...esc, locator: { line_start: 99, line_end: 99, char_start: 0, char_end: 1, page: 7 }, extracted_values: { percent: 25, every: 12, every_unit: "months", notice_days: 90, months: 12 } },
    ]);
    expect(v.rejected).toHaveLength(1);
    expect(v.rejected[0].reason).toMatch(/not found verbatim/);
    const ok = v.clauses[0];
    expect(ok.extracted_values.percent).toBe(5); // model's 25 corrected from the wording
    expect(ok.validation!.corrected.map((c) => c.key)).toContain("percent");
    expect(ok.validation!.dropped.map((d) => d.key)).toContain("notice_days"); // 90 is not in the clause
    expect(ok.locator.line_start).toBe(LEASE.split("\n").findIndex((l) => l.startsWith("Rent shall escalate")) + 1); // recomputed from the source, model locator ignored
    expect(ok.locator.page).toBeNull();
  });

  it("full-document redline catches wording changed outside recognised clauses, with line numbers", () => {
    const v2 = LEASE.replace("seated in Pune", "seated in Mumbai").replace("LEASE DEED", "LEASE DEED (DRAFT 2)");
    const r = documentRedline(LEASE, v2);
    const lines = r.hunks.flatMap((h) => h.lines);
    expect(lines.some((l) => l.op === "del" && l.text === "LEASE DEED" && l.base_line === 1)).toBe(true);
    expect(lines.some((l) => l.op === "ins" && /Mumbai/.test(l.text) && l.ops!.some((o) => o.op === "ins" && /Mumbai/.test(o.text)))).toBe(true);
    expect(r.stats.removed).toBe(2);
  });

  it("findings link to exact clauses AND document versions (redline + every checklist item)", () => {
    const v2 = LEASE.replace("5% every 12 months", "7% every 12 months").replace(/6\. Force Majeure[\s\S]*?events\.\n\n/, "");
    const a = extractClauses(LEASE), b = extractClauses(v2);
    const diff = compareClauses(a, b);
    const items = exposureChecklist(b, diff, { document: { id: "n", title: "Lease", version: 2 }, base: { id: "o", title: "Lease", version: 1 } });
    const changed = items.find((i) => i.clause_type === "escalation" && /changed/.test(i.exposure))!;
    expect(changed.document!.version).toBe(2);
    expect(changed.locator!.line_start).toBeGreaterThan(0);
    expect(changed.base_document!.version).toBe(1);
    const removed = items.find((i) => i.clause_type === "force_majeure" && /removed/.test(i.exposure))!;
    expect(removed.locator).toBeNull();
    expect(removed.base_locator!.line_start).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.reviewer_status).toBe("pending_legal_review");
      if (it.locator) expect(it.document).not.toBeNull();
      if (it.certainty === "not_found") expect(it.locator).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ market
const o = (p: Partial<Observation>): Observation => ({ id: Math.random().toString(36).slice(2), metric: "absorption", geography_id: null, geography_raw: "SBD East", period_start: "2024-01-01", period_end: null, period_type: "full_year", unit: "msf", value: 1, definition: "Gross absorption, Grade A", release_date: "2026-01-15", source_object_id: "so1", source_version: null, ...p });
const SRC = new Map<string, SourceInfo>([["so1", { name: "CBRE Pune H2 2025", licensed: false }], ["so2", { name: "JLL Pune Q3 2025", licensed: true }]]);

describe("Market Analyst (19)", () => {
  it("every chart has a period, unit and source (name + release date)", () => {
    const a = analyseMarket([o({ period_start: "2023-01-01", value: 3 }), o({ period_start: "2024-01-01", value: 4 })], [], SRC);
    const s = a.series[0];
    expect(s.unit).toBe("msf");
    expect(s.periodLabel).toBe("2023 – 2024 (annual)");
    expect(s.sources).toEqual([expect.objectContaining({ name: "CBRE Pune H2 2025", release_date: "2026-01-15" })]);
    const html = renderToStaticMarkup(createElement(MarketChart, { s }));
    expect(html).toContain("Period");
    expect(html).toContain("2023 – 2024 (annual)");
    expect(html).toContain("msf");
    expect(html).toContain("CBRE Pune H2 2025");
    expect(html).toMatch(/released 15 Jan 2026/);
  });

  it("mixed units are never drawn on one axis", () => {
    const a = analyseMarket([o({ value: 3 }), o({ period_start: "2025-01-01", unit: "sq m", value: 280000 })], [], SRC);
    expect(a.series.map((s) => s.unit).sort()).toEqual(["msf", "sq m"]);
    expect(a.flags.some((f) => f.kind === "mixed_units")).toBe(true);
    const bad = { ...a.series[0], points: [...a.series[0].points, { ...a.series[0].points[0], label: "x", unit: "sq m" }] };
    expect(renderToStaticMarkup(createElement(MarketChart, { s: bad }))).toMatch(/Mixed units .* not drawn/);
  });

  it("inconsistent series are not compared without explanation: definition change", () => {
    const a = analyseMarket([o({ period_start: "2023-01-01", value: 3 }), o({ period_start: "2024-01-01", value: 4, definition: "Net absorption, all grades" })], [], SRC);
    const p = a.series[0].points[1];
    expect(p.change).toBeNull();
    expect(p.note).toMatch(/definition changed/);
    expect(a.flags.some((f) => f.kind === "definition_change")).toBe(true);
  });

  it("geography that only matches by raw name is separated and flagged; an approved alias merges", () => {
    const geos = [{ id: "g1", name: "SBD East", aliases: ["Kharadi-Viman Nagar"] }];
    const a = analyseMarket([o({ geography_id: "g1", geography_raw: null, value: 3 }), o({ period_start: "2025-01-01", value: 5 }), o({ period_start: "2025-01-01", geography_raw: "kharadi-viman nagar", metric: "supply", value: 1 })], geos, SRC);
    const mapped = a.series.find((s) => s.metric === "absorption" && s.geographyStatus === "mapped")!;
    const rawOnly = a.series.find((s) => s.metric === "absorption" && s.geographyStatus === "name_match_only")!;
    expect(mapped.key).not.toBe(rawOnly.key);
    expect(rawOnly.geographySuggestion).toEqual({ id: "g1", name: "SBD East" });
    expect(a.flags.some((f) => f.kind === "geography_name_only")).toBe(true);
    expect(a.series.find((s) => s.metric === "supply")!.geographyStatus).toBe("alias");
    expect(a.series.find((s) => s.metric === "supply")!.geography).toBe("g1");
  });

  it("quarterly and monthly observations are their own series; nothing is silently dropped", () => {
    const obs = [
      o({ period_start: "2025-01-01", value: 6 }),
      o({ period_start: "2025-04-01", period_type: "quarter", value: 1.5 }),
      o({ period_start: "2025-10-01", period_type: "quarter", value: 1.7 }),
      o({ period_start: "2025-11-01", period_type: "month", value: 0.4 }),
      o({ period_start: "2025-04-01", period_type: "quarter", value: 1.4, release_date: "2025-07-01" }), // older release, revised
      o({ period_start: "2025-01-01", value: null }),
    ];
    const a = analyseMarket(obs, [], SRC);
    expect(a.series.map((s) => s.family).sort()).toEqual(["annual", "month", "quarter"]);
    const q = a.series.find((s) => s.family === "quarter")!;
    expect(q.points.map((p) => p.label)).toEqual(["2025 Q2", "2025 Q3", "2025 Q4"]);
    expect(q.points[1].value).toBeNull();
    const charted = new Set(a.series.flatMap((s) => s.points.map((p) => p.observation_id).filter(Boolean)));
    for (const x of obs) expect(charted.has(x.id) || a.excluded.some((e) => e.id === x.id)).toBe(true);
    expect(a.excluded.find((e) => e.id === obs[4].id)!.reason).toMatch(/revised 1.4 → 1.5/);
  });

  it("forecast points are labelled; the 'not a forecast' caveat only when true", () => {
    const a = analyseMarket([o({ value: 3 }), o({ period_start: "2027-01-01", period_type: "forecast", value: 8 })], [], SRC);
    const s = a.series[0];
    expect(s.hasForecast).toBe(true);
    expect(s.points.find((p) => p.is_forecast)!.label).toBe("2027 (forecast)");
    expect(marketDisclaimer(true)).not.toMatch(/not a forecast/);
    expect(marketDisclaimer(false)).toMatch(/not a forecast/);
    expect(caveatsFor(s).join(" ")).toMatch(/source's own forecasts/);
    expect(renderToStaticMarkup(createElement(MarketChart, { s }))).toContain("forecast");
    const facts = factsFromTrend(s.metric, s.geographyLabel, s.points, () => "CBRE");
    expect(facts.find((f) => f.is_forecast)!.text).toMatch(/FORECAST/);
  });

  it("market-note facts carry source + release date; sample size and 'not comprehensive' always shown", () => {
    const a = analyseMarket([o({ value: 3 }), o({ period_start: "2025-01-01", value: 4, source_object_id: "so2", release_date: "2026-02-01" })], [], SRC);
    const s = a.series[0];
    const facts = factsFromTrend(s.metric, s.geographyLabel, s.points, (p) => SRC.get(p.source_object_id!)!.name);
    expect(facts[0].text).toMatch(/Source: CBRE Pune H2 2025, released 2026-01-15/);
    expect(facts[1]).toEqual(expect.objectContaining({ source_name: "JLL Pune Q3 2025", release_date: "2026-02-01" }));
    const c = caveatsFor(s).join(" ");
    expect(c).toMatch(/Sample: 2 observation\(s\) from 2 source release/);
    expect(c).toMatch(/Not comprehensive/);
  });
});

// ------------------------------------------------------------------ content
const EVIDENCE: EvidenceFact[] = [
  { text: "absorption — SBD East — 2025: 4.2 msf (change vs previous comparable period: +0.6) (Source: CBRE Pune H2 2025, released 2026-01-15)", source: "CBRE Pune H2 2025", date: "2026-01-15", kind: "market_note", ref: "n1" },
  { text: "Infosys Ltd leased 0.5 msf in Hinjewadi", source: "ET Realty — https://example.com", date: "2025-11-02", kind: "public_fact", ref: "p1" },
];

describe("Content Editor (20)", () => {
  it("fact check: every number, date, company and claim must match approved evidence; unmatched are listed", () => {
    const ok = factCheck("Absorption in SBD East rose to 4.2 msf in 2025. Infosys Ltd took 0.5 msf.", EVIDENCE);
    expect(ok.unmatched).toEqual([]);
    expect(ok.claims.map((c) => c.kind)).toEqual(expect.arrayContaining(["number", "date", "company", "claim"]));
    const bad = factCheck("Rents rose 12% in Q3 2025. Wipro Technologies signed in March 2026. Absorption fell in 2025.\n1. Check the notice date.", EVIDENCE);
    const u = bad.unmatched.map((c) => `${c.kind}:${c.text}`);
    expect(u).toEqual(expect.arrayContaining(["number:12%", "date:Q3 2025", "company:Wipro Technologies", "date:March 2026"]));
    expect(bad.unmatched.some((c) => c.kind === "claim" && /Rents rose/.test(c.text))).toBe(true);
    expect(bad.unmatched.some((c) => c.kind === "claim" && /Absorption fell/.test(c.text) && /does not show a fall/.test(c.evidence ?? ""))).toBe(true);
    expect(bad.claims.some((c) => c.text === "1")).toBe(false); // list markers are not claims
    const items = reviewChecklist("Rents rose 12% in Q3 2025.", { clientNames: [], hasEvidence: true, channel: "linkedin", factCheck: bad });
    expect(checklistPasses(items)).toBe(false);
  });

  it("brand rules are enforced in checklistPasses (deterministic + hash-bound manual confirmation)", () => {
    expect(parseBrandRule("avoid: synergy, game-changer")).toEqual({ kind: "banned", phrases: ["synergy", "game-changer"] });
    expect(parseBrandRule("max 2 hashtags")).toEqual({ kind: "max_hashtags", n: 2 });
    const rules = ["avoid: synergy", "max 2 hashtags", "no emojis", "Sound like a trusted adviser"];
    const base = { clientNames: [], hasEvidence: false, channel: "linkedin", brandRules: rules };
    const body = "Notice windows matter. #cre #pune #office 🚀 Real synergy.";
    const items = reviewChecklist(body, base);
    expect(items.filter((i) => i.key.startsWith("brand:") && !i.ok)).toHaveLength(4);
    expect(checklistPasses(items)).toBe(false);
    const clean = "Notice windows matter more than expiry dates. #pune";
    expect(checklistPasses(reviewChecklist(clean, base))).toBe(false); // manual rule not yet confirmed
    expect(checklistPasses(reviewChecklist(clean, { ...base, brandConfirmed: true }))).toBe(true);
  });

  it("confidential terms, licensed-content flag and a private-shareable version", () => {
    const items = reviewChecklist("Project Falcon closed at Acme Corp.", { clientNames: ["Acme Corp"], confidentialTerms: ["Project Falcon"], hasEvidence: true, channel: "linkedin", licensed: [{ name: "JLL REIS", permitsPublication: false }] });
    expect(items.find((i) => i.key === "no_confidential_terms")!.ok).toBe(false);
    expect(items.find((i) => i.key === "licensed_content")!.ok).toBe(false);
    const p = privateShareable("Project Falcon closed at Acme Corp. Rent: 95 psf (JLL).", { clientNames: ["Acme Corp"], confidentialTerms: ["Project Falcon"], licensedFacts: ["Rent: 95 psf (JLL)."] });
    expect(p.text).toBe("[confidential] closed at [a client]. [licensed figure — share only under the licence terms]");
  });

  it("weekly plan gives each post a planned publish day", () => {
    expect(weeklyPlan("2026-10-26").map((i) => i.day_offset)).toEqual([1, 3, 2]);
  });
});

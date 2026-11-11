/*
 * contacts_requirements_v1 — generic contact / requirement sheets (Input Engine spec §3.2–3.3).
 *
 * Unlike the tenant workbook adapters (exact header aliases), this role uses SUGGESTED column mapping: every labelled
 * column is scored against the field dictionary (synonyms, keyword hits, and the workspace's learned aliases). The
 * resolved map, ambiguous columns and unmappable columns are reported; unmappable columns are kept raw under their own
 * header name ("custom" fields), so nothing in the sheet is lost. An admin can correct the map once; the correction is
 * remembered (approved adapter_mapping for the exact layout + learned header aliases for future layouts).
 */
import type { ContactRecord, ParsedSheet, RowIssue, RowOutcome, SheetMapResult } from "../types";
import { canonicalOrg, colLetter, exactKey, normHeader } from "../normalize";
import { type Adapter, type RoleInput, RowRecord, issue, quarantine } from "./framework";
import {
  type DateParse, dateColumnConsistency, parseArea, parseDate, parseEmail, parsePhones, parseRent, suspiciousArea, suspiciousRent,
} from "../validate";
import { createHash } from "node:crypto";

export const CONTACTS_ADAPTER = "contacts_requirements_v1";
export const CONTACTS_ROLE = "contacts";

export interface ContactField { key: string; label: string; synonyms: string[]; keywords: string[]; multi?: boolean }
const F = (key: string, label: string, synonyms: string[], keywords: string[] = [], multi = false): ContactField => ({
  key, label, synonyms: synonyms.map(normHeader), keywords, multi,
});

/** Field dictionary. Labels match the spec's "Suggested Database Field" column. */
export const CONTACT_FIELDS: ContactField[] = [
  F("company", "Company Name", ["company", "company name", "client", "client name", "organisation", "organization", "account", "account name", "firm",
    "corporate", "occupier", "customer", "tenant", "tenant name", "client company", "name of company", "company client"], ["company", "client", "organisation", "organization", "firm", "occupier", "tenant", "account"]),
  F("contact_name", "Contact Name", ["contact person", "contact name", "contact", "name", "person", "poc", "spoc", "point of contact", "client contact",
    "representative", "contact person name", "full name", "decision maker", "key contact"], ["person", "poc", "spoc", "representative", "name"]),
  F("designation", "Designation", ["designation", "title", "job title", "role", "position", "function"], ["designation", "title", "role"]),
  F("email", "Email", ["email", "e mail", "email id", "email address", "mail", "mail id", "e mail id", "email ids"], ["email", "mail"], true),
  F("phone", "Phone Number", ["mobile", "phone", "mobile no", "mobile number", "phone no", "phone number", "contact no", "contact number", "cell",
    "telephone", "tel", "whatsapp", "mob", "mob no", "landline", "direct line", "contact details"], ["mobile", "phone", "tel", "cell", "whatsapp", "landline"], true),
  F("required_area", "Required Area", ["office space", "area", "required area", "area required", "space", "space required", "size", "requirement",
    "area sq ft", "area sqft", "area sft", "sq ft", "sqft", "carpet area", "chargeable area", "built up area", "seats", "area requirement", "required space"],
  ["area", "space", "sqft", "sft", "seats", "size"]),
  F("area_unit", "Area Unit", ["unit", "area unit", "uom", "units"], ["unit", "uom"]),
  F("preferred_location", "Preferred Location", ["location", "preferred location", "locality", "micro market", "micromarket", "preferred area",
    "city", "zone", "region", "location preference", "preferred locality", "preferred micro market"], ["location", "locality", "market", "zone", "city"]),
  F("expected_rent", "Expected Rent", ["rent", "expected rent", "budget", "rental", "rent budget", "rate", "quoted rent", "rental budget",
    "budget per sft", "rent per sft", "expected rental"], ["rent", "budget", "rental", "rate"]),
  F("lease_expiry", "Lease Expiry Date", ["expiry", "lease expiry", "expiry date", "lease end", "lease end date", "lease expiry date", "renewal date",
    "current lease expiry", "lease expires"], ["expiry", "expires", "renewal"]),
  F("current_building", "Current Building", ["current building", "building", "current premises", "existing office", "current office", "premises"], ["building", "premises"]),
  F("notes", "Notes", ["notes", "remarks", "comments", "comment", "status", "remark", "next steps", "description"], ["notes", "remark", "comment"], true),
];
const FIELD_BY_KEY = new Map(CONTACT_FIELDS.map((f) => [f.key, f]));
export const isContactField = (k: string) => FIELD_BY_KEY.has(k.split("#")[0]) || k.startsWith("custom:");

export interface ColumnSuggestion {
  column: number;
  letter: string;
  header: string;
  field: string | null; // resolved field key (null = unmapped)
  label: string | null;
  confidence: number; // 0..1
  source: "learned" | "synonym" | "partial" | "keyword" | null;
  alternatives: { field: string; label: string; confidence: number }[];
  ambiguous: boolean;
}

const aliasKey = (field: string) => `${CONTACTS_ADAPTER}:${CONTACTS_ROLE}:${field}`;

function scoreHeader(h: string, f: ContactField, aliases: Record<string, string[]>): { score: number; source: ColumnSuggestion["source"] } {
  if (!h) return { score: 0, source: null };
  if ((aliases[aliasKey(f.key)] ?? []).includes(h)) return { score: 1, source: "learned" };
  if (f.synonyms.includes(h)) return { score: 0.95, source: "synonym" };
  const words = h.split(" ");
  const phrase = f.synonyms.filter((s) => s.includes(" ") && ` ${h} `.includes(` ${s} `)).sort((a, b) => b.length - a.length)[0];
  if (phrase) return { score: 0.8, source: "partial" };
  if (f.keywords.some((k) => words.includes(k))) return { score: 0.65, source: "keyword" };
  if (f.keywords.some((k) => k.length >= 4 && words.some((w) => w.startsWith(k)))) return { score: 0.55, source: "keyword" };
  return { score: 0, source: null };
}

/**
 * Suggest a field for every labelled column. Greedy assignment by confidence; multi-value fields (email/phone/notes)
 * may take several columns ("phone", "phone#2"). A column is AMBIGUOUS when two different fields score >= 0.55 within
 * 0.15 of each other and neither is an exact synonym / learned alias.
 */
export function suggestColumns(headers: string[], aliases: Record<string, string[]> = {}): ColumnSuggestion[] {
  const cols = headers.map((raw, i) => {
    const h = normHeader(raw);
    const scored = CONTACT_FIELDS.map((f) => ({ f, ...scoreHeader(h, f, aliases) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return { i, raw: String(raw ?? ""), h, scored };
  });
  const out: ColumnSuggestion[] = cols.map((c) => ({
    column: c.i, letter: colLetter(c.i), header: c.raw, field: null, label: null, confidence: 0, source: null,
    alternatives: c.scored.slice(0, 3).map((s) => ({ field: s.f.key, label: s.f.label, confidence: s.score })),
    ambiguous: c.scored.length > 1 && c.scored[0].score < 0.95 && c.scored[1].score >= 0.55 && c.scored[0].score - c.scored[1].score < 0.15,
  }));
  const pairs = cols.flatMap((c) => c.scored.map((s) => ({ col: c.i, f: s.f, score: s.score, source: s.source })))
    .filter((p) => p.score >= 0.55).sort((a, b) => b.score - a.score || a.col - b.col);
  const taken = new Map<string, number>();
  const colDone = new Set<number>();
  for (const p of pairs) {
    if (colDone.has(p.col)) continue;
    const n = taken.get(p.f.key) ?? 0;
    if (n > 0 && !p.f.multi) continue;
    taken.set(p.f.key, n + 1);
    colDone.add(p.col);
    Object.assign(out[p.col], { field: n === 0 ? p.f.key : `${p.f.key}#${n + 1}`, label: p.f.label, confidence: p.score, source: p.source });
  }
  return out;
}

export interface ContactsDetection {
  headerRow: number;
  signature: string;
  columnMap: Record<string, number>;
  suggestions: ColumnSuggestion[];
  unmapped: string[];
  ambiguous: string[];
  issues: RowIssue[];
  matched: number;
}

const sig = (labels: string[]) => `hdr:${createHash("sha256").update(labels.map((l) => normHeader(l)).filter(Boolean).join("|")).digest("hex").slice(0, 16)}`;

/** Find the header row (first 10 rows) whose suggestions cover a company or contact column plus >= 2 other fields. */
export function detectContacts(sheet: ParsedSheet, aliases: Record<string, string[]> = {}): ContactsDetection | null {
  let best: ContactsDetection | null = null;
  for (const row of sheet.rows.slice(0, 10)) {
    const nonEmpty = row.cells.filter((c) => c.t !== "null");
    if (nonEmpty.length < 3 || nonEmpty.some((c) => c.t !== "s")) continue;
    const headers = row.cells.map((c) => (c.v === null ? "" : String(c.v)));
    const sugg = suggestColumns(headers, aliases);
    const mapped = sugg.filter((s) => s.field && s.confidence >= 0.55);
    const keys = new Set(mapped.map((s) => s.field!.split("#")[0]));
    if (!(keys.has("company") || keys.has("contact_name")) || keys.size < 3) continue;
    const strong = mapped.filter((s) => s.confidence >= 0.8).length;
    if (strong < 2) continue;
    // fractional penalty: on an exact tie with a built-in tenant adapter, the built-in one wins
    const matched = mapped.length - 0.5;
    if (best && matched <= best.matched) continue;
    const columnMap: Record<string, number> = {};
    for (const s of mapped) columnMap[s.field!] = s.column;
    const unmapped = sugg.filter((s) => s.header.trim() && !s.field).map((s) => `${s.letter}: ${s.header}`);
    const ambiguous = sugg.filter((s) => s.ambiguous && s.header.trim()).map((s) => `${s.letter}: ${s.header} → ${s.alternatives.map((a) => `${a.label} ${Math.round(a.confidence * 100)}%`).join(" / ")}`);
    const issues: RowIssue[] = [];
    if (!keys.has("company")) issues.push(issue("incomplete_mapping", "No column maps to Company Name: rows can only create contacts, not companies or requirements. Map a company column if the sheet has one.", "review"));
    if (ambiguous.length) issues.push(issue("ambiguous_mapping", `Mapping needs a check — these columns could mean more than one field: ${ambiguous.join("; ")}`, "review", { columns: ambiguous }));
    if (unmapped.length) issues.push(issue("unmapped_columns", `Columns not matched to a field are kept as custom values under their own names: ${unmapped.join(", ")}`, "info", { columns: unmapped }));
    const weak = mapped.filter((s) => s.confidence < 0.8 && !s.ambiguous);
    if (weak.length) issues.push(issue("low_confidence_mapping", `Suggested mappings to confirm: ${weak.map((s) => `${s.letter}: ${s.header} → ${s.label} (${Math.round(s.confidence * 100)}%)`).join("; ")}`, "info"));
    best = { headerRow: row.rowNumber, signature: sig(headers), columnMap, suggestions: sugg, unmapped, ambiguous, issues, matched };
  }
  return best;
}

/* ------------------------------------------------------------------ row mapping + validation */

const fieldsOf = (map: Record<string, number>, base: string) => Object.keys(map).filter((k) => k === base || k.startsWith(`${base}#`)).sort();

function mapContacts(input: RoleInput): SheetMapResult {
  const { sheet, columnMap } = input;
  const header = sheet.rows.find((r) => r.rowNumber === input.headerRow);
  const headerOf = (i: number | undefined) => (i === undefined || !header ? null : header.cells[i]?.v == null ? null : String(header.cells[i].v));
  const mappedCols = new Set(Object.values(columnMap));
  // unmapped labelled columns => custom values under their header name (custom column names are supported, never dropped)
  const customCols = header ? header.cells.map((c, i) => ({ i, name: c.v == null ? "" : String(c.v).trim() })).filter((c) => c.name && !mappedCols.has(c.i)) : [];
  const outcomes: RowOutcome[] = [];
  const issues: RowIssue[] = [];
  const expiryParses: { row: number; p: DateParse }[] = [];
  const ref = (key: string, rowNumber: number) => (columnMap[key] === undefined ? null : `${sheet.name}!${colLetter(columnMap[key])}${rowNumber}`);

  for (const row of input.dataRows) {
    const rec = new RowRecord(row, columnMap, []);
    if (rec.isEmpty()) { outcomes.push({ sheet: sheet.name, rowNumber: row.rowNumber, status: "excluded", reason: "blank_row", issues: [] }); continue; }
    const txt = (k: string) => { const c = rec.get(k); if (c.v === null || c.t === "null") return null; const s = String(c.v).replace(/\s+/g, " ").trim(); return s && !/^(na|n\/a|nil|none|-+|tbd|tba)$/i.test(s) ? s : null; };
    const rowIssues: RowIssue[] = [];
    const refs: Record<string, string> = {};
    for (const k of Object.keys(columnMap)) { const r = ref(k, row.rowNumber); if (r && rec.get(k).t !== "null") refs[k] = r; }

    const company = txt("company");
    const contactName = txt("contact_name");
    const emails: string[] = [], phones: string[] = [];
    for (const k of fieldsOf(columnMap, "email")) {
      const e = parseEmail(rec.get(k));
      if (e.value) emails.push(e.value);
      else if (e.raw) rowIssues.push(issue("invalid_email", `Email "${e.raw}" (${refs[k]}) is not a valid address; kept raw, not saved as a contact method`, "review", { raw: e.raw, cell: refs[k] }));
    }
    for (const k of fieldsOf(columnMap, "phone")) {
      const p = parsePhones(rec.get(k));
      phones.push(...p.values.filter((v) => !phones.includes(v)));
      if (p.invalid.length) rowIssues.push(issue("invalid_phone", `Phone "${p.invalid.join(", ")}" (${refs[k]}) is not a valid Indian or international number; kept raw only`, "review", { raw: p.raw, invalid: p.invalid, cell: refs[k] }));
    }
    const unitHint = txt("area_unit");
    const areaCell = rec.get("required_area");
    const area = rec.has("required_area") ? parseArea(areaCell, headerOf(columnMap.required_area), unitHint) : null;
    if (area?.raw && !area.valid) rowIssues.push(issue("invalid_area", `Area "${area.raw}" (${refs.required_area}): ${area.reason}`, "review", { raw: area.raw, cell: refs.required_area }));
    if (area?.min !== null && area?.min !== undefined) {
      if (!area.unit) rowIssues.push(issue("missing_area_unit", `Area ${area.raw} (${refs.required_area}) has no unit; it is NOT assumed to be sq ft. Confirm the unit.`, "review", { raw: area.raw, cell: refs.required_area }));
      if (!area.basis) rowIssues.push(issue("area_basis_unknown", `Area ${area.raw}: carpet / chargeable / built-up basis not stated (kept unknown)`, "info", { cell: refs.required_area }));
      const s = suspiciousArea(area);
      if (s) rowIssues.push(issue("suspicious_number", `Area (${refs.required_area}): ${s}`, "review", { field: "required_area", raw: area.raw, cell: refs.required_area }));
    }
    const rent = rec.has("expected_rent") ? parseRent(rec.get("expected_rent"), headerOf(columnMap.expected_rent)) : null;
    if (rent?.raw && !rent.valid) rowIssues.push(issue("invalid_value", `Rent "${rent.raw}" (${refs.expected_rent}): ${rent.reason}`, "review", { field: "expected_rent", cell: refs.expected_rent }));
    if (rent?.min !== null && rent?.min !== undefined) {
      if (!rent.basis) rowIssues.push(issue("rent_basis_unknown", `Rent ${rent.raw}: basis not stated (per sq ft / per seat / total; CAM not assumed)`, "info", { cell: refs.expected_rent }));
      const s = suspiciousRent(rent);
      if (s) rowIssues.push(issue("suspicious_number", `Rent (${refs.expected_rent}): ${s}`, "review", { field: "expected_rent", raw: rent.raw, cell: refs.expected_rent }));
    }
    let expiry: ContactRecord["lease_expiry"] = null;
    if (rec.has("lease_expiry")) {
      const p = parseDate(rec.get("lease_expiry"));
      if (p.raw) {
        expiryParses.push({ row: row.rowNumber, p });
        expiry = { raw: p.raw, value: p.value, precision: p.precision, ambiguous: p.ambiguous, alternative: p.alternative, fact_status: "reported" };
        if (p.format === "unparsed") rowIssues.push(issue("invalid_date", `Lease expiry "${p.raw}" (${refs.lease_expiry}) is not a recognisable date; kept raw`, "review", { cell: refs.lease_expiry }));
        else if (p.ambiguous) rowIssues.push(issue("ambiguous_date", `Lease expiry "${p.raw}" (${refs.lease_expiry}) could be ${p.value} or ${p.alternative}; read day-first, kept as a reported (unconfirmed) date`, "review", { cell: refs.lease_expiry, value: p.value, alternative: p.alternative }));
        else if (p.precision !== "day") rowIssues.push(issue("date_imprecise", `Lease expiry "${p.raw}" is a ${p.precision}, not a day; no day is invented`, "info", { cell: refs.lease_expiry }));
      }
    }
    const custom: Record<string, unknown> = {};
    for (const k of Object.keys(columnMap).filter((k) => k.startsWith("custom:"))) { const c = rec.get(k); if (c.t !== "null") custom[k.slice(7)] = c.v; }
    for (const c of customCols) { const cell = row.cells[c.i]; if (cell && cell.t !== "null") { custom[c.name] = cell.v; refs[`custom:${c.name}`] = `${sheet.name}!${colLetter(c.i)}${row.rowNumber}`; } }

    const hasReq = !!(area?.min || rent?.min || txt("preferred_location") || expiry);
    if (!company && !contactName) {
      outcomes.push(quarantine(sheet.name, row, "incomplete_row", [issue("incomplete_row", `Row ${row.rowNumber} has neither a company nor a contact name; nothing can be linked`, "review")]));
      continue;
    }
    if (!company) rowIssues.push(issue("missing_company", `Row ${row.rowNumber}: company name is missing${contactName ? ` for ${contactName}` : ""}`, "review"));
    if (company && !contactName && !emails.length && !phones.length && !hasReq) rowIssues.push(issue("incomplete_row", `Row ${row.rowNumber}: only a company name — no contact or requirement details`, "info"));
    if (contactName && !emails.length && !phones.length) rowIssues.push(issue("contact_without_method", `${contactName}: no valid email or phone — the person is proposed for review, not created`, "info"));

    const companyKey = company ? canonicalOrg(company) || exactKey(company) : null;
    const identity = emails[0] ? `email:${emails[0]}` : phones[0] ? `phone:${phones[0]}` : contactName ? `name:${exactKey(contactName)}|org:${companyKey ?? ""}` : `org:${companyKey}`;
    const notes = fieldsOf(columnMap, "notes").map((k) => txt(k)).filter(Boolean).join(" | ") || null;
    const record: ContactRecord = {
      kind: "contact_row", identity_key: identity, company, company_key: companyKey, contact_name: contactName, designation: txt("designation"),
      emails, phones,
      area: area && (area.raw || area.min !== null) ? { raw: area.raw, min: area.min, max: area.max, unit: area.unit, basis: area.basis } : null,
      location: txt("preferred_location"), rent: rent && rent.raw ? { raw: rent.raw, min: rent.min, max: rent.max, basis: rent.basis } : null,
      lease_expiry: expiry, current_building: txt("current_building"), notes, custom, cell_refs: refs, fields: rec.rawFields(),
    };
    for (const [k, v] of Object.entries(custom)) record.fields[`custom:${k}`] = v;
    outcomes.push({ sheet: sheet.name, rowNumber: row.rowNumber, status: "accepted", record, issues: rowIssues, flags: expiry ? ["uncertain_spreadsheet_date"] : [] });
  }

  // column-level date consistency
  const cons = dateColumnConsistency(expiryParses.map((e) => e.p));
  if (cons.inconsistent) {
    issues.push(issue("inconsistent_date_formats", `Lease expiry column mixes date formats (${Object.entries(cons.formats).map(([k, v]) => `${k}: ${v}`).join(", ")})${cons.mixedOrder ? " — both day-first and month-first values appear, so ambiguous dates cannot be trusted" : ""}`, "review", { formats: cons.formats }));
    if (cons.mixedOrder) {
      for (const o of outcomes) {
        const e = (o.record as ContactRecord | undefined)?.lease_expiry;
        if (e?.ambiguous && !o.issues.some((i) => i.kind === "ambiguous_date")) o.issues.push(issue("ambiguous_date", `Lease expiry ${e.raw} is ambiguous in a mixed-format column`, "review"));
      }
    }
  }

  // in-file duplicate detection beyond the identity key: same company under different spellings; same phone/email on different people
  const byCanon = new Map<string, Set<string>>();
  const byPhone = new Map<string, Set<string>>();
  for (const o of outcomes) {
    const r = o.record as ContactRecord | undefined;
    if (!r) continue;
    if (r.company && r.company_key) (byCanon.get(r.company_key) ?? byCanon.set(r.company_key, new Set()).get(r.company_key)!).add(r.company);
    for (const p of [...r.phones, ...r.emails]) (byPhone.get(p) ?? byPhone.set(p, new Set()).get(p)!).add(exactKey(r.contact_name ?? ""));
  }
  for (const o of outcomes) {
    const r = o.record as ContactRecord | undefined;
    if (!r) continue;
    const spellings = r.company_key ? byCanon.get(r.company_key)! : null;
    if (spellings && spellings.size > 1) o.issues.push(issue("possible_duplicate_company", `"${r.company}" appears under ${spellings.size} spellings (${[...spellings].join(" / ")}); treated as one company`, "info", { spellings: [...spellings] }));
    for (const p of [...r.phones, ...r.emails]) {
      const names = byPhone.get(p)!;
      if (names.size > 1) { o.issues.push(issue("possible_duplicate_contact", `${p} is shared by ${[...names].filter(Boolean).join(" / ") || "several rows"}; check whether these are the same person`, "review", { value: p })); break; }
    }
  }
  return { outcomes, controls: [], issues };
}

export const contactsRequirementsV1: Adapter = {
  id: CONTACTS_ADAPTER,
  version: "1.0.0",
  label: "Contacts & requirements",
  roles: [{
    role: CONTACTS_ROLE,
    label: "Contact / requirement list",
    fields: CONTACT_FIELDS.map((f) => ({ key: f.key, label: f.label, headers: f.synonyms, required: false })),
    detect: (sheet, aliases) => {
      const d = detectContacts(sheet, aliases);
      return d ? { headerRow: d.headerRow, signature: d.signature, columnMap: d.columnMap, matched: d.matched, extraColumns: d.unmapped, issues: d.issues } : null;
    },
    map: mapContacts,
  }],
};

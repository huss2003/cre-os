/**
 * Module 8 — quotation intake. A landlord / managed-office operator / fit-out partner quote (PDF, DOCX, text or pasted
 * text) is stored, its text extracted, and commercial terms pulled out by the AI gateway (quote text is passed as
 * untrusted `evidence`; mock mode uses the deterministic regex extractor below). The user reviews the extraction next
 * to the latest saved version, corrects it, and saves it as a NEW quote version (never an overwrite). If the latest
 * version is approved, the new version goes through proposeChange for review instead.
 * Pure helpers (regex extraction, diff, expiry) are exported for unit tests.
 */
import { z } from "zod";
import { callStructured } from "@/lib/ai/gateway";
import { getAiMode, runWithPolicy, type AiMode } from "@/lib/ai/policy";
import { proposeChange } from "@/lib/services/changes";
import { type DealsCtx, DealsError, dbError, must } from "@/modules/deals/ctx";
import { createQuote, reviseQuote } from "@/modules/deals/quotes/service";

export const QuoteExtraction = z.object({
  provider: z.string().nullable(),
  property: z.string().nullable(),
  quote_date: z.string().nullable(),          // ISO yyyy-mm-dd
  valid_until: z.string().nullable(),         // ISO
  rent: z.number().nullable(),
  rent_basis: z.enum(["chargeable", "carpet", "seat"]).nullable(),
  rent_periodicity: z.enum(["monthly", "annual"]).nullable(),
  cam_per_sf: z.number().nullable(),
  cam_included: z.boolean().nullable(),
  parking_per_slot: z.number().nullable(),
  deposit_months: z.number().nullable(),
  escalation_pct: z.number().nullable(),
  escalation_every_months: z.number().nullable(),
  rent_free_months: z.number().nullable(),
  fitout: z.string().nullable(),
  capex_support: z.number().nullable(),
  lockin_months: z.number().nullable(),
  notice_months: z.number().nullable(),
  tenure_months: z.number().nullable(),
  gst: z.enum(["excluded", "included"]).nullable(),
  taxes: z.string().nullable(),
  inclusions: z.string().nullable(),
  exclusions: z.string().nullable(),
  assumptions: z.string().nullable(),
}).strict();
export type QuoteTerms = z.infer<typeof QuoteExtraction>;
export type TermKey = keyof QuoteTerms;

export const TERM_FIELDS: { key: TermKey; label: string; kind: "text" | "number" | "date" | "bool" | "enum"; options?: string[]; essential?: boolean }[] = [
  { key: "provider", label: "Provider", kind: "text", essential: true },
  { key: "property", label: "Property", kind: "text", essential: true },
  { key: "quote_date", label: "Quote date", kind: "date" },
  { key: "valid_until", label: "Valid until", kind: "date", essential: true },
  { key: "rent", label: "Rent (₹ per unit)", kind: "number", essential: true },
  { key: "rent_basis", label: "Rent basis", kind: "enum", options: ["chargeable", "carpet", "seat"], essential: true },
  { key: "rent_periodicity", label: "Rent periodicity", kind: "enum", options: ["monthly", "annual"], essential: true },
  { key: "cam_per_sf", label: "CAM (₹/SF/month)", kind: "number" },
  { key: "cam_included", label: "CAM included in rent", kind: "bool" },
  { key: "parking_per_slot", label: "Parking (₹/slot/month)", kind: "number" },
  { key: "deposit_months", label: "Security deposit (months)", kind: "number", essential: true },
  { key: "escalation_pct", label: "Escalation %", kind: "number", essential: true },
  { key: "escalation_every_months", label: "Escalation every (months)", kind: "number" },
  { key: "rent_free_months", label: "Rent-free (months)", kind: "number" },
  { key: "fitout", label: "Fit-out / handover condition", kind: "text" },
  { key: "capex_support", label: "Fit-out / capex support (₹)", kind: "number" },
  { key: "lockin_months", label: "Lock-in (months)", kind: "number", essential: true },
  { key: "notice_months", label: "Notice (months)", kind: "number" },
  { key: "tenure_months", label: "Tenure (months)", kind: "number" },
  { key: "gst", label: "GST", kind: "enum", options: ["excluded", "included"] },
  { key: "taxes", label: "Taxes (as worded)", kind: "text" },
  { key: "inclusions", label: "Inclusions", kind: "text" },
  { key: "exclusions", label: "Exclusions", kind: "text" },
  { key: "assumptions", label: "Assumptions", kind: "text" },
];

export const emptyTerms = (): QuoteTerms => Object.fromEntries(TERM_FIELDS.map((f) => [f.key, null])) as QuoteTerms;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
/** Parse common Indian quote date formats → ISO, or null (never guessed). */
export function parseDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);       // dd/mm/yyyy
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})[,\s]+(\d{4})/);
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(+m[1])}`; }
  m = t.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(+m[2])}`; }
  return null;
}

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const v = Number(s.replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
};
/** Value after "Label:" on its own line (first match). */
function line(text: string, re: RegExp): string | null {
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(re);
    if (m) return (m[1] ?? "").trim() || null;
  }
  return null;
}
const firstNum = (s: string | null) => num(s?.match(/(\d[\d,]*(?:\.\d+)?)/)?.[1]);
const months = (s: string | null): number | null => {
  if (!s) return null;
  const n = firstNum(s);
  if (n === null) return null;
  return /year|yr/i.test(s) && !/month/i.test(s) ? n * 12 : n;
};

/** "Rs 2.5 lakh" → 250000, "₹1.2 crore" → 12000000, "85" → 85. Multipliers only when written (never assumed). */
export function inrAmount(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|lac|crores?|cr\b|k\b)?/i);
  if (!m) return null;
  const v = num(m[1]); if (v === null) return null;
  const u = (m[2] ?? "").toLowerCase();
  const mul = /^c/.test(u) ? 10_000_000 : /^la/.test(u) ? 100_000 : u === "k" ? 1_000 : 1;
  return Math.round(v * mul * 100) / 100;
}
const WORD_N: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
/** First "N months/years" (digits or words, "three (3) years") in a phrase → months. */
function periodMonths(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/\(?\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b\)?\s*(?:\(\d+\)\s*)?(months?|mths?|years?|yrs?)\b/i);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : WORD_N[m[1].toLowerCase()];
  return /^y/i.test(m[2]) ? n * 12 : n;
}
/** Sentence-level search anywhere in the text (for quotes written as prose, not "Label: value" lines). */
function sentence(text: string, re: RegExp): string | null {
  for (const s of text.split(/(?<=[.;])\s+|\r?\n/)) if (re.test(s)) return s.trim();
  return null;
}

/** Deterministic regex extraction (mock mode + fallback). Missing terms stay null — nothing is invented. */
export function regexExtract(text: string): QuoteTerms {
  const t = emptyTerms();
  const L = (label: string) => new RegExp(`^\\s*(?:${label})\\s*(?::|\\s[-–]\\s)\\s*(.+)$`, "i");
  t.provider = line(text, L("provider|landlord|operator|from|quotation from|quote from|company|partner")) ?? line(text, /^\s*quotation from\s+(.+)$/i);
  t.property = line(text, L("property|building|premises|centre|center|location|site"));
  t.quote_date = parseDate(line(text, L("date|quote date|quotation date|dated")));
  t.valid_until = parseDate(line(text, L("valid until|valid till|validity|valid up to|offer valid till|expires|expiry")));

  const rent = line(text, L("rent|base rent|monthly rent|lease rental|rental|seat price|price per seat|per seat"));
  if (rent) {
    t.rent = inrAmount(rent);
    t.rent_basis = /seat|workstation/i.test(rent) ? "seat" : /carpet/i.test(rent) ? "carpet" : /chargeable|super|built/i.test(rent) ? "chargeable" : null;
    t.rent_periodicity = /annum|annual|year|p\.?a\.?\b/i.test(rent) ? "annual" : /month|p\.?m\.?\b/i.test(rent) ? "monthly" : null;
  }
  const cam = line(text, L("cam|common area maintenance|maintenance"));
  if (cam) {
    if (/includ/i.test(cam) && firstNum(cam) === null) t.cam_included = true;
    else { t.cam_per_sf = firstNum(cam); t.cam_included = /includ/i.test(cam) ? true : t.cam_per_sf !== null ? false : null; }
  }
  t.parking_per_slot = inrAmount(line(text, L("car parking|parking")));
  t.deposit_months = months(line(text, L("security deposit|deposit|refundable deposit")));
  const esc = line(text, L("escalation|rent escalation"));
  if (esc) {
    t.escalation_pct = num(esc.match(/(\d+(?:\.\d+)?)\s*%/)?.[1]);
    const every = esc.match(/(?:every|after|each)\s+(\d+)\s*(year|yr|month)/i);
    t.escalation_every_months = every ? (/(year|yr)/i.test(every[2]) ? +every[1] * 12 : +every[1]) : /annual|year/i.test(esc) ? 12 : null;
  }
  t.rent_free_months = months(line(text, L("rent[- ]free|rent free period|fit-?out period|rent holiday")));
  t.fitout = line(text, L("fit-?out|handover|handover condition|condition"));
  t.capex_support = inrAmount(line(text, L("capex|fit-?out contribution|fit-?out support|landlord contribution|tenant improvement")));
  t.lockin_months = months(line(text, L("lock-?in|lock in period")));
  t.notice_months = months(line(text, L("notice|notice period")));
  t.tenure_months = months(line(text, L("tenure|term|lease term|lease tenure")));
  const tax = line(text, L("gst|taxes|tax"));
  if (tax) { t.taxes = tax; t.gst = /extra|exclu|additional|plus|\+/i.test(tax) ? "excluded" : /inclu/i.test(tax) ? "included" : null; }
  t.inclusions = line(text, L("inclusions|included|includes"));
  t.exclusions = line(text, L("exclusions|excluded|excludes|not included"));
  t.assumptions = line(text, L("assumptions|notes|conditions|terms and conditions"));
  proseFallbacks(text, t);
  return QuoteExtraction.parse(t);
}

/** Terms written in sentences ("The rent is Rs 85 per sq ft per month", "15% escalation every 3 years"). Fills nulls only. */
function proseFallbacks(text: string, t: QuoteTerms) {
  if (t.rent === null) {
    const s = sentence(text, /\b(rent|rental|seat price|per seat)\b[^.\n]{0,60}?(₹|rs\.?|inr)\s*\d/i);
    const m = s?.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?\s*(?:lakhs?|lacs?|crores?|cr\b)?)/i);
    if (s && m) {
      t.rent = inrAmount(m[1]);
      t.rent_basis ??= /seat|workstation/i.test(s) ? "seat" : /carpet/i.test(s) ? "carpet" : /chargeable|super|built/i.test(s) ? "chargeable" : null;
      t.rent_periodicity ??= /annum|annual|per year|p\.a\.?/i.test(s) ? "annual" : /month|p\.m\.?\b/i.test(s) ? "monthly" : null;
    }
  }
  if (t.escalation_pct === null) {
    const s = sentence(text, /escalat|increase/i);
    const m = s?.match(/(\d+(?:\.\d+)?)\s*(?:%|per\s*cent|percent)/i);
    if (s && m) {
      t.escalation_pct = num(m[1]);
      const every = s.match(/(?:every|after|each)\s+(\d+|one|two|three|four|five)\s*(years?|yrs?|months?)/i);
      t.escalation_every_months ??= every ? (/^\d/.test(every[1]) ? +every[1] : WORD_N[every[1].toLowerCase()]) * (/^y/i.test(every[2]) ? 12 : 1) : /annual|every year|per annum|yearly/i.test(s) ? 12 : null;
    }
  }
  if (t.deposit_months === null) t.deposit_months = periodMonths(sentence(text, /\b(security\s+)?deposit\b[^.\n]*\bmonths?\b|\bmonths?'?\s+(?:of\s+)?(?:rent\s+as\s+)?(?:security\s+)?deposit/i));
  if (t.lockin_months === null) { const s = sentence(text, /lock[- ]?in/i); t.lockin_months = periodMonths(s?.slice(s.search(/lock[- ]?in/i)) ?? null); }
  if (t.notice_months === null) { const s = sentence(text, /\bnotice\b/i); t.notice_months = periodMonths(s?.slice(s.search(/\bnotice\b/i)) ?? null); }
  if (t.rent_free_months === null) { const s = sentence(text, /rent[- ]free|rent holiday/i); t.rent_free_months = periodMonths(s?.slice(s.search(/rent[- ]free|rent holiday/i)) ?? null); }
  if (t.tenure_months === null) { const s = sentence(text, /\b(lease\s+)?(term|tenure)\b(?!.*lock)/i); t.tenure_months = periodMonths(s?.slice(s.search(/\b(term|tenure)\b/i)) ?? null); }
  if (t.cam_per_sf === null && t.cam_included === null) {
    const s = sentence(text, /\bCAM\b|common area maintenance|maintenance charges?/i);
    if (s) { const m = s.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)/i); t.cam_per_sf = m ? num(m[1]) : null; t.cam_included = /includ/i.test(s) ? true : t.cam_per_sf !== null ? false : null; }
  }
  if (t.valid_until === null) { const s = sentence(text, /valid (?:until|till|up to)|validity|expires/i); t.valid_until = parseDate(s); }
}

/** Code's extraction is good enough (no AI) when rent + its periodicity and at least two other commercial terms are read. */
export function quoteAccept(t: QuoteTerms): boolean {
  if (t.rent === null || t.rent_periodicity === null) return false;
  const others = [t.deposit_months, t.escalation_pct, t.lockin_months, t.tenure_months, t.cam_per_sf ?? t.cam_included, t.valid_until, t.notice_months];
  return others.filter((v) => v !== null && v !== undefined).length >= 2;
}

/** Map stored quote (terms_json + valid_until column) back to the intake shape for comparison. */
export function termsFromQuote(q: { terms_json?: Record<string, unknown> | null; valid_until?: string | null } | null): QuoteTerms {
  const t = emptyTerms();
  if (!q) return t;
  const j = (q.terms_json ?? {}) as Record<string, unknown>;
  for (const f of TERM_FIELDS) {
    const v = j[f.key];
    if (v === undefined || v === null || v === "") continue;
    (t as Record<string, unknown>)[f.key] = f.kind === "number" ? (Number.isFinite(Number(v)) ? Number(v) : null) : f.kind === "bool" ? v === true || v === "true" : String(v);
  }
  t.valid_until = q.valid_until ?? (t.valid_until as string | null);
  return t;
}

export interface TermDiff { key: TermKey; label: string; before: unknown; after: unknown; status: "same" | "changed" | "added" | "removed" | "missing" }
const blank = (v: unknown) => v === null || v === undefined || v === "";
/** Field-by-field comparison of a new extraction against the latest saved version. Pure. */
export function diffTerms(before: QuoteTerms | null, after: QuoteTerms): { rows: TermDiff[]; changed: TermDiff[]; missing: string[] } {
  const rows: TermDiff[] = TERM_FIELDS.map((f) => {
    const b = before ? before[f.key] : null, a = after[f.key];
    const status: TermDiff["status"] = blank(a) && blank(b) ? "missing" : blank(b) ? (before ? "added" : "same") : blank(a) ? "removed" : String(a) === String(b) ? "same" : "changed";
    return { key: f.key, label: f.label, before: b, after: a, status };
  });
  return {
    rows,
    changed: rows.filter((r) => r.status === "changed" || r.status === "added" || r.status === "removed"),
    missing: TERM_FIELDS.filter((f) => f.essential && blank(after[f.key])).map((f) => f.label),
  };
}

export const isExpired = (validUntil: string | null | undefined, asOf: string) => !!validUntil && validUntil < asOf;
/** Expired quotes first (oldest expiry first), then the rest. Pure. */
export function partitionExpired<T extends { valid_until?: string | null }>(quotes: T[], asOf: string): { expired: T[]; current: T[] } {
  const expired = quotes.filter((q) => isExpired(q.valid_until, asOf)).sort((a, b) => String(a.valid_until).localeCompare(String(b.valid_until)));
  return { expired, current: quotes.filter((q) => !isExpired(q.valid_until, asOf)) };
}

/** Parse the review form back into terms. Blank stays null (S6). */
export function termsFromForm(get: (k: string) => string): QuoteTerms {
  const t = emptyTerms();
  for (const f of TERM_FIELDS) {
    const raw = get(`t_${f.key}`).trim();
    if (!raw) continue;
    let v: unknown = raw;
    if (f.kind === "number") { v = num(raw); if (v === null) throw new Error(`${f.label}: "${raw}" is not a number.`); }
    else if (f.kind === "bool") v = raw === "true" ? true : raw === "false" ? false : null;
    else if (f.kind === "date") { v = parseDate(raw); if (!v) throw new Error(`${f.label}: use a date like 2026-10-31.`); }
    else if (f.kind === "enum" && !f.options!.includes(raw)) throw new Error(`${f.label}: choose one of ${f.options!.join(", ")}.`);
    (t as Record<string, unknown>)[f.key] = v;
  }
  return QuoteExtraction.parse(t);
}

/** terms_json written on the quote row (valid_until lives in its own column). Only known values are written. */
export function toTermsJson(t: QuoteTerms): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TERM_FIELDS) if (f.key !== "valid_until" && !blank(t[f.key])) out[f.key] = t[f.key];
  return out;
}

// ───────────────────────── server services (user-scoped db, RLS enforced) ─────────────────────────

export const QUOTE_BUCKET = "mudar-workspace-files";
export const MAX_QUOTE_BYTES = 20 * 1024 * 1024;
export type PartyKind = "landlord" | "managed_operator" | "fitout_partner" | "other";
type Row = Record<string, any>;

/** Text from an uploaded quote: PDF (unpdf), DOCX (mammoth), TXT. Scanned PDFs return no text + a note (no OCR guess). */
export async function quoteFileText(fileName: string, bytes: Uint8Array): Promise<{ text: string; notes: string[] }> {
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (head.startsWith("%PDF")) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    const t = String(text).trim();
    return t.replace(/\s/g, "").length < 25 ? { text: "", notes: ["The PDF has no text layer (scan?). Paste the quote text below to extract terms."] } : { text: t, notes: [] };
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /\.docx$/i.test(fileName)) {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: r.value.trim(), notes: r.value.trim() ? [] : ["The Word file contains no text."] };
  }
  if (/\.(txt|md|eml)$/i.test(fileName)) return { text: new TextDecoder().decode(bytes), notes: [] };
  throw new DealsError(400, "Unsupported file: upload a PDF, a Word .docx or a .txt file — or paste the text.");
}

/**
 * Code first (docs/ai-policy.md, feature toolkit.quote_intake): regex/sentence extraction; the AI gateway is called only
 * when quoteAccept fails and the workspace mode allows it. The quote text is untrusted evidence. AI values win; code fills
 * fields the AI left null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function extractQuoteTerms(workspaceId: string, text: string, partyKind: PartyKind, opts: { db?: { from: (t: string) => any }; mode?: AiMode } = {}) {
  const mode = opts.mode ?? (opts.db ? await getAiMode(opts.db, workspaceId, "toolkit.quote_intake") : "backup");
  const code = regexExtract(text);
  const out = await runWithPolicy<{ terms: QuoteTerms; model: string | null; mocked: boolean }>({
    mode, code: () => ({ terms: code, model: "rules", mocked: true }), accept: (r) => quoteAccept(r.terms),
    ai: async () => {
      const r = await callStructured({
        workspaceId, workflow: "toolkit.quote_intake", tier: "luna", schema: QuoteExtraction, schemaName: "quote_terms",
        system: "You extract commercial terms from an Indian commercial real-estate quotation (landlord, managed-office operator or fit-out partner). Copy values as stated; convert dates to ISO yyyy-mm-dd; months as numbers. Use null for anything not stated. Do not compute or derive amounts.",
        input: `Party type: ${partyKind}. Extract every field of the schema from the quotation in the evidence.`,
        evidence: text.slice(0, 60_000),
        mock: () => code,
      });
      const merged = { ...r.data } as Record<string, unknown>;
      for (const [k, v] of Object.entries(code)) if (merged[k] === null || merged[k] === undefined) merged[k] = v;
      return { terms: QuoteExtraction.parse(merged), model: r.model, mocked: r.mocked };
    },
  });
  const v = out.value ?? { terms: code, model: "rules", mocked: true };
  return { ...v, source: out.source };
}

export async function createIntake(ctx: DealsCtx, i: { requirementId: string | null; quoteId: string | null; spaceId?: string | null; partyKind: PartyKind; storagePath: string | null; fileName: string | null; text: string; notes?: string[] }) {
  if (i.storagePath && !i.storagePath.startsWith(`${ctx.workspaceId}/quotes/`)) throw new DealsError(400, "invalid upload path");
  let requirementId = i.requirementId;
  if (i.quoteId) {
    // always compare against the current latest version of the chain
    let q = must(await ctx.db.from("quote").select("id, requirement_id, superseded_by").eq("id", i.quoteId).maybeSingle(), "quote") as Row;
    for (let n = 0; q.superseded_by && n < 50; n++) q = must(await ctx.db.from("quote").select("id, requirement_id, superseded_by").eq("id", q.superseded_by).maybeSingle(), "quote") as Row;
    i = { ...i, quoteId: String(q.id) };
    requirementId = q.requirement_id;
  }
  if (!requirementId) throw new DealsError(400, "Choose the requirement this quote is for (or an existing quote to update).");
  const notes = [...(i.notes ?? [])];
  const ext = i.text.trim() ? await extractQuoteTerms(ctx.workspaceId, i.text, i.partyKind, { db: ctx.db }) : { terms: emptyTerms(), model: null, mocked: false, source: "none" as const };
  if (!i.text.trim()) notes.push("No text to extract from — fill the terms in by hand.");
  if (ext.source !== "none" && ext.mocked) notes.push(ext.source === "ai" ? "AI is not configured: terms were extracted with simple pattern matching. Check every field." : "Terms were read with pattern matching (no AI). Check every field.");
  const r = await ctx.db.from("quote_intake").insert({
    workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, requirement_id: requirementId, quote_id: i.quoteId, space_id: i.quoteId ? null : i.spaceId ?? null, party_kind: i.partyKind,
    storage_path: i.storagePath, file_name: i.fileName, source_text: i.text.slice(0, 200_000), extracted: ext.terms, extraction_model: ext.model, notes,
  }).select("id").single();
  if (r.error) throw dbError(r.error, "quote_intake");
  return r.data as { id: string };
}

export async function loadIntake(ctx: DealsCtx, id: string) {
  const intake = (await ctx.db.from("quote_intake").select("*, requirement:requirement_id(title)").eq("workspace_id", ctx.workspaceId).eq("id", id).maybeSingle()).data as Row | null;
  if (!intake) return null;
  let latest: Row | null = null;
  if (intake.quote_id) {
    // follow the supersession chain to the current latest version
    let q = (await ctx.db.from("quote").select("*").eq("id", intake.quote_id).maybeSingle()).data as Row | null;
    for (let n = 0; q?.superseded_by && n < 50; n++) q = (await ctx.db.from("quote").select("*").eq("id", q.superseded_by).maybeSingle()).data as Row | null;
    latest = q;
  }
  return { intake, latest };
}

/** Save the reviewed terms as a NEW quote version (or a new quote). Approved quotes → change proposal for review. */
export async function saveIntakeVersion(ctx: DealsCtx, intakeId: string, terms: QuoteTerms) {
  const loaded = await loadIntake(ctx, intakeId);
  if (!loaded) throw new DealsError(404, "intake not found");
  const { intake, latest } = loaded;
  if (intake.status !== "review") throw new DealsError(409, `This intake is already ${intake.status}.`);
  const evidence = `Quote intake ${String(intake.id).slice(0, 8)}${intake.file_name ? ` — ${intake.file_name}` : " — pasted text"}${intake.storage_path ? ` (${QUOTE_BUCKET}/${intake.storage_path})` : ""}`;
  const termsJson = { ...toTermsJson(terms), party_kind: intake.party_kind };
  if (latest?.approved_at) {
    const patch = [
      { op: "add" as const, path: "/requirement_id", value: latest.requirement_id },
      ...(latest.space_id ? [{ op: "add" as const, path: "/space_id", value: latest.space_id }] : []),
      ...(latest.counterparty_org_id ? [{ op: "add" as const, path: "/counterparty_org_id", value: latest.counterparty_org_id }] : []),
      { op: "add" as const, path: "/version", value: Number(latest.version) + 1 },
      { op: "add" as const, path: "/terms_json", value: { ...(latest.terms_json ?? {}), ...termsJson } },
      { op: "add" as const, path: "/valid_until", value: terms.valid_until },
      { op: "add" as const, path: "/evidence", value: evidence },
    ];
    const cp = await proposeChange(ctx.db, ctx.workspaceId, { targetType: "quote", operation: "create", patch, proposedByKind: "user", ownerUserId: ctx.userId,
      reason: `Revised quote v${Number(latest.version) + 1} from intake (v${latest.version} is approved, so the new version needs review)`, classification: String(latest.classification ?? "corporate_confidential"), idempotencyKey: `quote_intake:${intake.id}` });
    await ctx.db.from("quote_intake").update({ status: "proposed", change_proposal_id: (cp as Row)?.id ?? null, extracted: terms }).eq("id", intake.id);
    return { mode: "proposed" as const, proposalId: (cp as Row)?.id ?? null };
  }
  const q = latest
    ? await reviseQuote(ctx, String(latest.id), { terms: termsJson, validUntil: terms.valid_until, evidence })
    : await createQuote(ctx, { requirementId: String(intake.requirement_id), spaceId: intake.space_id ?? null, terms: termsJson, validUntil: terms.valid_until, evidence });
  await ctx.db.from("quote_intake").update({ status: "saved", result_quote_id: (q as Row).id, extracted: terms }).eq("id", intake.id);
  return { mode: latest ? "revised" as const : "created" as const, quote: q as Row };
}

/** Latest version of every quote in the workspace (expired ones separated) + recent intakes. */
export async function listIntakeOverview(ctx: DealsCtx, asOf: string) {
  const [qs, intakes] = await Promise.all([
    ctx.db.from("quote").select("id, version, valid_until, terms_json, approved_at, requirement_id, requirement:requirement_id(title), updated_at").eq("workspace_id", ctx.workspaceId).is("superseded_by", null).is("archived_at", null).order("updated_at", { ascending: false }).limit(200),
    ctx.db.from("quote_intake").select("id, status, party_kind, file_name, created_at, requirement:requirement_id(title), result_quote_id").eq("workspace_id", ctx.workspaceId).is("archived_at", null).order("created_at", { ascending: false }).limit(30),
  ]);
  const { expired, current } = partitionExpired((qs.data ?? []) as Row[], asOf);
  return { expired, current, intakes: (intakes.data ?? []) as Row[] };
}

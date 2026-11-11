/**
 * Business-card parser over OCR text. Pure and deterministic. Never invents: every value is a verbatim
 * substring of the card text (normalised whitespace only); a field that is not clearly present stays null.
 * Phones are typed from their own label (Tel/Board/EPABX => switchboard, D/Direct/DID => direct, M/Mob/Cell => mobile);
 * an unlabelled Indian 10-digit number starting 6-9 is "mobile", an unlabelled landline is "unknown" (never assumed direct).
 */
export type PhoneType = "switchboard" | "direct" | "mobile" | "fax" | "unknown";
export interface CardPhone { value: string; digits: string; type: PhoneType; label: string | null; line: string }
export interface ParsedCard {
  name: string | null; title: string | null; company: string | null;
  emails: string[]; phones: CardPhone[]; website: string | null;
  /** office address lines (verbatim) — pin code / road / floor / city words; null when not clearly present */
  address: string | null;
  lines: string[]; unparsed: string[];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL = /\b(?:https?:\/\/)?(?:www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s]*)?/i;
const PHONE = /(\+?\d[\d\s().\/-]{7,}\d)/g;
const TITLE_WORDS = /\b(director|manager|head|vp|vice president|president|ceo|cfo|coo|cto|founder|partner|associate|executive|officer|lead|consultant|analyst|adviser|advisor|chairman|md|gm|agm|dgm|avp|svp|evp|principal|specialist|engineer|architect|broker)\b/i;
const COMPANY_WORDS = /\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|corp\.?|corporation|llc|group|realty|properties|estates?|developers?|infra|technologies|solutions|services|advisors|advisory|consultants|holdings|& co\.?|gmbh|plc)\b/i;

const ADDRESS = /\b(road|rd\.?|marg|street|st\.?|lane|floor|flr|tower|plot|sector|nagar|park|chowk|wing|building|bldg|pune|mumbai|bengaluru|bangalore|hyderabad|chennai|delhi|gurgaon|gurugram|noida|maharashtra|india|pin)\b/i;

/** Fields a reviewer should check: missing, ambiguous phone type, unreadable lines, email domain unlike the website. */
export function uncertainCardFields(c: ParsedCard): { field: string; reason: string }[] {
  const out: { field: string; reason: string }[] = [];
  if (!c.name) out.push({ field: "name", reason: "no clear name line" });
  if (!c.title) out.push({ field: "designation", reason: "not found" });
  if (!c.company) out.push({ field: "company", reason: "not found (email domain is not used to guess it)" });
  if (!c.emails.length) out.push({ field: "email", reason: "not found" });
  for (const p of c.phones) if (p.type === "unknown") out.push({ field: `phone ${p.value}`, reason: "unlabelled — could be direct or switchboard" });
  if (c.website && c.emails.length) {
    const site = c.website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
    if (!c.emails.some((e) => e.split("@")[1] === site)) out.push({ field: "email", reason: `domain differs from website ${site}` });
  }
  if (c.unparsed.length) out.push({ field: "other text", reason: `${c.unparsed.length} line(s) not understood: ${c.unparsed.slice(0, 3).join(" | ")}` });
  return out;
}

function phoneType(label: string | null, digits: string): PhoneType {
  const l = (label ?? "").toLowerCase();
  if (/fax/.test(l)) return "fax";
  if (/\b(m|mob|mobile|cell|c)\b/.test(l)) return "mobile";
  if (/\b(d|dir|direct|did|dl)\b/.test(l)) return "direct";
  if (/\b(t|tel|telephone|board|epabx|office|o|ph|phone|switchboard)\b/.test(l)) return l === "ph" || l === "phone" ? "unknown" : "switchboard";
  const local = digits.replace(/^(91|0)(?=\d{10}$)/, "");
  if (local.length === 10 && /^[6-9]/.test(local)) return "mobile";
  return "unknown";
}

export function parseBusinessCard(text: string): ParsedCard {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const used = new Set<number>();
  const emails: string[] = []; const phones: CardPhone[] = []; let website: string | null = null;
  lines.forEach((line, i) => {
    const em = line.match(EMAIL);
    if (em) { for (const e of em) if (!emails.includes(e.toLowerCase())) emails.push(e.toLowerCase()); used.add(i); }
    const stripped = line.replace(EMAIL, " ");
    const w = stripped.match(URL);
    if (w && !website) { website = w[0]; used.add(i); }
    // phones: split the line on labels so "T: 020 1234 5678 | M: 98220 12345" yields two typed numbers
    const parts = stripped.replace(URL, " ").split(/\s*[|,;]\s*|\s{2,}|(?=\b(?:Tel|T|M|Mob|Mobile|Cell|D|Direct|DID|Fax|F|Board|EPABX|Ph|Phone|Office|O)\s*[:.]\s*\+?\d)/i);
    for (const part of parts) {
      const lab = part.match(/^\s*(Tel|Telephone|T|M|Mob|Mobile|Cell|C|D|Dir|Direct|DID|DL|Fax|F|Board|EPABX|Ph|Phone|Office|O)\s*[:.]?\s*(?=\+?\d)/i);
      for (const m of part.matchAll(PHONE)) {
        const value = m[1].trim(); const digits = value.replace(/\D/g, "");
        if (digits.length < 8 || digits.length > 15) continue;
        if (/^(19|20)\d{2}$/.test(digits)) continue;
        if (phones.some((p) => p.digits === digits)) continue;
        const label = lab ? lab[1] : null;
        const t = label && /^f(ax)?$/i.test(label) ? "fax" : phoneType(label, digits);
        phones.push({ value, digits, type: t, label, line });
        used.add(i);
      }
    }
  });
  // name/title/company from the remaining lines — only when the line clearly is one
  const rest = lines.map((l, i) => ({ l, i })).filter(({ i }) => !used.has(i));
  let title: string | null = null; let company: string | null = null; let name: string | null = null;
  const titleRow = rest.find(({ l }) => TITLE_WORDS.test(l) && l.split(" ").length <= 8);
  if (titleRow) { title = titleRow.l; used.add(titleRow.i); }
  const compRow = rest.find(({ l, i }) => !used.has(i) && COMPANY_WORDS.test(l));
  if (compRow) { company = compRow.l; used.add(compRow.i); }
  // a person's name: 2–4 capitalised words, letters only (plus . and '), not a title/company line
  const nameRow = rest.find(({ l, i }) => !used.has(i) && /^(?:(?:Mr|Ms|Mrs|Dr)\.?\s+)?[A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){1,3}$/.test(l) && !TITLE_WORDS.test(l) && !COMPANY_WORDS.test(l));
  if (nameRow) { name = nameRow.l.replace(/^(Mr|Ms|Mrs|Dr)\.?\s+/, ""); used.add(nameRow.i); }
  // address: lines with a PIN code or clear address words (kept verbatim, joined)
  const addrRows = rest.filter(({ l, i }) => !used.has(i) && (ADDRESS.test(l) || /\b\d{3}\s?\d{3}\b/.test(l)));
  for (const r of addrRows) used.add(r.i);
  const address = addrRows.length ? addrRows.map((r) => r.l).join(", ") : null;
  // company fallback: email domain is NOT used to invent a company name (unknown stays unknown)
  return { name, title, company, emails, phones, website, address, lines, unparsed: lines.filter((_, i) => !used.has(i)) };
}

/** contact_method rows to propose for a parsed card (verify_status from the phone type; nothing verified). */
export function cardContactMethods(c: ParsedCard): { method_type: "email" | "phone"; value: string; verify_status: string; label: string }[] {
  const out: { method_type: "email" | "phone"; value: string; verify_status: string; label: string }[] = [];
  for (const e of c.emails) out.push({ method_type: "email", value: e, verify_status: "unverified", label: "email (from business card)" });
  for (const p of c.phones) {
    if (p.type === "fax") continue;
    out.push({ method_type: "phone", value: p.value, verify_status: p.type === "switchboard" ? "switchboard" : p.type === "mobile" ? "business_mobile" : "unverified", label: `${p.type} phone (from business card${p.label ? `, labelled "${p.label}"` : ""})` });
  }
  return out;
}

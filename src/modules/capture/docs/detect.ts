/**
 * Document-type detection for the Capture drop zone — deterministic first (file type + keywords).
 * Pure: no I/O. The service only asks the model (callStructured, with a deterministic mock) when this returns
 * `ambiguous: true`, and even then the model may only pick one of the listed types.
 */
export const DOC_TYPES = ["quotation", "lease", "loi", "meeting_notes", "business_card", "property_photo", "layout", "spreadsheet", "audio", "unknown"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type FileFamily = "pdf" | "docx" | "image" | "spreadsheet" | "audio" | "text" | "unsupported";

export interface Detection { type: DocType; family: FileFamily; confidence: number; method: "rules" | "model" | "user"; signals: string[]; ambiguous: boolean; candidates: DocType[] }

const EXT = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "");

export function fileFamily(name: string, mime: string, head?: Uint8Array): FileFamily {
  const ext = EXT(name); const m = (mime || "").toLowerCase();
  if (head && head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "docx" || m.includes("wordprocessingml")) return "docx";
  if (["xlsx", "csv", "tsv"].includes(ext) || m.includes("spreadsheetml") || m === "text/csv") return "spreadsheet";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif"].includes(ext)) return "image";
  if (m.startsWith("audio/") || ["mp3", "m4a", "wav", "webm", "ogg", "oga", "aac", "mp4", "mpga", "mpeg", "flac"].includes(ext)) return "audio";
  if (["txt", "md", "eml"].includes(ext) || m.startsWith("text/")) return "text";
  return "unsupported";
}

const RULES: { type: DocType; re: RegExp; w: number }[] = [
  { type: "quotation", re: /\b(quotation|quote|proposal for|commercial (offer|proposal)|rate card|per seat|seat price|validity of (this )?(offer|quote)|valid (till|until)|fit[- ]?out cost|BOQ)\b/gi, w: 1 },
  { type: "lease", re: /\b(lease deed|leave and licen[cs]e|licen[cs]or|licen[cs]ee|lessor|lessee|lock[- ]?in|security deposit|escalation|demised premises|registration|stamp duty|term of (the )?(lease|licen[cs]e))\b/gi, w: 1 },
  { type: "loi", re: /\b(letter of intent|LOI|term sheet|non[- ]binding|binding offer|heads of terms)\b/gi, w: 1.5 },
  { type: "meeting_notes", re: /\b(minutes of (the )?meeting|MoM|attendees|action items?|next steps|discussed|follow[- ]?up|site visit notes?|agenda)\b/gi, w: 1 },
  { type: "business_card", re: /(\bTel\b|\bMob(ile)?\b|\bM:|\bT:|\bE:|@[a-z0-9-]+\.[a-z]{2,}|www\.[a-z0-9-]+\.[a-z.]{2,}|\bDirector\b|\bManager\b|\bHead\b|\bVP\b|\bCEO\b)/gi, w: 0.6 },
  { type: "layout", re: /\b(floor ?plan|layout|test fit|carpet area|super built[- ]?up|workstations?|cabins?|meeting rooms?|plan view|scale 1:)\b/gi, w: 1 },
];

function score(text: string): Map<DocType, { s: number; hits: string[] }> {
  const out = new Map<DocType, { s: number; hits: string[] }>();
  for (const r of RULES) {
    const hits = [...text.matchAll(r.re)].map((m) => m[0]);
    if (!hits.length) continue;
    const uniq = [...new Set(hits.map((h) => h.toLowerCase()))];
    const cur = out.get(r.type) ?? { s: 0, hits: [] };
    cur.s += uniq.length * r.w; cur.hits.push(...uniq);
    out.set(r.type, cur);
  }
  return out;
}

export interface DetectInput {
  name: string; mime: string; head?: Uint8Array; text?: string | null; caption?: string | null; userType?: DocType | null;
  /** Whole file (or at least its first ~64 KB) — used to read image pixel dimensions. */
  bytes?: Uint8Array;
  /** File size in bytes (defaults to bytes.length). */
  size?: number;
}

/** Pixel size from PNG (IHDR) or JPEG (SOFn) bytes; null when unreadable. Pure, no decoding. */
export function imageSize(b: Uint8Array | undefined): { width: number; height: number } | null {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const w = u32(16), h = u32(20);
    return w && h ? { width: w, height: h } : null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const len = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[o + 5] << 8) | b[o + 6], w = (b[o + 7] << 8) | b[o + 8];
        return w && h ? { width: w, height: h } : null;
      }
      if (len < 2) return null;
      o += 2 + len;
    }
  }
  return null;
}

const CARD_NAME = /\b(card|cards|visiting|business|vcard|contact)\b/i;
const PHOTO_NAME = /\b(photo|pic|building|facade|fa\u00e7ade|exterior|interior|site|tower|lobby|campus|dsc|dscn|img|pxl|whatsapp image)\b/i;
const TITLE = /\b(Director|Manager|Head|VP|Vice President|CEO|CFO|CTO|COO|Founder|Partner|Associate|Consultant|Executive|Officer|Lead|President)\b/;

function detectImage(input: DetectInput, s: Map<DocType, { s: number; hits: string[] }>, base: { family: FileFamily; method: "rules"; ambiguous: boolean }): Detection {
  const t = input.text ?? "";
  const words = t.split(/\s+/).filter(Boolean).length;
  const hasEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.test(t);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(t);
  const hasTitle = TITLE.test(t);
  // 1) readable text decides first
  if ((hasEmail || hasPhone) && words <= 80) {
    const sig = [hasEmail ? "email on image" : "", hasPhone ? "phone on image" : "", hasTitle ? "job title on image" : ""].filter(Boolean);
    return { ...base, type: "business_card", confidence: hasEmail && hasPhone ? 0.9 : 0.75, signals: sig, candidates: ["business_card"] };
  }
  if ((s.get("layout")?.s ?? 0) >= 1) return { ...base, type: "layout", confidence: 0.75, signals: s.get("layout")!.hits, candidates: ["layout"] };
  if ((s.get("quotation")?.s ?? 0) >= 2) return { ...base, type: "quotation", confidence: 0.6, signals: s.get("quotation")!.hits, candidates: ["quotation"] };

  // 2) file cues: filename words, pixel aspect ratio, file size
  const fname = `${input.name.replace(/[_.-]+/g, " ")} ${input.caption ?? ""}`;
  const dims = imageSize(input.bytes ?? input.head);
  const size = input.size ?? input.bytes?.length;
  const ratio = dims ? Math.max(dims.width, dims.height) / Math.min(dims.width, dims.height) : null;
  const card: string[] = []; const photo: string[] = [];
  if (CARD_NAME.test(fname)) card.push("file name says card");
  if (ratio !== null && ratio >= 1.5 && ratio <= 1.9) card.push(`card-shaped (${dims!.width}×${dims!.height})`);
  if (size !== undefined && size > 0 && size < 400_000) card.push("small file");
  if (hasTitle && words <= 40) card.push("job title on image");
  if (PHOTO_NAME.test(fname)) photo.push("file name says photo");
  if (size !== undefined && size > 1_500_000) photo.push("large camera-size file");
  if (dims && dims.width > dims.height && ratio! >= 1.25 && ratio! < 1.45) photo.push("camera landscape shape");
  if (dims && Math.max(dims.width, dims.height) >= 2400) photo.push("high-resolution");

  const cardName = card.includes("file name says card"), photoName = photo.includes("file name says photo");
  if (cardName && !photoName) return { ...base, type: "business_card", confidence: card.length >= 2 ? 0.8 : 0.65, signals: card, candidates: ["business_card"] };
  if (photoName && !cardName && photo.length >= 1 && card.length <= 1) return { ...base, type: "property_photo", confidence: photo.length >= 2 ? 0.75 : 0.6, signals: photo, candidates: ["property_photo", "layout"] };
  if (!cardName && !photoName && photo.length >= 2 && card.length === 0) return { ...base, type: "property_photo", confidence: 0.6, signals: photo, candidates: ["property_photo", "layout"] };
  if (!cardName && !photoName && card.length >= 2 && photo.length === 0) return { ...base, type: "business_card", confidence: 0.55, signals: card, candidates: ["business_card", "property_photo"] };
  // not sure: ask the user rather than guess
  return { ...base, type: "unknown", confidence: 0, ambiguous: true, signals: [...card, ...photo].length ? [...card, ...photo] : [t.trim() ? "little readable text" : "no readable text"], candidates: ["business_card", "property_photo", "layout"] };
}

/** Deterministic detection. `text` = extracted text (PDF/DOCX/TXT) or OCR text (images); `caption` = user hint. */
export function detectDocType(input: DetectInput): Detection {
  const family = fileFamily(input.name, input.mime, input.head);
  const base = { family, method: "rules" as const, ambiguous: false };
  if (input.userType && input.userType !== "unknown") return { ...base, type: input.userType, confidence: 1, method: "user", signals: ["chosen by user"], candidates: [input.userType] };
  if (family === "spreadsheet") return { ...base, type: "spreadsheet", confidence: 1, signals: [`file type ${EXT(input.name) || input.mime}`], candidates: ["spreadsheet"] };
  if (family === "audio") return { ...base, type: "audio", confidence: 1, signals: [`file type ${EXT(input.name) || input.mime}`], candidates: ["audio"] };
  if (family === "unsupported") return { ...base, type: "unknown", confidence: 0, signals: ["unsupported file type"], candidates: [] };

  const text = `${input.name.replace(/[_-]+/g, " ")}\n${input.caption ?? ""}\n${input.text ?? ""}`;
  const s = score(text);
  if (family === "image") return detectImage(input, s, base);
  // documents (pdf/docx/text)
  const ranked = [...s.entries()].filter(([k]) => k !== "business_card").sort((a, b) => b[1].s - a[1].s);
  if (!ranked.length) return { ...base, type: "unknown", confidence: 0, ambiguous: true, signals: ["no keywords"], candidates: ["quotation", "lease", "loi", "meeting_notes"] };
  const [top, second] = ranked;
  // an LOI usually talks about lease terms too: LOI wins when its own markers are present
  if (s.has("loi") && (top[0] === "lease" || top[0] === "loi")) return { ...base, type: "loi", confidence: 0.85, signals: s.get("loi")!.hits, candidates: ["loi"] };
  const margin = second ? top[1].s - second[1].s : top[1].s;
  const ambiguous = top[1].s < 2 || margin < 1;
  return { ...base, type: top[0], confidence: ambiguous ? 0.45 : Math.min(0.95, 0.55 + 0.1 * top[1].s), ambiguous, signals: top[1].hits.slice(0, 8), candidates: ranked.slice(0, 3).map(([k]) => k) };
}

/** Where each type goes (the existing extractor). */
export const ROUTE: Record<DocType, string> = {
  quotation: "Quote intake (deal toolkit)", lease: "Lease terms extraction", loi: "Lease terms extraction (LOI)", meeting_notes: "Capture (debrief extraction)",
  business_card: "Contact card parser", property_photo: "Attach to building / visit", layout: "Attach to building / visit", spreadsheet: "Imports pipeline",
  audio: "Transcription → capture", unknown: "Needs your choice",
};
export const TYPE_LABEL: Record<DocType, string> = {
  quotation: "Quotation", lease: "Lease / licence", loi: "LOI / term sheet", meeting_notes: "Meeting notes", business_card: "Business card",
  property_photo: "Property photo", layout: "Layout / floor plan", spreadsheet: "Spreadsheet", audio: "Recording", unknown: "Unknown",
};

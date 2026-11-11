import JSZip from "jszip";

/**
 * PowerPoint (.pptx) and legacy Office (.doc / .ppt) text for the Input Engine (spec §2.5).
 * PPTX: one "page" per slide (page references = slide numbers). Legacy binary files: best-effort text runs
 * (UTF-16LE + ASCII) — flagged so the review screen says the reading may be incomplete; nothing is guessed.
 */
export async function pptxSlides(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const out: string[] = [];
  for (const n of slides) {
    const xml = await zip.file(n)!.async("string");
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("")).filter((t) => t.trim());
    out.push(paras.join("\n"));
  }
  return out;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Printable text runs from an OLE (.doc/.ppt) file. Short runs and binary noise are dropped. */
export function legacyOfficeText(bytes: Uint8Array): string {
  const runs: string[] = [];
  // UTF-16LE runs (Word/PowerPoint store most text this way)
  let cur = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if ((code >= 0x20 && code < 0x7f) || code === 0x0d || code === 0x0a || code === 0x09 || code === 0x20b9 || (code >= 0x0900 && code <= 0x097f)) cur += code === 0x0d ? "\n" : String.fromCharCode(code);
    else { if (cur.trim().length >= 6) runs.push(cur); cur = ""; }
  }
  if (cur.trim().length >= 6) runs.push(cur);
  if (!runs.length) {
    let a = "";
    for (const b of bytes) {
      if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d) a += String.fromCharCode(b);
      else { if (a.trim().length >= 6) runs.push(a); a = ""; }
    }
    if (a.trim().length >= 6) runs.push(a);
  }
  return runs.map((r) => r.replace(/[ \t]+/g, " ").trim()).filter((r) => /[A-Za-z]{3,}/.test(r)).join("\n");
}

export const isOle = (head: Uint8Array) => head.length >= 4 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;

/** Shown on every receipt / batch item for a legacy binary Office file (the original is always kept). */
export const LEGACY_FORMAT_NOTE = "Old format — save as .docx/.pptx/.xlsx for full extraction";
export const legacyNote = (fileName: string) => `${LEGACY_FORMAT_NOTE}. "${fileName}" is kept as uploaded; anything read from it is best effort and flagged.`;
/**
 * Scanned PDF (no text layer). Images are OCR'd through the gateway, but PDF pages would first need rendering to an
 * image and no renderer is installed (unpdf's renderPageAsImage needs @napi-rs/canvas, which is not a dependency).
 */
export const SCANNED_PDF_NOTE = "This PDF has no text layer (scanned). Page OCR needs a PDF page renderer that isn't installed — type the key terms below, or upload photos/screenshots of the pages (photos are read by OCR). The original PDF is kept.";
export const isLegacyOfficeName = (name: string) => /\.(doc|ppt|xls)$/i.test(name);

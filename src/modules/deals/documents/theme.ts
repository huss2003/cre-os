/**
 * Read brand cues from an uploaded master .pptx / .docx (tenant template). Carried over: theme colours (accent1 →
 * primary, accent2 → accent; dk2 as fallback), theme fonts (minor → body, major → headings) and the logo image used
 * on the slide master / page header. NOT carried over: slide layouts and placeholders, master backgrounds, Word
 * styles, page setup, header/footer text, macros, embedded fonts. The file is parsed as data only (no macros run).
 */
import JSZip from "jszip";

export interface TemplateTheme {
  primary?: string; accent?: string; font?: string; headingFont?: string;
  logo?: { data: string; type: "png" | "jpg" | "gif"; width: number; height: number } | null;
  carried: string[]; notCarried: string[]; warnings: string[];
}

export const NOT_CARRIED = ["slide layouts and placeholders", "master backgrounds and decorative shapes", "Word paragraph/table styles",
  "page size and margins", "header/footer text", "macros and embedded fonts"];
const MAX_LOGO_BYTES = 1_500_000;

function themeColor(xml: string, name: string): string | undefined {
  const m = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(xml);
  if (!m) return undefined;
  const srgb = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]);
  if (srgb) return srgb[1].toUpperCase();
  const sys = /<a:sysClr [^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]);
  return sys ? sys[1].toUpperCase() : undefined;
}
function themeFont(xml: string, which: "majorFont" | "minorFont"): string | undefined {
  const m = new RegExp(`<a:${which}>[\\s\\S]*?<a:latin typeface="([^"]*)"`).exec(xml);
  const v = m?.[1]?.trim();
  return v && !v.startsWith("+") ? v : undefined;
}

/** Pixel size of PNG / JPEG / GIF from the header bytes (no image library). */
export function imageSize(buf: Buffer): { type: "png" | "jpg" | "gif"; width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") return { type: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "jpg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

async function relTargets(zip: JSZip, relsPath: string, baseDir: string): Promise<string[]> {
  const f = zip.file(relsPath);
  if (!f) return [];
  const xml = await f.async("string");
  return [...xml.matchAll(/<Relationship [^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g), ...xml.matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*Type="[^"]*\/image"/g)]
    .map((m) => m[1]).map((t) => (t.startsWith("/") ? t.slice(1) : normalise(`${baseDir}/${t}`)));
}
function normalise(p: string) {
  const out: string[] = [];
  for (const part of p.split("/")) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
  return out.join("/");
}

export async function extractTemplateTheme(buf: Buffer, kind: "pptx" | "docx" | "xlsx"): Promise<TemplateTheme> {
  const t: TemplateTheme = { carried: [], notCarried: [...NOT_CARRIED], warnings: [] };
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buf); } catch { t.warnings.push("uploaded template is not a readable Office file — built-in layout used"); return t; }
  const themePath = Object.keys(zip.files).find((f) => (kind === "pptx" ? /^ppt\/theme\/theme\d+\.xml$/ : kind === "docx" ? /^word\/theme\/theme\d+\.xml$/ : /^xl\/theme\/theme\d+\.xml$/).test(f));
  if (themePath) {
    const xml = await zip.file(themePath)!.async("string");
    const a1 = themeColor(xml, "accent1"), a2 = themeColor(xml, "accent2"), dk2 = themeColor(xml, "dk2");
    t.primary = a1 ?? dk2; t.accent = a2 ?? (a1 && dk2 && dk2 !== a1 ? dk2 : undefined);
    t.font = themeFont(xml, "minorFont"); t.headingFont = themeFont(xml, "majorFont");
    if (t.primary || t.accent) t.carried.push(`theme colours (primary #${t.primary ?? "—"}, accent #${t.accent ?? "—"})`);
    if (t.font || t.headingFont) t.carried.push(`theme fonts (body ${t.font ?? "—"}, headings ${t.headingFont ?? "—"})`);
  } else t.warnings.push("no theme part found in the uploaded template");
  // logo: image referenced by the first slide master (pptx) or a page header (docx); else none (never guessed from slides)
  let candidates: string[] = [];
  if (kind === "pptx") candidates = await relTargets(zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels", "ppt/slideMasters");
  if (kind === "docx") for (const h of Object.keys(zip.files).filter((f) => /^word\/_rels\/header\d*\.xml\.rels$/.test(f)).sort()) candidates.push(...await relTargets(zip, h, "word"));
  for (const c of candidates) {
    const f = zip.file(c);
    if (!f) continue;
    const data = await f.async("nodebuffer");
    const size = imageSize(data);
    if (!size || data.length > MAX_LOGO_BYTES) continue;
    t.logo = { data: data.toString("base64"), ...size };
    t.carried.push(`logo (${c.split("/").pop()}, ${size.width}×${size.height}px)`);
    break;
  }
  if (!t.logo) t.notCarried.unshift("logo (none found on the slide master / page header)");
  return t;
}

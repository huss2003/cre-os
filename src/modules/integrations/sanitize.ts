/**
 * Email content is untrusted evidence (spec §14 threat controls, rule S7):
 *  - strip active HTML (script/style/iframe/object/embed/form/svg/math, event handlers, javascript:/data: URLs)
 *  - reduce to plain text; we never store or render provider HTML
 *  - cap length; attachments are metadata only (never opened/executed here)
 */

const ACTIVE_BLOCKS = ["script", "style", "iframe", "object", "embed", "applet", "form", "svg", "math", "template", "noscript", "head", "title", "xml", "frameset", "frame"];
const VOID_DANGEROUS = ["meta", "link", "base", "input", "button", "select", "textarea", "img", "video", "audio", "source", "track"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", rupee: "₹" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return safeCodePoint(parseInt(k.slice(2), 16), m);
    if (k.startsWith("#")) return safeCodePoint(parseInt(k.slice(1), 10), m);
    return ENTITIES[k] ?? m;
  });
}
function safeCodePoint(n: number, fallback: string) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return fallback;
  if (n < 32 && n !== 9 && n !== 10 && n !== 13) return "";
  return String.fromCodePoint(n);
}

/** Remove active content from HTML. Output is still HTML (used only as an intermediate step). */
export function stripActiveHtml(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  for (const tag of ACTIVE_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " "); // unclosed / self-closing
  }
  for (const tag of VOID_DANGEROUS) s = s.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), " ");
  // event handler attributes and script-capable URLs on whatever remains
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s(href|src|action|formaction|xlink:href|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, attr: string, val: string) => {
    const v = val.replace(/^["']|["']$/g, "").trim().toLowerCase().replace(/[\s\u0000-\u001f]/g, "");
    if (attr.toLowerCase() === "style") return "";
    if (v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:")) return "";
    return m;
  });
  return s;
}

/** HTML -> readable plain text (block tags become newlines). */
export function htmlToText(html: string): string {
  let s = stripActiveHtml(html);
  s = s.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section|article)\s*>/gi, "\n").replace(/<li\b[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return normaliseWhitespace(s);
}

export function normaliseWhitespace(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip control chars / bidi overrides used to hide instructions; cap length. */
export function cleanText(s: string, max = 4000): string {
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩​-‏]/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The single entry point used for every stored body excerpt. */
export function sanitiseBody(input: { html?: string | null; text?: string | null }, max = 4000): string {
  const raw = input.text && input.text.trim() ? normaliseWhitespace(input.text) : input.html ? htmlToText(input.html) : "";
  // drop quoted history below common reply markers to keep the excerpt about this message
  const cut = raw.split(/\n(?:On .{5,120}wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: .+)/i)[0];
  return cleanText(cut, max);
}

export function cleanSubject(s: string | null | undefined): string | null {
  if (!s) return null;
  return cleanText(normaliseWhitespace(decodeEntities(s)), 300);
}

/** Lower-case trimmed address; returns null when it does not look like an address. */
export function normaliseAddress(a: string | null | undefined): string | null {
  if (!a) return null;
  const m = a.match(/<([^>]+)>/);
  const v = (m ? m[1] : a).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** Message-ID normalised for cross-source dedupe (angle brackets/case stripped). */
export function normaliseMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const v = id.trim().replace(/^<|>$/g, "").toLowerCase();
  return v || null;
}

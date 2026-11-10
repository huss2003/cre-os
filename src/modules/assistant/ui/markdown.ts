/**
 * Tiny safe markdown parser for assistant text. Produces a plain AST that React renders as elements —
 * model text is never injected as HTML. Supports paragraphs, headings (#..###), bullet / numbered lists,
 * fenced code, inline **bold**, *italic*, `code` and [links](url) (http(s), mailto and in-app "/" only).
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[]; external: boolean };

export type MdBlock =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][]; start: number }
  | { t: "code"; v: string };

export function safeHref(raw: string): { href: string; external: boolean } | null {
  const h = raw.trim();
  if (/^https?:\/\//i.test(h)) return { href: h, external: true };
  if (/^mailto:/i.test(h)) return { href: h, external: true };
  if (h.startsWith("/") && !h.startsWith("//")) return { href: h, external: false };
  return null;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) { flush(); out.push({ t: "code", v: m[1] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\*\*(.+?)\*\*/)) || (m = rest.match(/^__(.+?)__/))) { flush(); out.push({ t: "bold", c: parseInline(m[1]) }); i += m[0].length; continue; }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      const l = safeHref(m[2]);
      flush();
      if (l) out.push({ t: "link", href: l.href, external: l.external, c: parseInline(m[1]) });
      else out.push({ t: "text", v: m[1] });
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^\*([^*\s][^*]*?)\*/))) { flush(); out.push({ t: "em", c: parseInline(m[1]) }); i += m[0].length; continue; }
    buf += s[i]; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = (src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const endPara = () => { if (para.length) { out.push({ t: "p", c: parseInline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      endPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      out.push({ t: "code", v: code.join("\n") });
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { endPara(); out.push({ t: "h", level: h[1].length as 1 | 2 | 3, c: parseInline(h[2]) }); continue; }
    if (/^\s*[-*•]\s+/.test(line)) {
      endPara();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(parseInline(lines[i].replace(/^\s*[-*•]\s+/, ""))); i++; }
      i--; out.push({ t: "ul", items }); continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+/);
    if (ol) {
      endPara();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(parseInline(lines[i].replace(/^\s*\d+[.)]\s+/, ""))); i++; }
      i--; out.push({ t: "ol", items, start: Number(ol[1]) }); continue;
    }
    para.push(line.trim());
  }
  endPara();
  return out;
}

/** Strip markdown to plain text (copy button). */
export function markdownToPlain(src: string): string {
  const inl = (c: Inline[]): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : inl(x.c))).join("");
  return parseMarkdown(src).map((b) => {
    if (b.t === "code") return b.v;
    if (b.t === "ul") return b.items.map((it) => `- ${inl(it)}`).join("\n");
    if (b.t === "ol") return b.items.map((it, k) => `${b.start + k}. ${inl(it)}`).join("\n");
    return inl(b.c);
  }).join("\n\n");
}

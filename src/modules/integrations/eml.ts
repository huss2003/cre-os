import type { MailAddress, MailAttachmentMeta, MailMessage } from "./types";
import { normaliseAddress } from "./sanitize";

/**
 * Minimal RFC 5322 / MIME parser for manual selected-thread import (pasted or uploaded .eml).
 * Gmail "Show original" / "Download message" produce this format. Attachments are recorded as metadata only.
 */

interface Part {
  headers: Record<string, string>;
  body: string;
}

function splitHeadersBody(raw: string): { head: string; body: string } {
  const s = raw.replace(/\r\n/g, "\n");
  const i = s.indexOf("\n\n");
  return i === -1 ? { head: s, body: "" } : { head: s.slice(0, i), body: s.slice(i + 2) };
}

export function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = head.replace(/\n[ \t]+/g, " ");
  for (const line of unfolded.split("\n")) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2].trim(); // first occurrence wins (top-most header)
  }
  return out;
}

/** RFC 2047 encoded-words: =?utf-8?B?...?= / =?utf-8?Q?...?= */
export function decodeWords(s: string): string {
  return s.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      const buf = enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "binary");
      return new TextDecoder(charset.toLowerCase() === "utf8" ? "utf-8" : charset).decode(buf);
    } catch {
      return text;
    }
  });
}

function decodeQuotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(c, "utf8"));
    }
  }
  return Buffer.from(bytes);
}

function charsetOf(ct: string | undefined): string {
  const m = ct?.match(/charset="?([^";\s]+)"?/i);
  return (m?.[1] ?? "utf-8").toLowerCase();
}

function decodeBody(body: string, headers: Record<string, string>): string {
  const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  let buf: Buffer;
  if (enc === "base64") buf = Buffer.from(body.replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") buf = decodeQuotedPrintable(body);
  else buf = Buffer.from(body, "utf8");
  try {
    return new TextDecoder(charsetOf(headers["content-type"])).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function boundaryOf(ct: string | undefined): string | null {
  const m = ct?.match(/boundary="?([^";]+)"?/i);
  return m ? m[1] : null;
}

function walk(part: Part, acc: { text: string[]; html: string[]; attachments: MailAttachmentMeta[] }, depth = 0) {
  if (depth > 8) return;
  const ct = (part.headers["content-type"] ?? "text/plain").toLowerCase();
  const disp = (part.headers["content-disposition"] ?? "").toLowerCase();
  const boundary = boundaryOf(part.headers["content-type"]);
  if (ct.startsWith("multipart/") && boundary) {
    const segments = part.body.split(`--${boundary}`);
    for (const seg of segments.slice(1)) {
      if (seg.startsWith("--")) break;
      const { head, body } = splitHeadersBody(seg.replace(/^\n/, ""));
      walk({ headers: parseHeaders(head), body }, acc, depth + 1);
    }
    return;
  }
  const filename = (part.headers["content-disposition"]?.match(/filename\*?="?([^";]+)"?/i)?.[1])
    ?? (part.headers["content-type"]?.match(/name="?([^";]+)"?/i)?.[1]);
  if (disp.startsWith("attachment") || (filename && !ct.startsWith("text/"))) {
    acc.attachments.push({ name: decodeWords(filename ?? "attachment"), content_type: ct.split(";")[0], size: part.body.replace(/\s+/g, "").length });
    return;
  }
  if (ct.startsWith("text/html")) acc.html.push(decodeBody(part.body, part.headers));
  else if (ct.startsWith("text/plain")) acc.text.push(decodeBody(part.body, part.headers));
}

export function parseAddressList(v: string | undefined): MailAddress[] {
  if (!v) return [];
  const out: MailAddress[] = [];
  // split on commas not inside quotes
  for (const chunk of decodeWords(v).match(/("[^"]*"|[^,])+/g) ?? []) {
    const address = normaliseAddress(chunk);
    if (!address) continue;
    const name = chunk.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
    out.push({ address, name: name && name.toLowerCase() !== address ? name : null });
  }
  return out;
}

export interface ParsedEml extends MailMessage {
  rawHeaders: Record<string, string>;
}

/** Parse a raw .eml. `fallbackId` is used as provider id (callers pass sha256 of the raw content). */
export function parseEml(raw: string, fallbackId: string): ParsedEml {
  const { head, body } = splitHeadersBody(raw);
  const headers = parseHeaders(head);
  const acc = { text: [] as string[], html: [] as string[], attachments: [] as MailAttachmentMeta[] };
  walk({ headers, body }, acc);
  const date = headers["date"] ? new Date(headers["date"]) : null;
  const refs = (headers["references"] ?? "").split(/\s+/).filter(Boolean);
  return {
    id: fallbackId,
    internetMessageId: headers["message-id"] ?? null,
    threadId: refs[0] ?? headers["in-reply-to"] ?? headers["message-id"] ?? null,
    folder: "inbox",
    from: parseAddressList(headers["from"])[0] ?? null,
    to: parseAddressList(headers["to"]),
    cc: parseAddressList(headers["cc"]),
    subject: headers["subject"] ? decodeWords(headers["subject"]) : null,
    receivedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString(),
    bodyText: acc.text.join("\n\n") || null,
    bodyHtml: acc.html.join("\n") || null,
    attachments: acc.attachments,
    rawHeaders: headers,
  };
}

/** URL helpers for user-entered links. Only http(s) is accepted server-side (no javascript:, data:, file: …). */
export function isHttpUrl(v: string): boolean {
  if (!/^https?:\/\//i.test(v.trim())) return false;
  try { const u = new URL(v.trim()); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
}

/** Blank -> null; a valid http(s) link -> trimmed link; anything else -> the returned error message. */
export function checkHttpUrl(v: unknown, label = "Link"): { value: string | null; error: string | null } {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!s) return { value: null, error: null };
  if (s.length > 2000) return { value: null, error: `${label} is too long (max 2,000 characters).` };
  return isHttpUrl(s) ? { value: s, error: null } : { value: null, error: `${label} must be a web link starting with http:// or https://.` };
}

/** "acme.com" style domain (no scheme, path or markup). */
export function isDomain(v: string): boolean {
  return v.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v);
}

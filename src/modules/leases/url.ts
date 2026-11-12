/** Flash query goes BEFORE the #fragment (B3): "/leases/x#dates" → "/leases/x?ok=Saved.#dates". PURE. */
export function backUrl(path: string, msg: { ok?: string; err?: string }): string {
  const i = path.indexOf("#");
  const base = i >= 0 ? path.slice(0, i) : path; const hash = i >= 0 ? path.slice(i) : "";
  const q = new URLSearchParams(msg as Record<string, string>).toString();
  return `${base}${q ? (base.includes("?") ? "&" : "?") + q : ""}${hash}`;
}

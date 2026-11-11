import { createHash } from "node:crypto";

/** Order-stable JSON hash (keys sorted). */
export function stableHashLite(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return createHash("sha256").update(JSON.stringify(norm(v))).digest("hex").slice(0, 32);
}

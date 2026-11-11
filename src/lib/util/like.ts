/**
 * Escape user text for a Postgres LIKE/ILIKE pattern (default escape char is backslash), so `%`, `_` and `\`
 * match literally. Use `.ilike(col, escapeLike(name))` for an exact case-insensitive match, or
 * `.ilike(col, containsLike(q))` for a substring search.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** `%text%` with the user text escaped. */
export function containsLike(s: string): string {
  return `%${escapeLike(s)}%`;
}

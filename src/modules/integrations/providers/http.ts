import { CursorExpiredError, ProviderAuthError, ProviderError, ProviderRateLimitError } from "../types";
import type { FetchLike } from "../tokens";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse Retry-After (seconds or HTTP date). Defaults to 60s. */
export function retryAfterSeconds(h: string | null): number {
  if (!h) return 60;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(1, Math.ceil((d - Date.now()) / 1000)) : 60;
}

/**
 * GET JSON from a provider API with a bearer token.
 *  - 429/503: honour Retry-After; wait inline once when short (<= maxInlineWaitSec), else throw ProviderRateLimitError
 *  - 401: token rejected (caller may refresh once) ; 403 => access revoked / blocked by policy
 *  - 410: delta/sync token expired => CursorExpiredError (caller performs a full re-sync)
 */
export async function getJson<T = unknown>(
  url: string,
  token: string,
  opts: { fetchImpl?: FetchLike; headers?: Record<string, string>; maxInlineWaitSec?: number; notFoundIsCursorExpired?: boolean } = {},
): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await f(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(opts.headers ?? {}) } });
    if (res.ok) return (await res.json()) as T;
    const text = await res.text().catch(() => "");
    if (res.status === 429 || res.status === 503) {
      const wait = retryAfterSeconds(res.headers.get("retry-after"));
      if (attempt === 0 && wait <= (opts.maxInlineWaitSec ?? 5)) {
        await sleep(wait * 1000);
        continue;
      }
      throw new ProviderRateLimitError(wait, `${res.status} from provider; retry after ${wait}s`);
    }
    if (res.status === 401) throw new ProviderAuthError("expired", `401 from provider: ${text.slice(0, 200)}`);
    if (res.status === 403) throw new ProviderAuthError("revoked", `403 from provider (consent revoked or blocked by policy): ${text.slice(0, 200)}`);
    if (res.status === 410 || (opts.notFoundIsCursorExpired && res.status === 404)) throw new CursorExpiredError(`${res.status}: sync state expired`);
    throw new ProviderError(res.status, `${res.status} from provider: ${text.slice(0, 300)}`);
  }
  throw new ProviderError(0, "unreachable");
}

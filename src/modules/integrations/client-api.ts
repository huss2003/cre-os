/** Browser helper for /api/v1 mutations: JSON + a fresh Idempotency-Key per user action. */
export async function apiPost<T = unknown>(url: string, body: unknown = {}, method: "POST" | "PATCH" = "POST"): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number; details?: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: String((json as { error?: string }).error ?? res.statusText), status: res.status, details: (json as { details?: unknown }).details };
  return { ok: true, data: json as T };
}

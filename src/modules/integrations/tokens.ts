import "server-only";
import type { Db } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret } from "@/lib/util/crypto";
import { clientCredentials, PROVIDER_ENDPOINTS, redirectUri } from "./config";
import { ProviderAuthError, ProviderRateLimitError, type ConnectorStatus, type ProviderName } from "./types";

/** Tokens are only ever stored AES-256-GCM encrypted (TOKEN_ENCRYPTION_KEY) and never sent to the browser. */
export interface TokenBundle {
  access_token: string;
  refresh_token: string | null;
  expires_at: string;            // ISO
  scope?: string | null;
  id_token?: string | null;
}

export interface ConnectorAccountRow {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: ProviderName;
  status: ConnectorStatus;
  scopes: string[];
  account_email: string | null;
  token_ciphertext: string | null;
  token_expires_at: string | null;
  last_error: string | null;
  created_at: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function sealTokens(b: TokenBundle): string {
  return encryptSecret(JSON.stringify(b));
}

export function openTokens(ciphertext: string): TokenBundle {
  const v = JSON.parse(decryptSecret(ciphertext)) as TokenBundle;
  if (!v || typeof v.access_token !== "string") throw new Error("token bundle malformed");
  return v;
}

/** Map an OAuth error response to revoked vs expired (both require the reconnect screen). */
export function classifyOAuthError(body: { error?: string; error_description?: string } | null): "expired" | "revoked" | null {
  if (!body?.error) return null;
  const d = `${body.error} ${body.error_description ?? ""}`;
  if (!/invalid_grant|interaction_required|consent_required|unauthorized_client|invalid_client/i.test(d)) return null;
  if (/revoked|AADSTS50173|AADSTS65001|AADSTS70000|AADSTS50057|consent_required|unauthorized_client|invalid_client/i.test(d)) return "revoked";
  return "expired";
}

async function tokenRequest(provider: ProviderName, params: Record<string, string>, fetchImpl: FetchLike): Promise<TokenBundle> {
  const creds = clientCredentials(provider);
  if (!creds) throw new Error(`${provider} OAuth credentials not configured`);
  const body = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params });
  const res = await fetchImpl(PROVIDER_ENDPOINTS[provider].token(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 429) throw new ProviderRateLimitError(Number(res.headers.get("retry-after") ?? 60));
  if (!res.ok || !json?.access_token) {
    const kind = classifyOAuthError(json as { error?: string; error_description?: string });
    const msg = `token endpoint ${res.status}: ${String(json?.error ?? "")} ${String(json?.error_description ?? "").slice(0, 300)}`.trim();
    if (kind) throw new ProviderAuthError(kind, msg);
    throw new Error(msg);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    access_token: String(json.access_token),
    refresh_token: json.refresh_token ? String(json.refresh_token) : params.refresh_token ?? null,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: json.scope ? String(json.scope) : null,
    id_token: json.id_token ? String(json.id_token) : null,
  };
}

export function exchangeCode(provider: ProviderName, code: string, codeVerifier: string, fetchImpl: FetchLike = fetch) {
  return tokenRequest(provider, { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri(provider) }, fetchImpl);
}

export function refreshTokens(provider: ProviderName, refreshToken: string, fetchImpl: FetchLike = fetch) {
  return tokenRequest(provider, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Record a connector failure; auth failures flip status so the reconnect screen and stale banners show. */
export async function markConnectorFailure(admin: Db, account: Pick<ConnectorAccountRow, "id" | "workspace_id">, status: ConnectorStatus | null, error: string) {
  const patch: Record<string, unknown> = { last_error: error.slice(0, 1000), updated_at: new Date().toISOString() };
  if (status) patch.status = status;
  await admin.from("connector_account").update(patch).eq("id", account.id).eq("workspace_id", account.workspace_id);
}

/**
 * Return a valid access token, refreshing when it expires within 2 minutes.
 * Refresh failure with invalid_grant => status expired/revoked + last_error, then rethrows ProviderAuthError.
 */
export async function getValidAccessToken(admin: Db, account: ConnectorAccountRow, fetchImpl: FetchLike = fetch): Promise<string> {
  if (account.status === "revoked" || account.status === "expired") {
    throw new ProviderAuthError(account.status, `connector ${account.status}; reconnect required`);
  }
  if (!account.token_ciphertext) throw new ProviderAuthError("revoked", "no stored token; reconnect required");
  let bundle: TokenBundle;
  try {
    bundle = openTokens(account.token_ciphertext);
  } catch (e) {
    await markConnectorFailure(admin, account, "error", `token decrypt failed: ${String(e)}`);
    throw new ProviderAuthError("revoked", "stored token unreadable (key rotated?); reconnect required");
  }
  if (Date.parse(bundle.expires_at) - Date.now() > 120_000) return bundle.access_token;
  if (!bundle.refresh_token) {
    await markConnectorFailure(admin, account, "expired", "access token expired and no refresh token");
    throw new ProviderAuthError("expired", "access token expired; reconnect required");
  }
  try {
    const next = await refreshTokens(account.provider, bundle.refresh_token, fetchImpl);
    await admin.from("connector_account").update({
      token_ciphertext: sealTokens(next), token_expires_at: next.expires_at, status: "connected", last_error: null, updated_at: new Date().toISOString(),
    }).eq("id", account.id).eq("workspace_id", account.workspace_id);
    account.token_ciphertext = sealTokens(next);
    account.token_expires_at = next.expires_at;
    return next.access_token;
  } catch (e) {
    if (e instanceof ProviderAuthError) await markConnectorFailure(admin, account, e.status, e.message);
    throw e;
  }
}

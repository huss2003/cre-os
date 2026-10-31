import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret, sha256 } from "@/lib/util/crypto";
import { safeNext } from "@/lib/util/safe-redirect";
import { clientCredentials, isProviderConfigured, PROVIDER_ENDPOINTS, redirectUri, scopesFor } from "./config";
import { exchangeCode, openTokens, sealTokens, type FetchLike } from "./tokens";
import type { ProviderName } from "./types";

/**
 * OAuth 2.0 authorization code + PKCE (S256). The `state` is random, stored only as sha256 in oauth_state, bound to
 * user + workspace + provider, single use, 10-minute expiry. Tokens are AES-GCM encrypted (encryptSecret) and never
 * leave the server. Without client credentials the connector runs as a clearly labelled deterministic MOCK.
 * All writes go through the service-role client because tokens are deliberately not writable by app users;
 * every query is filtered by the caller's user_id + workspace_id.
 */
export class OAuthError extends Error {
  constructor(public code: "invalid_state" | "expired_state" | "provider_error" | "not_configured" | "wrong_user", message: string) {
    super(message);
  }
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(provider: ProviderName, state: string, challenge: string, loginHint?: string | null) {
  const creds = clientCredentials(provider);
  if (!creds) throw new OAuthError("not_configured", `${provider} OAuth is not configured`);
  const q = new URLSearchParams({
    client_id: creds.clientId, response_type: "code", redirect_uri: redirectUri(provider), scope: scopesFor(provider).join(" "),
    state, code_challenge: challenge, code_challenge_method: "S256",
  });
  if (provider === "microsoft") q.set("response_mode", "query");
  if (provider === "google") { q.set("access_type", "offline"); q.set("prompt", "consent"); q.set("include_granted_scopes", "false"); }
  if (loginHint) q.set("login_hint", loginHint);
  return `${PROVIDER_ENDPOINTS[provider].authorize()}?${q.toString()}`;
}

/** Start: returns the provider URL to redirect to, or null when running in mock mode (caller connects the mock). */
export async function startOAuth(admin: Db, p: { provider: ProviderName; userId: string; workspaceId: string; redirectTo?: string | null; loginHint?: string | null }) {
  if (!isProviderConfigured(p.provider)) return { url: null as string | null, mock: true };
  const state = b64url(randomBytes(32));
  const { verifier, challenge } = pkcePair();
  await admin.from("oauth_state").delete().lt("expires_at", new Date().toISOString());
  const { error } = await admin.from("oauth_state").insert({
    workspace_id: p.workspaceId, user_id: p.userId, provider: p.provider, state_hash: sha256(state), code_verifier_ciphertext: encryptSecret(verifier),
    redirect_to: safeNext(p.redirectTo, "/settings/connections"), expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw error;
  return { url: buildAuthorizeUrl(p.provider, state, challenge, p.loginHint), mock: false };
}

/** Decode (without verifying — it came straight from the token endpoint over TLS) the id_token email claim. */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const v = (payload.email ?? payload.preferred_username ?? payload.upn) as string | undefined;
    return v ? String(v).toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Callback: state must exist, be unused, unexpired, and belong to the SAME signed-in user (and the workspace it was
 * started in). Exchanges the code with the PKCE verifier and stores encrypted tokens.
 */
export async function completeOAuth(admin: Db, p: { provider: ProviderName; userId: string; state: string; code: string; fetchImpl?: FetchLike }) {
  const { data: st } = await admin.from("oauth_state").select("*").eq("state_hash", sha256(p.state)).eq("provider", p.provider).maybeSingle();
  if (!st) throw new OAuthError("invalid_state", "unknown or already used sign-in request; start again");
  if (st.user_id !== p.userId) throw new OAuthError("wrong_user", "this sign-in was started by a different user");
  // single use: burn it before doing anything else
  const { data: burned } = await admin.from("oauth_state").update({ used_at: new Date().toISOString() }).eq("id", st.id).is("used_at", null).select("id");
  if (!burned?.length) throw new OAuthError("invalid_state", "sign-in request already used; start again");
  if (Date.parse(st.expires_at) < Date.now()) throw new OAuthError("expired_state", "sign-in request expired; start again");
  const verifier = decryptSecret(st.code_verifier_ciphertext);
  const tokens = await exchangeCode(p.provider, p.code, verifier, p.fetchImpl);
  const granted = (tokens.scope ?? scopesFor(p.provider).join(" ")).split(/\s+/).filter(Boolean);
  const row = {
    workspace_id: st.workspace_id, user_id: st.user_id, provider: p.provider, scopes: granted, account_email: emailFromIdToken(tokens.id_token),
    status: "connected", token_ciphertext: sealTokens({ ...tokens, id_token: null }), token_expires_at: tokens.expires_at, last_error: null, updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("connector_account").upsert(row, { onConflict: "workspace_id,user_id,provider" }).select("id").single();
  if (error) throw error;
  await admin.from("oauth_state").delete().eq("id", st.id);
  return { accountId: data.id as string, workspaceId: st.workspace_id as string, redirectTo: safeNext(st.redirect_to, "/settings/connections") };
}

/** Mock connector (no credentials configured): status 'mock', deterministic fixtures, no tokens. */
export async function connectMock(admin: Db, p: { provider: ProviderName; userId: string; workspaceId: string }) {
  const { data: existing } = await admin.from("connector_account").select("id, status").eq("workspace_id", p.workspaceId).eq("user_id", p.userId).eq("provider", p.provider).maybeSingle();
  if (existing && existing.status !== "mock" && isProviderConfigured(p.provider)) return { accountId: existing.id as string };
  const { data, error } = await admin.from("connector_account").upsert({
    workspace_id: p.workspaceId, user_id: p.userId, provider: p.provider, status: "mock", scopes: scopesFor(p.provider), account_email: "mock@example.com",
    token_ciphertext: null, token_expires_at: null, last_error: null, updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,user_id,provider" }).select("id").single();
  if (error) throw error;
  return { accountId: data.id as string };
}

/** Disconnect: best-effort provider revocation (Google), then delete the account (cursors cascade). Imported data stays. */
export async function disconnect(admin: Db, p: { provider: ProviderName; userId: string; workspaceId: string; fetchImpl?: FetchLike }) {
  const { data: acc } = await admin.from("connector_account").select("id, token_ciphertext").eq("workspace_id", p.workspaceId).eq("user_id", p.userId).eq("provider", p.provider).maybeSingle();
  if (!acc) return { removed: false };
  if (acc.token_ciphertext && p.provider === "google") {
    try {
      const t = openTokens(acc.token_ciphertext);
      await (p.fetchImpl ?? fetch)(PROVIDER_ENDPOINTS.google.revoke(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }).toString() });
    } catch { /* revocation is best effort; local tokens are deleted regardless */ }
  }
  await admin.from("connector_account").delete().eq("workspace_id", p.workspaceId).eq("user_id", p.userId).eq("id", acc.id);
  return { removed: true };
}

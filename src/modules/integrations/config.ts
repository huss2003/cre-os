import type { ProviderName } from "./types";

/**
 * Exact delegated scopes (spec Part I §14). NO Mail.Send, NO Mail.ReadWrite, NO calendar write.
 * File access is opt-in and limited to explicitly assigned items (Files.SelectedOperations.Selected).
 */
export const MICROSOFT_BASE_SCOPES = ["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"] as const;
export const MICROSOFT_FILES_SCOPE = "Files.SelectedOperations.Selected";

/** Google: read-only Gmail (selected-thread manual import remains the default path) + read-only calendar. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

/** Scopes that must never be requested in the manual-send MVP. Checked at runtime before building an auth URL. */
export const FORBIDDEN_SCOPES = [
  "Mail.Send", "Mail.ReadWrite", "Calendars.ReadWrite", "Mail.Send.Shared",
  "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose", "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events",
];

export function scopesFor(provider: ProviderName): string[] {
  const s = provider === "microsoft"
    ? [...MICROSOFT_BASE_SCOPES, ...(process.env.MICROSOFT_ENABLE_SELECTED_FILES === "1" ? [MICROSOFT_FILES_SCOPE] : [])]
    : [...GOOGLE_SCOPES];
  const bad = s.filter((x) => FORBIDDEN_SCOPES.includes(x));
  if (bad.length) throw new Error(`forbidden scopes requested: ${bad.join(", ")}`);
  return s;
}

export const PROVIDER_ENDPOINTS = {
  microsoft: {
    authorize: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || "common"}/oauth2/v2.0/authorize`,
    token: () => `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID || "common"}/oauth2/v2.0/token`,
  },
  google: {
    authorize: () => "https://accounts.google.com/o/oauth2/v2/auth",
    token: () => "https://oauth2.googleapis.com/token",
    revoke: () => "https://oauth2.googleapis.com/revoke",
  },
} as const;

export function clientCredentials(provider: ProviderName): { clientId: string; clientSecret: string } | null {
  const id = provider === "microsoft" ? process.env.MICROSOFT_CLIENT_ID : process.env.GOOGLE_CLIENT_ID;
  const secret = provider === "microsoft" ? process.env.MICROSOFT_CLIENT_SECRET : process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret };
}

/** When credentials are absent the connector runs in deterministic mock mode (status 'mock'). */
export function isProviderConfigured(provider: ProviderName): boolean {
  return clientCredentials(provider) !== null;
}

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function redirectUri(provider: ProviderName): string {
  return `${appUrl()}/api/oauth/${provider}/callback`;
}

/** Sync cadence (spec: inbox every 10-15 minutes). */
export const CADENCE_MINUTES = { inbox: 10, calendar: 15, sent: 30, sequences: 60 } as const;

/** A source is "stale" when its last success is older than this many minutes (or it is failing). */
export const STALE_AFTER_MINUTES = { inbox: 45, calendar: 90, sent: 180 } as const;

/** Messages older than this at first sight are backfill: logged, never alert or trigger sequences. */
export const BACKFILL_AGE_HOURS = 48;

/** Calendar sync window. */
export const CALENDAR_WINDOW_DAYS = { back: 7, ahead: 30 } as const;

export const PROVIDERS: ProviderName[] = ["microsoft", "google"];

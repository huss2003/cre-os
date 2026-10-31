/**
 * Deterministic source freshness for the brief (spec Part I §7 07:55 health check; Part III "Brief source freshness and
 * failure counts are computed deterministically"; rule S10). PURE.
 *
 * A source is one of: ok | stale | failed | not_connected. A failed/stale source keeps its last successful timestamp so
 * the brief can say "unavailable since X" — never "no replies".
 */
import type { BriefSettings } from "./settings";

export type SourceKey = "inbox" | "calendar" | "sent";
export type SourceState = "ok" | "stale" | "failed" | "not_connected";

export interface SourceStatus {
  key: SourceKey;
  label: string;
  state: SourceState;
  provider: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  note: string;
}

export interface ConnectorAccountRow { id: string; provider: string; status: string; last_error?: string | null }
export interface ConnectorCursorRow { connector_account_id: string; resource: string; last_success_at: string | null; last_attempt_at: string | null; last_error: string | null }

const LABEL: Record<SourceKey, string> = { inbox: "Inbox", calendar: "Calendar", sent: "Sent mail" };
export const SOURCE_KEYS: SourceKey[] = ["inbox", "calendar", "sent"];

function hoursSince(iso: string | null, now: Date): number {
  return iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity;
}

export function computeSourceHealth(accounts: ConnectorAccountRow[], cursors: ConnectorCursorRow[], now: Date, settings: Pick<BriefSettings, "sourceStaleHours">): SourceStatus[] {
  return SOURCE_KEYS.map((key) => {
    const candidates = accounts.map((a) => ({ a, c: cursors.find((c) => c.connector_account_id === a.id && c.resource === key) ?? null }));
    if (candidates.length === 0) {
      return { key, label: LABEL[key], state: "not_connected", provider: null, lastSuccessAt: null, lastAttemptAt: null, error: null, note: `${LABEL[key]} not connected — use capture or an approved export` };
    }
    // prefer the freshest successful cursor across providers
    candidates.sort((x, y) => (Date.parse(y.c?.last_success_at ?? "1970-01-01") - Date.parse(x.c?.last_success_at ?? "1970-01-01")));
    const { a, c } = candidates[0];
    const lastSuccessAt = c?.last_success_at ?? null;
    const lastAttemptAt = c?.last_attempt_at ?? null;
    const base = { key, label: LABEL[key], provider: a.provider, lastSuccessAt, lastAttemptAt };
    const since = lastSuccessAt ? `since ${lastSuccessAt}` : "— never synced successfully";
    if (["expired", "revoked", "error"].includes(a.status)) {
      return { ...base, state: "failed", error: a.last_error ?? `connector ${a.status}`, note: `${LABEL[key]} unavailable ${since} (connector ${a.status})` };
    }
    const attemptFailed = !!c?.last_error && (!lastSuccessAt || (lastAttemptAt != null && Date.parse(lastAttemptAt) > Date.parse(lastSuccessAt)));
    if (attemptFailed) {
      return { ...base, state: "failed", error: c!.last_error, note: `${LABEL[key]} unavailable ${since} (last sync failed)` };
    }
    if (!lastSuccessAt) {
      return { ...base, state: "failed", error: null, note: `${LABEL[key]} connected but never synced` };
    }
    const age = hoursSince(lastSuccessAt, now);
    if (age > settings.sourceStaleHours[key]) {
      return { ...base, state: "stale", error: null, note: `${LABEL[key]} stale — last successful sync ${lastSuccessAt} (${Math.round(age)} h ago)` };
    }
    return { ...base, state: "ok", error: null, note: `${LABEL[key]} fresh (${a.status === "mock" ? "mock connector, " : ""}last sync ${lastSuccessAt})` };
  });
}

export function sourceUsable(s: SourceStatus | undefined): boolean {
  return !!s && s.state === "ok";
}

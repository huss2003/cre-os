/** Provider-neutral shapes for read-only mail/calendar connectors. */

export type ProviderName = "microsoft" | "google";
export type ConnectorStatus = "connected" | "expired" | "revoked" | "error" | "mock";

export interface MailAddress {
  address: string;
  name?: string | null;
}

export interface MailAttachmentMeta {
  name: string;
  content_type: string | null;
  size: number | null;
}

export interface MailMessage {
  id: string;                     // provider message id
  internetMessageId: string | null;
  threadId: string | null;
  folder: "inbox" | "sent";
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string | null;
  receivedAt: string;             // ISO (sent time for sent items)
  bodyHtml?: string | null;
  bodyText?: string | null;
  attachments: MailAttachmentMeta[];
  removed?: boolean;              // delta tombstone
}

export interface CalendarAttendee {
  address: string;
  name?: string | null;
  response?: string | null;
}

export interface CalendarEventItem {
  id: string;
  iCalUId: string | null;
  title: string | null;
  start: string;                  // ISO instant (UTC)
  end: string;
  timezone: string;               // IANA (display)
  location: string | null;
  organizer: string | null;
  attendees: CalendarAttendee[];
  isCancelled: boolean;
  isOnline: boolean;
  changeKey: string | null;
  removed?: boolean;              // deleted from calendar (delta tombstone)
}

export interface DeltaPage<T> {
  items: T[];
  nextCursor: string | null;      // persisted watermark/delta token for the next run
  fullResync: boolean;            // true when this page came from a full re-sync (no/expired cursor)
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

/** One interface for Microsoft Graph, Gmail/Google Calendar and the deterministic mock. Read-only by design. */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly mode: "live" | "mock";
  listMessagesDelta(cursor: string | null): Promise<DeltaPage<MailMessage>>;
  getMessage(id: string): Promise<MailMessage | null>;
  listSentItems(since: Date): Promise<MailMessage[]>;
  listEvents(window: TimeWindow, cursor: string | null): Promise<DeltaPage<CalendarEventItem>>;
}

/** Access revoked / refresh token expired / consent withdrawn. Connector must be marked and surfaced as stale. */
export class ProviderAuthError extends Error {
  constructor(public status: "expired" | "revoked", message: string) {
    super(message);
  }
}

/** HTTP 429 / 503 with Retry-After. The job reschedules itself after `retryAfterSeconds`. */
export class ProviderRateLimitError extends Error {
  constructor(public retryAfterSeconds: number, message = "rate limited") {
    super(message);
  }
}

/** Delta/sync token no longer valid (Graph 410 syncStateNotFound, Gmail 404 historyId, Calendar 410). */
export class CursorExpiredError extends Error {}

export class ProviderError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

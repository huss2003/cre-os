import type { CalendarEventItem, DeltaPage, MailAttachmentMeta, MailMessage, ProviderAdapter, TimeWindow } from "../types";
import { CursorExpiredError } from "../types";
import type { FetchLike } from "../tokens";
import { parseAddressList } from "../eml";
import { getJson } from "./http";

/**
 * Google adapter — gmail.readonly + calendar.readonly. Manual selected-thread import stays the default Gmail path
 * (spec §14); this adapter is used only after the user explicitly connects read-only OAuth.
 * Cursors: "gmail:h:<historyId>" for mail, "gcal:<nextSyncToken>" for calendar.
 */
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GCAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_MESSAGES = 100;

interface GPart { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GPart[] }
interface GMessage { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: GPart; historyId?: string }
interface GEvent {
  id: string; iCalUID?: string; summary?: string; status?: string; etag?: string; location?: string; hangoutLink?: string; conferenceData?: unknown;
  start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string }; attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function walk(p: GPart | undefined, acc: { text: string[]; html: string[]; att: MailAttachmentMeta[] }) {
  if (!p) return;
  if (p.filename && (p.body?.attachmentId || p.body?.size)) {
    acc.att.push({ name: p.filename, content_type: p.mimeType ?? null, size: p.body?.size ?? null });
  } else if (p.mimeType === "text/plain" && p.body?.data) acc.text.push(b64url(p.body.data));
  else if (p.mimeType === "text/html" && p.body?.data) acc.html.push(b64url(p.body.data));
  for (const c of p.parts ?? []) walk(c, acc);
}

export function mapGmailMessage(m: GMessage): MailMessage {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value;
  const acc = { text: [] as string[], html: [] as string[], att: [] as MailAttachmentMeta[] };
  walk(m.payload, acc);
  const sent = (m.labelIds ?? []).includes("SENT") && !(m.labelIds ?? []).includes("INBOX");
  return {
    id: m.id,
    internetMessageId: h("message-id") ?? null,
    threadId: m.threadId ?? null,
    folder: sent ? "sent" : "inbox",
    from: parseAddressList(h("from"))[0] ?? null,
    to: parseAddressList(h("to")),
    cc: parseAddressList(h("cc")),
    subject: h("subject") ?? null,
    receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    bodyText: acc.text.join("\n\n") || null,
    bodyHtml: acc.html.join("\n") || null,
    attachments: acc.att,
  };
}

export function mapGoogleEvent(e: GEvent): CalendarEventItem {
  const when = (x?: { dateTime?: string; date?: string }) =>
    x?.dateTime ? new Date(x.dateTime).toISOString() : x?.date ? new Date(`${x.date}T00:00:00+05:30`).toISOString() : new Date(0).toISOString();
  return {
    id: e.id,
    iCalUId: e.iCalUID ?? null,
    title: e.summary ?? null,
    start: when(e.start),
    end: when(e.end),
    timezone: e.start?.timeZone ?? "Asia/Kolkata",
    location: e.location ?? null,
    organizer: e.organizer?.email?.toLowerCase() ?? null,
    attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ address: a.email!.toLowerCase(), name: a.displayName ?? null, response: a.responseStatus ?? null })),
    isCancelled: e.status === "cancelled",
    isOnline: !!(e.hangoutLink || e.conferenceData),
    changeKey: e.etag ?? null,
    removed: e.status === "cancelled" && !e.start,
  };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly provider = "google" as const;
  readonly mode = "live" as const;
  constructor(private token: () => Promise<string>, private fetchImpl: FetchLike = fetch) {}

  private async get<T>(url: string, notFoundIsCursorExpired = false) {
    return getJson<T>(url, await this.token(), { fetchImpl: this.fetchImpl, notFoundIsCursorExpired });
  }

  private async fetchMany(ids: string[]): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    for (const id of [...new Set(ids)].slice(0, MAX_MESSAGES)) {
      const m = await this.getMessage(id);
      if (m) out.push(m);
    }
    return out;
  }

  private async listIds(q: string, pages = 4): Promise<string[]> {
    const ids: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < pages; i++) {
      const url = `${GMAIL}/messages?maxResults=50&q=${encodeURIComponent(q)}${token ? `&pageToken=${token}` : ""}`;
      const r = await this.get<{ messages?: { id: string }[]; nextPageToken?: string }>(url);
      ids.push(...(r.messages ?? []).map((m) => m.id));
      token = r.nextPageToken;
      if (!token) break;
    }
    return ids;
  }

  async listMessagesDelta(cursor: string | null): Promise<DeltaPage<MailMessage>> {
    if (!cursor) {
      const profile = await this.get<{ historyId: string }>(`${GMAIL}/profile`);
      const items = await this.fetchMany(await this.listIds("in:inbox newer_than:14d"));
      return { items, nextCursor: `gmail:h:${profile.historyId}`, fullResync: true };
    }
    const m = cursor.match(/^gmail:h:(\d+)$/);
    if (!m) throw new CursorExpiredError("unrecognised gmail cursor");
    const ids: string[] = [];
    let pageToken: string | undefined;
    let latest = m[1];
    for (let i = 0; i < 5; i++) {
      const url = `${GMAIL}/history?startHistoryId=${m[1]}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const r = await this.get<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId?: string; nextPageToken?: string }>(url, true);
      for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) ids.push(a.message.id);
      if (r.historyId) latest = r.historyId;
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return { items: await this.fetchMany(ids), nextCursor: `gmail:h:${latest}`, fullResync: false };
  }

  async getMessage(id: string): Promise<MailMessage | null> {
    const m = await this.get<GMessage>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
    return mapGmailMessage(m);
  }

  async listSentItems(since: Date): Promise<MailMessage[]> {
    const ids = await this.listIds(`in:sent after:${Math.floor(since.getTime() / 1000)}`, 2);
    return (await this.fetchMany(ids)).map((m) => ({ ...m, folder: "sent" as const }));
  }

  async listEvents(window: TimeWindow, cursor: string | null): Promise<DeltaPage<CalendarEventItem>> {
    const items: CalendarEventItem[] = [];
    let pageToken: string | undefined;
    let syncToken: string | null = null;
    const base = cursor
      ? (() => {
          const m = cursor.match(/^gcal:(.+)$/);
          if (!m) throw new CursorExpiredError("unrecognised gcal cursor");
          return `${GCAL}?syncToken=${encodeURIComponent(m[1])}&maxResults=250`;
        })()
      : `${GCAL}?singleEvents=true&showDeleted=true&maxResults=250&timeMin=${window.start.toISOString()}&timeMax=${window.end.toISOString()}`;
    for (let i = 0; i < 10; i++) {
      const r = await this.get<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${base}${pageToken ? `&pageToken=${pageToken}` : ""}`);
      items.push(...(r.items ?? []).map(mapGoogleEvent));
      pageToken = r.nextPageToken;
      if (r.nextSyncToken) syncToken = r.nextSyncToken;
      if (!pageToken) break;
    }
    return { items, nextCursor: syncToken ? `gcal:${syncToken}` : cursor, fullResync: !cursor };
  }
}

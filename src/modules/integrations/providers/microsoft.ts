import type { CalendarEventItem, DeltaPage, MailAddress, MailMessage, ProviderAdapter, TimeWindow } from "../types";
import { CursorExpiredError } from "../types";
import type { FetchLike } from "../tokens";
import { getJson } from "./http";

/**
 * Microsoft Graph adapter — delegated, read-only (Mail.Read, Calendars.Read). Never calls send/write endpoints.
 * Delta tokens: the full @odata.deltaLink (or an unfinished @odata.nextLink) is the persisted cursor.
 */
const GRAPH = "https://graph.microsoft.com/v1.0";
const MSG_SELECT = "id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,receivedDateTime,sentDateTime,body,hasAttachments";
const MAX_PAGES = 10;
const INITIAL_DAYS = 14;

interface GraphRecipient { emailAddress?: { address?: string; name?: string } }
interface GraphMessage {
  id: string; internetMessageId?: string; conversationId?: string; from?: GraphRecipient; toRecipients?: GraphRecipient[]; ccRecipients?: GraphRecipient[];
  subject?: string; receivedDateTime?: string; sentDateTime?: string; body?: { contentType?: string; content?: string }; hasAttachments?: boolean;
  "@removed"?: unknown;
}
interface GraphPage<T> { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }
interface GraphEvent {
  id: string; iCalUId?: string; subject?: string; start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string }; organizer?: GraphRecipient; attendees?: (GraphRecipient & { status?: { response?: string } })[];
  isCancelled?: boolean; isOnlineMeeting?: boolean; changeKey?: string; originalStartTimeZone?: string; "@removed"?: unknown;
}

const addr = (r?: GraphRecipient): MailAddress | null =>
  r?.emailAddress?.address ? { address: r.emailAddress.address.toLowerCase(), name: r.emailAddress.name ?? null } : null;

export function mapGraphMessage(m: GraphMessage, folder: "inbox" | "sent"): MailMessage {
  const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
  return {
    id: m.id,
    internetMessageId: m.internetMessageId ?? null,
    threadId: m.conversationId ?? null,
    folder,
    from: addr(m.from),
    to: (m.toRecipients ?? []).map(addr).filter((x): x is MailAddress => !!x),
    cc: (m.ccRecipients ?? []).map(addr).filter((x): x is MailAddress => !!x),
    subject: m.subject ?? null,
    receivedAt: (folder === "sent" ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime ?? new Date().toISOString(),
    bodyHtml: isHtml ? m.body?.content ?? null : null,
    bodyText: isHtml ? null : m.body?.content ?? null,
    attachments: [],
    removed: m["@removed"] !== undefined,
  };
}

const utc = (s?: string) => (s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? new Date(s).toISOString() : new Date(`${s}Z`).toISOString()) : new Date(0).toISOString());

export function mapGraphEvent(e: GraphEvent): CalendarEventItem {
  return {
    id: e.id,
    iCalUId: e.iCalUId ?? null,
    title: e.subject ?? null,
    start: utc(e.start?.dateTime),
    end: utc(e.end?.dateTime),
    timezone: e.originalStartTimeZone && e.originalStartTimeZone.includes("/") ? e.originalStartTimeZone : "Asia/Kolkata",
    location: e.location?.displayName || null,
    organizer: e.organizer?.emailAddress?.address?.toLowerCase() ?? null,
    attendees: (e.attendees ?? []).filter((a) => a.emailAddress?.address).map((a) => ({
      address: a.emailAddress!.address!.toLowerCase(), name: a.emailAddress?.name ?? null, response: a.status?.response ?? null,
    })),
    isCancelled: !!e.isCancelled,
    isOnline: !!e.isOnlineMeeting,
    changeKey: e.changeKey ?? null,
    removed: e["@removed"] !== undefined,
  };
}

export class MicrosoftAdapter implements ProviderAdapter {
  readonly provider = "microsoft" as const;
  readonly mode = "live" as const;
  constructor(private token: () => Promise<string>, private fetchImpl: FetchLike = fetch) {}

  private async get<T>(url: string, prefer: string[] = []) {
    return getJson<T>(url, await this.token(), { fetchImpl: this.fetchImpl, headers: prefer.length ? { Prefer: prefer.join(", ") } : {} });
  }

  private async drainDelta<T>(start: string, prefer: string[]): Promise<{ items: T[]; next: string | null }> {
    const items: T[] = [];
    let url: string | undefined = start;
    for (let i = 0; i < MAX_PAGES && url; i++) {
      const page: GraphPage<T> = await this.get<GraphPage<T>>(url, prefer);
      items.push(...page.value);
      if (page["@odata.deltaLink"]) return { items, next: page["@odata.deltaLink"] };
      url = page["@odata.nextLink"];
    }
    return { items, next: url ?? null }; // unfinished: resume from nextLink next run
  }

  async listMessagesDelta(cursor: string | null): Promise<DeltaPage<MailMessage>> {
    const since = new Date(Date.now() - INITIAL_DAYS * 86_400_000).toISOString();
    const start = cursor ?? `${GRAPH}/me/mailFolders('inbox')/messages/delta?$select=${MSG_SELECT}&$filter=receivedDateTime+ge+${since}`;
    if (cursor && !cursor.startsWith(GRAPH)) throw new CursorExpiredError("cursor not a Graph delta link");
    const { items, next } = await this.drainDelta<GraphMessage>(start, ['odata.maxpagesize=50', 'outlook.body-content-type="text"']);
    const mapped = items.map((m) => mapGraphMessage(m, "inbox"));
    await this.fillAttachmentMeta(items, mapped);
    return { items: mapped, nextCursor: next, fullResync: !cursor };
  }

  private async fillAttachmentMeta(raw: GraphMessage[], mapped: MailMessage[]) {
    let budget = 20; // bounded extra calls per run
    for (let i = 0; i < raw.length && budget > 0; i++) {
      if (!raw[i].hasAttachments || mapped[i].removed) continue;
      budget--;
      try {
        const res = await this.get<{ value: { name?: string; contentType?: string; size?: number }[] }>(
          `${GRAPH}/me/messages/${encodeURIComponent(raw[i].id)}/attachments?$select=name,contentType,size`,
        );
        mapped[i].attachments = res.value.map((a) => ({ name: a.name ?? "attachment", content_type: a.contentType ?? null, size: a.size ?? null }));
      } catch {
        mapped[i].attachments = [{ name: "(attachment metadata unavailable)", content_type: null, size: null }];
      }
    }
  }

  async getMessage(id: string): Promise<MailMessage | null> {
    const m = await this.get<GraphMessage>(`${GRAPH}/me/messages/${encodeURIComponent(id)}?$select=${MSG_SELECT}`, ['outlook.body-content-type="text"']);
    const mapped = mapGraphMessage(m, "inbox");
    await this.fillAttachmentMeta([m], [mapped]);
    return mapped;
  }

  async listSentItems(since: Date): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    let url: string | undefined =
      `${GRAPH}/me/mailFolders('sentitems')/messages?$select=${MSG_SELECT}&$filter=sentDateTime+ge+${since.toISOString()}&$orderby=sentDateTime+desc&$top=50`;
    for (let i = 0; i < 5 && url; i++) {
      const page: GraphPage<GraphMessage> = await this.get<GraphPage<GraphMessage>>(url, ['outlook.body-content-type="text"']);
      out.push(...page.value.map((m) => mapGraphMessage(m, "sent")));
      url = page["@odata.nextLink"];
    }
    return out;
  }

  async listEvents(window: TimeWindow, cursor: string | null): Promise<DeltaPage<CalendarEventItem>> {
    if (cursor && !cursor.startsWith(GRAPH)) throw new CursorExpiredError("cursor not a Graph delta link");
    const start = cursor ?? `${GRAPH}/me/calendarView/delta?startDateTime=${window.start.toISOString()}&endDateTime=${window.end.toISOString()}`;
    const { items, next } = await this.drainDelta<GraphEvent>(start, ["odata.maxpagesize=50", 'outlook.timezone="UTC"']);
    return { items: items.map(mapGraphEvent), nextCursor: next, fullResync: !cursor };
  }
}

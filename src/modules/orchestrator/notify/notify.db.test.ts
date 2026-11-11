/** Notifications (§9) against the shared DB: dedupe per event key, quiet hours, urgent, grouping, dismiss/snooze (RLS), obsolete cancel. */
import { afterAll, describe, expect, it } from "vitest";
import { adminClient, tag, userClient, USERS, WS1 } from "../../../../tests/helpers";
import { actOnNotification, cancelObsolete, listInbox, notifyUser } from "./service";
import { resolveOrchSettings } from "../schedule/settings";

const admin = adminClient() as any;
const T = tag("orchntf");
const COL = USERS.colleague.id;
const settings = resolveOrchSettings({ workspaceTz: "Asia/Kolkata" }); // fixed: quiet 22:00–07:00, working 09:30–19:00
// Real-time-relative instants (the inbox shows the last 30 days): the next 23:30 IST that is followed by a workday.
function nextNight(): Date {
  const d = new Date(); d.setUTCHours(18, 0, 0, 0);
  if (+d <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  while (![1, 2, 3, 4, 5].includes(new Date(+d + 6 * 3600e3).getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); // following IST day is Mon–Fri
  return d;
}
const NIGHT = nextNight();                                   // 23:30 IST
const MORNING = new Date(+NIGHT + (10 * 60 + 5) * 60_000);   // 09:35 IST next workday
const WORK_START = new Date(+NIGHT + 10 * 3600e3).toISOString();

afterAll(async () => { await admin.from("outbox").delete().eq("workspace_id", WS1).like("dedupe_key", `orch:${T}%`); });

describe("notification service", () => {
  it("never notifies twice for the same event", async () => {
    const a = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", eventKey: `${T}:dup`, title: "Follow up", settings, now: MORNING });
    const b = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", eventKey: `${T}:dup`, title: "Follow up", settings, now: MORNING });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, duplicate: true, outboxId: a.outboxId });
    expect((await admin.from("outbox").select("id").eq("workspace_id", WS1).eq("dedupe_key", `orch:${T}:dup`)).data).toHaveLength(1);
  });

  it("respects quiet hours for info; urgent shows immediately; both link to the record", async () => {
    const rec = { type: "organisation", id: "00000000-0000-4000-8000-0000000000aa" };
    const info = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", eventKey: `${T}:night-info`, title: `${T} info`, record: rec, href: "/x", settings, now: NIGHT });
    const urgent = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", severity: "urgent", eventKey: `${T}:night-urgent`, title: `${T} urgent`, groupKey: `${T}:u`, settings, now: NIGHT });
    expect(info.deliverAfter).toBe(WORK_START);
    expect(urgent.deliverAfter).toBe(NIGHT.toISOString());
    const night = (await listInbox(admin, WS1, COL, { now: NIGHT })).filter((n) => n.title.startsWith(T));
    expect(night.map((n) => n.title)).toEqual([`${T} urgent`]);
    const morning = (await listInbox(admin, WS1, COL, { now: MORNING })).filter((n) => n.title.startsWith(T));
    expect(morning.map((n) => n.title)).toEqual(expect.arrayContaining([`${T} urgent`, `${T} info`]));
    expect(morning.find((n) => n.title === `${T} info`)!.record).toEqual(rec);
  });

  it("groups related notifications into one inbox item", async () => {
    const g = `${T}:group`;
    await notifyUser(admin, WS1, { userId: COL, category: "lease_event", eventKey: `${T}:g1`, title: `${T} lease A`, groupKey: g, settings, now: MORNING });
    const second = await notifyUser(admin, WS1, { userId: COL, category: "lease_event", eventKey: `${T}:g2`, title: `${T} lease B`, groupKey: g, settings, now: MORNING });
    expect(second.grouped).toBe(true);
    const items = (await listInbox(admin, WS1, COL, { now: MORNING })).filter((n) => n.title.startsWith(`${T} lease`));
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(2);
  });

  it("muted categories are not created (unless urgent)", async () => {
    const muted = resolveOrchSettings({ userPrefs: { orchestrator: { notifications: { muted: ["weekly_review"] } } } });
    expect((await notifyUser(admin, WS1, { userId: COL, category: "weekly_review", eventKey: `${T}:muted`, title: "x", settings: muted, now: MORNING })).suppressed).toBe(true);
  });

  it("user can dismiss and snooze own notifications (RLS); obsolete reminders are cancelled", async () => {
    const col = await userClient("colleague");
    const d = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", eventKey: `${T}:dismiss`, title: `${T} dismiss me`, settings, now: MORNING });
    const s = await notifyUser(admin, WS1, { userId: COL, category: "approval", eventKey: `${T}:snooze`, title: `${T} snooze me`, settings, now: MORNING });
    const o = await notifyUser(admin, WS1, { userId: COL, category: "follow_up", eventKey: `${T}:obsolete`, title: `${T} obsolete`, triggerKey: `${T}:cond`, settings, now: MORNING });
    await actOnNotification(col as any, WS1, COL, d.outboxId!, "dismiss", { now: MORNING });
    await actOnNotification(col as any, WS1, COL, s.outboxId!, "snooze", { now: MORNING, until: new Date(+MORNING + 4 * 3600e3).toISOString() });
    expect(await cancelObsolete(admin, WS1, `${T}:cond`, "condition cleared")).toBe(1);
    const titles = (await listInbox(col as any, WS1, COL, { now: MORNING })).map((n) => n.title);
    expect(titles).not.toContain(`${T} dismiss me`);
    expect(titles).not.toContain(`${T} snooze me`);
    expect(titles).not.toContain(`${T} obsolete`);
    expect((await listInbox(col as any, WS1, COL, { now: new Date(+MORNING + 4 * 3600e3 + 60_000) })).map((n) => n.title)).toContain(`${T} snooze me`);
    // another user cannot act on it
    const other = await userClient("owner");
    await expect(actOnNotification(other as any, WS1, USERS.owner.id, o.outboxId!, "dismiss")).rejects.toThrow(/not found/);
  });
});

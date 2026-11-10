import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import * as C from "./service";
import { nextCronRun, cronFromSimple, isValidCron } from "./cron";
import { scheduleCommands, dedupeKeyFor } from "./schedule";
import { enqueue } from "@/lib/jobs/queue";

describe("cron (IST)", () => {
  it("computes the next run in IST", () => {
    // 2026-11-10 10:00 IST = 04:30Z; weekdays 08:00 IST → next is Wed 11 Nov 08:00 IST = 02:30Z
    expect(nextCronRun("0 8 * * 1-5", new Date("2026-11-10T04:30:00Z"))!.toISOString()).toBe("2026-11-11T02:30:00.000Z");
    // before 08:00 IST same day
    expect(nextCronRun("0 8 * * 1-5", new Date("2026-11-10T01:00:00Z"))!.toISOString()).toBe("2026-11-10T02:30:00.000Z");
    // Friday 14:00 IST → Monday 08:00
    expect(nextCronRun("0 8 * * 1-5", new Date("2026-11-13T08:30:00Z"))!.toISOString()).toBe("2026-11-16T02:30:00.000Z");
    expect(nextCronRun("*/15 * * * *", new Date("2026-11-10T04:31:00Z"))!.toISOString()).toBe("2026-11-10T04:45:00.000Z");
    expect(cronFromSimple("07:30", "weekdays")).toBe("30 7 * * 1-5");
    expect(isValidCron("61 * * * *")).toBe(false);
  });
});

describe("saved commands", () => {
  let ctx: C.CmdCtx; const t = tag("cmd"); const created: string[] = [];
  beforeAll(async () => { ctx = { db: await userClient("owner"), workspaceId: WS1, userId: USERS.owner.id }; });
  afterAll(async () => { if (created.length) await adminClient().schema("mudar").from("job").delete().in("dedupe_key", created); });

  it("CRUD, version bump, duplicate, template, fill prompt", async () => {
    const c = await C.createCommand(ctx, { name: `Brief ${t}`, prompt: "Signals in {{city}} for {{days}} days", inputs: [{ key: "city", label: "City", required: true }, { key: "days", label: "Days", required: false, default: "7" }] });
    expect(c.version).toBe(1);
    expect(C.fillPrompt(c, { city: "Pune" }).prompt).toBe("Signals in Pune for 7 days");
    expect(C.fillPrompt(c).missing).toEqual(["City"]);
    const u = await C.updateCommand(ctx, c.id, { description: "x" });
    expect(u.version).toBe(2);
    const d = await C.duplicateCommand(ctx, c.id);
    expect(d.name).toMatch(/copy/); expect(d.id).not.toBe(c.id);
    const tpl = await C.addTemplate(ctx, "overdue_commitments");
    expect(tpl.name).toBe("Show overdue client commitments");
    expect(C.TEMPLATES).toHaveLength(7);
    await C.archiveCommand(ctx, d.id); await C.archiveCommand(ctx, tpl.id);
    expect(await C.getCommand(ctx, d.id)).toBeNull();
  });

  it("scheduled command is not enqueued unless enabled + authorised; dedupe key prevents duplicates", async () => {
    const c = await C.createCommand(ctx, { name: `Sched ${t}`, prompt: "Morning brief" });
    await expect(C.setSchedule(ctx, c.id, { cron: "0 8 * * *", enabled: true })).rejects.toThrow(/authorise/);
    const now = new Date("2026-11-10T04:30:00Z");
    const admin = adminClient() as never;
    // a schedule with a past next_run_at but not enabled → not due
    await adminClient().from("assistant_command").update({ schedule_cron: "0 8 * * *", next_run_at: "2026-11-10T02:30:00Z" }).eq("id", c.id);
    let keys = await scheduleCommands(admin, now, async () => {}, WS1);
    expect(keys.some((k) => k.includes(c.id))).toBe(false);
    // enabled without authorisation (forced in DB) → still not due
    await adminClient().from("assistant_command").update({ schedule_enabled: true }).eq("id", c.id);
    keys = await scheduleCommands(admin, now, async () => {}, WS1);
    expect(keys.some((k) => k.includes(c.id))).toBe(false);
    // proper opt-in
    const s = await C.setSchedule(ctx, c.id, { cron: "0 8 * * *", enabled: true, confirm: true, now: new Date("2026-11-09T04:30:00Z") });
    expect(s.schedule_authorised_at).toBeTruthy(); expect(s.next_run_at).toBe("2026-11-10T02:30:00+00:00");
    const key = dedupeKeyFor(s); created.push(key);
    const enq = (o: Parameters<typeof enqueue>[0]) => enqueue(o);
    await scheduleCommands(admin, now, enq, WS1);
    await scheduleCommands(admin, now, enq, WS1);
    const { data: jobs } = await adminClient().schema("mudar").from("job").select("id").eq("dedupe_key", key);
    expect(jobs).toHaveLength(1);
    // editing the prompt revokes the authorisation
    const e = await C.updateCommand(ctx, c.id, { prompt: "Different prompt" });
    expect(e.schedule_enabled).toBe(false); expect(e.schedule_authorised_at).toBeNull();
    await C.archiveCommand(ctx, c.id);
  });
});

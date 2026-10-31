import { describe, expect, it } from "vitest";
import { localDate } from "@/lib/util/time";
import { inDnd, dndEnd, meetingVersionKey, planSchedule, staleMeetingJobs, type MeetingCtx, type WorkspaceCtx } from "../scheduler";
import { BRIEF_DEFAULTS, fromAdminKeys, resolveSettings } from "../settings";
import { decideUrgentAlert } from "../urgent";

const WS = "ws-1";
const U = "user-1";
const ws = (over: Partial<WorkspaceCtx> = {}): WorkspaceCtx => ({
  id: WS, timezone: "Asia/Kolkata", status: "active", settings: BRIEF_DEFAULTS,
  members: [{ userId: U, role: "owner", settings: BRIEF_DEFAULTS }], ...over,
});
const byType = (specs: ReturnType<typeof planSchedule>, type: string, date?: string) =>
  specs.filter((s) => s.type === type && (!date || (s.payload as { date?: string }).date === date));

describe("scheduler: tz-aware slots and dedupe keys", () => {
  // Monday 2 Nov 2026, 06:00 IST = 00:30Z
  const now = new Date("2026-11-02T00:30:00Z");
  const specs = planSchedule(now, [ws()], []);

  it("08:00 IST brief chain lands at the right UTC instants (07:00 recalc, 07:20 plan, 07:40 generate, 07:55/08:00/08:05)", () => {
    const at = (t: string) => byType(specs, t, "2026-11-02")[0]?.dueAt.toISOString();
    expect(at("brief.recalc")).toBe("2026-11-02T01:30:00.000Z");
    expect(at("brief.plan")).toBe("2026-11-02T01:50:00.000Z");
    expect(at("brief.generate")).toBe("2026-11-02T02:10:00.000Z");
    expect(at("brief.health_check")).toBe("2026-11-02T02:25:00.000Z");
    expect(at("brief.deliver")).toBe("2026-11-02T02:30:00.000Z");
    expect(at("brief.health_alert")).toBe("2026-11-02T02:35:00.000Z");
    expect(at("brief.reconcile")).toBe("2026-11-02T15:00:00.000Z"); // 20:30 IST
  });

  it("repeated ticks produce identical dedupe keys (one job per user/date)", () => {
    const again = planSchedule(new Date("2026-11-02T00:35:00Z"), [ws()], []);
    const keys = (s: typeof specs) => s.map((x) => x.dedupeKey).sort();
    // the 26h horizon rolls forward, but every job from the earlier tick is re-emitted with the same key + due time
    for (const sp of specs) expect(again.find((a) => a.dedupeKey === sp.dedupeKey)?.dueAt.toISOString()).toBe(sp.dueAt.toISOString());
    expect(keys(planSchedule(now, [ws()], []))).toEqual(keys(specs));
    expect(new Set(keys(specs)).size).toBe(specs.length);
    expect(byType(specs, "brief.deliver", "2026-11-02")[0].dedupeKey).toBe(`brief.deliver:${WS}:${U}:2026-11-02`);
  });

  it("weekly review only on Friday 18:00, keyed by ISO week", () => {
    const fri = planSchedule(new Date("2026-11-06T06:00:00Z"), [ws()], []);
    const w = byType(fri, "brief.weekly");
    expect(w).toHaveLength(1);
    expect(w[0].dueAt.toISOString()).toBe("2026-11-06T12:30:00.000Z");
    expect(w[0].dedupeKey).toBe(`brief.weekly:${WS}:${U}:2026-W45`);
    expect(byType(specs, "brief.weekly")).toHaveLength(0);
  });

  it("suspended workspaces get nothing; weekend gets a light brief but no reconciliation", () => {
    expect(planSchedule(now, [ws({ status: "suspended" })], [])).toHaveLength(0);
    const sat = planSchedule(new Date("2026-11-07T00:30:00Z"), [ws()], []);
    expect(byType(sat, "brief.generate", "2026-11-07")).toHaveLength(1);
    expect(byType(sat, "brief.reconcile", "2026-11-07")).toHaveLength(0);
  });

  it("per-user brief time is honoured (09:15 IST)", () => {
    const s = resolveSettings(null, { briefTime: "09:15" });
    const sp = planSchedule(now, [ws({ members: [{ userId: U, role: "owner", settings: s }] })], []);
    expect(byType(sp, "brief.deliver", "2026-11-02")[0].dueAt.toISOString()).toBe("2026-11-02T03:45:00.000Z");
  });
});

describe("IST midnight", () => {
  it("local date flips at 00:00 IST (18:30Z), not at UTC midnight", () => {
    expect(localDate(new Date("2026-11-01T18:29:59Z"), "Asia/Kolkata")).toBe("2026-11-01");
    expect(localDate(new Date("2026-11-01T18:30:00Z"), "Asia/Kolkata")).toBe("2026-11-02");
  });

  it("just after IST midnight the next day's brief is scheduled and keyed to the IST date", () => {
    const sp = planSchedule(new Date("2026-11-01T18:31:00Z"), [ws()], []);
    const d = byType(sp, "brief.deliver").map((s) => (s.payload as { date: string }).date);
    expect(d).toContain("2026-11-02");
    expect(byType(sp, "brief.deliver", "2026-11-02")[0].dueAt.toISOString()).toBe("2026-11-02T02:30:00.000Z");
  });
});

describe("Calendar reschedule (spec acceptance test): T-60 pre-meeting jobs", () => {
  const now = new Date("2026-11-02T03:00:00Z"); // 08:30 IST
  const m: MeetingCtx = { id: "m1", workspaceId: WS, ownerUserId: U, externalId: "ext-1", startAt: "2026-11-02T06:30:00Z", status: "confirmed" };

  it("T-60 job due one hour before start, keyed by external id + start version", () => {
    const [s] = byType(planSchedule(now, [ws()], [m]), "brief.pre_meeting");
    expect(s.dueAt.toISOString()).toBe("2026-11-02T05:30:00.000Z");
    expect(s.dedupeKey).toBe(`brief.pre_meeting:${WS}:m1:ext-1@2026-11-02T06:30:00.000Z`);
    expect(s.payload).toMatchObject({ meetingId: "m1", versionKey: meetingVersionKey(m), userId: U });
  });

  it("reschedule => new key; the old queued job is reported stale; cancelled/deleted => stale and no new job", () => {
    const old = byType(planSchedule(now, [ws()], [m]), "brief.pre_meeting")[0];
    const moved = { ...m, startAt: "2026-11-02T09:30:00Z" };
    const fresh = byType(planSchedule(now, [ws()], [moved]), "brief.pre_meeting")[0];
    expect(fresh.dedupeKey).not.toBe(old.dedupeKey);
    const queued = [{ id: "j1", workspaceId: WS, payload: old.payload as { meetingId: string; versionKey: string } }];
    expect(staleMeetingJobs(queued, [moved])).toEqual([{ id: "j1", reason: "meeting rescheduled" }]);
    expect(staleMeetingJobs(queued, [m])).toEqual([]);
    expect(staleMeetingJobs(queued, [{ ...m, status: "cancelled" }])).toEqual([{ id: "j1", reason: "meeting cancelled" }]);
    expect(staleMeetingJobs(queued, [])).toEqual([{ id: "j1", reason: "meeting deleted" }]);
    expect(byType(planSchedule(now, [ws()], [{ ...m, status: "cancelled" }]), "brief.pre_meeting")).toHaveLength(0);
  });

  it("meeting starting within the lead time is scheduled immediately; past meetings are not", () => {
    const soon = { ...m, startAt: "2026-11-02T03:20:00Z" };
    expect(byType(planSchedule(now, [ws()], [soon]), "brief.pre_meeting")[0].dueAt.toISOString()).toBe(now.toISOString());
    expect(byType(planSchedule(now, [ws()], [{ ...m, startAt: "2026-11-02T02:00:00Z" }]), "brief.pre_meeting")).toHaveLength(0);
  });
});

describe("urgent alerts + DND", () => {
  const tz = "Asia/Kolkata";
  const s = { dnd: { start: "22:00", end: "07:00" }, urgentCategories: ["near_term_visit" as const] };
  const req = { category: "near_term_visit" as const, sourceKey: "msg-1", title: "Visit tomorrow 9am?", activeOpportunity: true, verifiedSender: true };

  it("DND window wraps midnight", () => {
    expect(inDnd(new Date("2026-11-02T17:00:00Z"), s.dnd, tz)).toBe(true);  // 22:30 IST
    expect(inDnd(new Date("2026-11-02T01:00:00Z"), s.dnd, tz)).toBe(true);  // 06:30 IST
    expect(inDnd(new Date("2026-11-02T02:00:00Z"), s.dnd, tz)).toBe(false); // 07:30 IST
    expect(dndEnd(new Date("2026-11-02T17:00:00Z"), s.dnd, tz).toISOString()).toBe("2026-11-03T01:30:00.000Z");
  });

  it("opted-in verified urgent request notifies (dedupe by source); inside DND it is deferred; others wait for the brief", () => {
    expect(decideUrgentAlert(req, s, new Date("2026-11-02T10:00:00Z"), tz)).toEqual({ action: "notify_now", dedupeKey: "urgent:msg-1" });
    expect(decideUrgentAlert(req, s, new Date("2026-11-02T17:00:00Z"), tz)).toMatchObject({ action: "defer_until", dedupeKey: "urgent:msg-1" });
    expect(decideUrgentAlert({ ...req, category: "research_news" }, s, new Date("2026-11-02T10:00:00Z"), tz).action).toBe("queue_for_brief");
    expect(decideUrgentAlert({ ...req, category: "expiring_offer" }, s, new Date("2026-11-02T10:00:00Z"), tz).action).toBe("queue_for_brief");
    expect(decideUrgentAlert({ ...req, verifiedSender: false }, s, new Date("2026-11-02T10:00:00Z"), tz).action).toBe("queue_for_brief");
  });
});

describe("settings", () => {
  it("admin Settings keys drive brief time, cohort targets and fit band; user prefs win for personal keys", () => {
    const admin = { brief_time: { time: "07:30", debrief_time: "21:00" }, cohort_targets: { approaches_per_month_min: 100, approaches_per_month_pace: 150 }, size_rules: { min_sf: 8000, max_sf: 150000 } };
    expect(fromAdminKeys(admin)).toMatchObject({ briefTime: "07:30", debriefTime: "21:00" });
    const s = resolveSettings(null, { briefTime: "08:15", urgent_categories: ["expiring_offer"] }, admin);
    expect(s.briefTime).toBe("08:15");
    expect(s.debriefTime).toBe("21:00");
    expect(s.cohortTarget).toEqual({ minimum: 100, pace: 150 });
    expect(s.fitBand).toEqual({ minSf: 8000, maxSf: 150000 });
    expect(s.urgentCategories).toEqual(["expiring_offer"]);
  });

  it("invalid values fall back to defaults; exploration share clamped to 10–20%", () => {
    const s = resolveSettings({ briefTime: "25:99", capacity: { explorationShare: 0.5 } }, null);
    expect(s.briefTime).toBe("08:00");
    expect(s.capacity.explorationShare).toBe(0.2);
  });
});

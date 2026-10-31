/** Round 2 unit tests (workflows 04 / 13 / 14): pure, no database. Test names state the acceptance criterion. */
import { describe, expect, it } from "vitest";
import { buildSendLink } from "@/lib/services/drafts";
import { checklistFor, conflictAlerts, findTravelConflicts, planRoutes, SITE_VISIT_CHECKLIST, type AgendaItem } from "./calendar";
import { commitmentKey, extractCommitmentsMock, resolveDueDate } from "./commitments";
import { decideLinks, senderDomain, type OrgCandidate, type OppCandidate } from "./links";
import { coalescedSyncJob, graphReceiptKey } from "./push";
import { SEQUENCE_TEMPLATES, withinChannelCap, DEFAULT_CAPS } from "./sequences";
import { mockThreadSummary, threadBasisHash, type ThreadMessage } from "./threads";
import { estimateTravelMinutes, haversineKm } from "./travel";
import { detectContrary, enforceTriageSafety, mockTriage } from "./triage";

const RECEIVED = "2026-11-03T05:00:00.000Z"; // Tue 03 Nov 2026, 10:30 IST

describe("04 deadlines & commitments: dates are resolved in code, unknown stays unknown", () => {
  it("resolves explicit, Indian DD/MM, weekday and relative phrases deterministically", () => {
    expect(resolveDueDate("15 Nov", RECEIVED)).toBe("2026-11-15");
    expect(resolveDueDate("Nov 15th, 2026", RECEIVED)).toBe("2026-11-15");
    expect(resolveDueDate("2026-12-01", RECEIVED)).toBe("2026-12-01");
    expect(resolveDueDate("05/12", RECEIVED)).toBe("2026-12-05");          // DD/MM
    expect(resolveDueDate("2 Jan", RECEIVED)).toBe("2027-01-02");          // past date without year => next year
    expect(resolveDueDate("Friday", RECEIVED)).toBe("2026-11-06");
    expect(resolveDueDate("tomorrow", RECEIVED)).toBe("2026-11-04");
    expect(resolveDueDate("EOD", RECEIVED)).toBe("2026-11-03");
    expect(resolveDueDate("end of month", RECEIVED)).toBe("2026-11-30");
  });
  it("ambiguous or invalid phrases are not coerced into a date", () => {
    expect(resolveDueDate("next Friday", RECEIVED)).toBeNull();
    expect(resolveDueDate("31/02", RECEIVED)).toBeNull();
    expect(resolveDueDate(null, RECEIVED)).toBeNull();
  });
  it("mock extraction finds who / what / date phrase for asks, promises and deadlines", () => {
    const text = "Hi Rahul,\nPlease send the revised commercials by 15 Nov. I will share the updated headcount plan by Friday. The LOI offer expires on 20/11.\nThanks";
    const c = extractCommitmentsMock(text, "Priya Shah");
    expect(c).toEqual(expect.arrayContaining([
      expect.objectContaining({ who: "adviser", kind: "commitment", due_text: "15 Nov" }),
      expect.objectContaining({ who: "sender", who_name: "Priya Shah", due_text: "Friday" }),
      expect.objectContaining({ kind: "deadline", due_text: "20/11" }),
    ]));
    expect(new Set(c.map(commitmentKey)).size).toBe(c.length);
  });
  it("mock triage carries commitments; suspicious mail carries none", () => {
    const t = mockTriage({ fromName: "Priya", subject: "Shortlist", body: "Please send the floor plans by tomorrow." });
    expect(t.commitments[0]).toMatchObject({ who: "adviser", due_text: "tomorrow" });
    const s = enforceTriageSafety({ ...t, injection_suspected: true }, "x");
    expect(s.commitments).toEqual([]);
  });
});

describe("13 contrary information is detected deterministically", () => {
  it("not interested / already moved / wrong timing", () => {
    expect(detectContrary("Thanks, but we have already signed the lease in Kharadi.")?.kind).toBe("already_moved");
    expect(detectContrary("We are not interested at the moment.")?.kind).toBe("not_interested");
    expect(detectContrary("Not the right time — please reach out next quarter.")?.kind).toBe("wrong_timing");
    expect(detectContrary("Happy to talk on Thursday.")).toBeNull();
  });
  it("an opt-out is an opt-out, not contrary info", () => {
    const t = mockTriage({ fromName: "A", subject: "Re", body: "Not interested, please stop emailing me." });
    expect(t.category).toBe("opt_out");
    expect(t.contrary_info).toBeNull();
  });
});

describe("04 links only on strong evidence; ambiguous => suggestion", () => {
  const org = (id: string, via: OrgCandidate["via"]): OrgCandidate => ({ id, name: id, via, detail: `${via} ${id}` });
  const opp = (id: string, via: OppCandidate["via"]): OppCandidate => ({ id, name: id, org_id: "o1", via, detail: `${via} ${id}` });
  it("single current employer (matching domain) links org and its single open opportunity", () => {
    const r = decideLinks([org("o1", "employment"), org("o1", "email_domain")], (ids) => ids.includes("o1") ? [opp("p1", "organisation")] : []);
    expect(r).toMatchObject({ orgIds: ["o1"], opportunityIds: ["p1"], suggestions: [] });
    expect(r.evidence.map((e) => e.basis)).toEqual(["employment", "email_domain", "organisation"]);
  });
  it("employer vs domain disagreement, or two orgs on one domain => nothing linked, both suggested", () => {
    expect(decideLinks([org("o1", "employment"), org("o2", "email_domain")], () => [])).toMatchObject({ orgIds: [], suggestions: [expect.anything(), expect.anything()] });
    expect(decideLinks([org("o1", "email_domain"), org("o2", "email_domain")], () => []).orgIds).toEqual([]);
  });
  it("several open opportunities => suggestions; stakeholder evidence wins over org-only", () => {
    const r = decideLinks([org("o1", "email_domain")], () => [opp("p1", "organisation"), opp("p2", "organisation")]);
    expect(r.opportunityIds).toEqual([]);
    expect(r.suggestions.filter((s) => s.entity_type === "opportunity")).toHaveLength(2);
    expect(decideLinks([org("o1", "email_domain")], () => [opp("p1", "organisation"), opp("p2", "organisation"), opp("p2", "stakeholder")]).opportunityIds).toEqual(["p2"]);
  });
  it("free mailbox domains never identify an organisation", () => {
    expect(senderDomain("someone@gmail.com")).toBeNull();
    expect(senderDomain("a@Example-GCC.com")).toBe("example-gcc.com");
  });
});

describe("04 thread summaries", () => {
  const m = (id: string, folder: "inbox" | "sent", at: string, summary?: string): ThreadMessage => ({
    id, provider: "mock", provider_message_id: id, internet_message_id: `<${id}@x>`, folder, from_name: folder === "inbox" ? "Priya" : null, from_address: "p@x.in",
    to_addresses: [], subject: "Baner options", received_at: at, body_excerpt: "", triage: summary ? { summary, category: "reply", next_actions: ["Reply"] } : null,
    commitments: [], matched_person_ids: [], matched_org_ids: [], matched_opportunity_ids: [], owner_user_id: null,
  });
  it("basis hash changes exactly when a message joins the thread (order-independent)", () => {
    const a = m("a", "inbox", "2026-11-01T05:00:00Z", "Asked for options"), b = m("b", "sent", "2026-11-01T07:00:00Z");
    expect(threadBasisHash([a, b])).toBe(threadBasisHash([b, a]));
    expect(threadBasisHash([a])).not.toBe(threadBasisHash([a, b]));
  });
  it("deterministic summary reflects who the thread is waiting on", () => {
    const a = m("a", "inbox", "2026-11-01T05:00:00Z", "Asked for options");
    expect(mockThreadSummary([a]).state).toBe("awaiting_us");
    expect(mockThreadSummary([a, m("b", "sent", "2026-11-01T07:00:00Z")]).state).toBe("awaiting_them");
    expect(mockThreadSummary([a]).summary).toMatch(/1 message with Priya/);
  });
});

describe("04 push sync dedupe keys", () => {
  const now = new Date("2026-11-03T05:00:30Z");
  it("the same Graph notification has the same receipt key; a different message does not", () => {
    const n = { subscriptionId: "s1", changeType: "created", resource: "me/messages/AAA", resourceData: { id: "AAA" }, clientState: "x" };
    expect(graphReceiptKey(n, now)).toBe(graphReceiptKey({ ...n }, new Date(now.getTime() + 3_600_000)));
    expect(graphReceiptKey({ ...n, resourceData: { id: "BBB" } }, now)).not.toBe(graphReceiptKey(n, now));
  });
  it("a burst of notifications coalesces into one sync job per connector per minute, due after the window", () => {
    const a = coalescedSyncJob("integrations.inbox_sync", "acc", now);
    expect(coalescedSyncJob("integrations.inbox_sync", "acc", new Date(now.getTime() + 20_000)).dedupeKey).toBe(a.dedupeKey);
    expect(a.dueAt.getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("13 WhatsApp sequence channel", () => {
  it("WhatsApp template uses a manual wa.me link and the WhatsApp cap", () => {
    expect(SEQUENCE_TEMPLATES.whatsapp.steps.map((s) => s.channel)).toEqual(["email", "whatsapp", "email"]);
    expect(buildSendLink({ channel: "whatsapp", recipient_address: "+91 98220 12345", recipient_display: null, subject: null, body: "Hi" }).href).toMatch(/^https:\/\/wa\.me\/919822012345/);
    const now = new Date("2026-11-03T00:00:00Z");
    expect(withinChannelCap(["2026-10-25T00:00:00Z"], DEFAULT_CAPS.whatsapp, now)).toBe(false); // 1 per 14 days
    expect(withinChannelCap(["2026-10-01T00:00:00Z"], DEFAULT_CAPS.whatsapp, now)).toBe(true);
  });
});

describe("14 travel estimates, travel conflicts and route clusters", () => {
  const baner = { lat: 18.559, lon: 73.786 }, balewadi = { lat: 18.575, lon: 73.773 }, kharadi = { lat: 18.551, lon: 73.935 };
  const item = (id: string, start: string, end: string, p: { lat: number; lon: number } | null, extra: Partial<AgendaItem> = {}): AgendaItem => ({
    id, title: id, start_at: start, end_at: end, status: "confirmed", kind: "site_visit", lat: p?.lat ?? null, lon: p?.lon ?? null, owner_user_id: "u1", version_key: `v-${id}-${start}`, ...extra,
  });
  it("haversine × road factor ÷ city speed, rounded up to 5 min, never below 10", () => {
    expect(haversineKm(baner, kharadi)).toBeGreaterThan(15);
    expect(estimateTravelMinutes(baner, kharadi)).toBe(Math.max(10, Math.ceil(((haversineKm(baner, kharadi) * 1.4) / 20) * 60 / 5) * 5));
    expect(estimateTravelMinutes(baner, balewadi)).toBe(10);
  });
  it("a 15-minute gap between Baner and Kharadi is a travel conflict; Baner→Balewadi is fine", () => {
    const items = [
      item("a", "2026-11-05T05:00:00Z", "2026-11-05T06:00:00Z", baner),
      item("b", "2026-11-05T06:15:00Z", "2026-11-05T07:00:00Z", kharadi),
      item("c", "2026-11-05T08:00:00Z", "2026-11-05T09:00:00Z", kharadi),
      item("d", "2026-11-05T09:15:00Z", "2026-11-05T10:00:00Z", { lat: 18.5515, lon: 73.936 }),
    ];
    const t = findTravelConflicts(items);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ a: "a", b: "b", gapMinutes: 15 });
    expect(t[0].travelMinutes).toBeGreaterThan(15);
    const routes = planRoutes(items);
    expect(routes.map((r) => r.items.map((x) => x.id))).toEqual([["a"], ["b", "c", "d"]]);
    expect(routes[1].legs.every((l) => l.feasible)).toBe(true);
  });
  it("conflict alerts: overlap + travel, dedupe key stable on replay and new after a reschedule", () => {
    const now = new Date("2026-11-04T00:00:00Z");
    const items = [item("a", "2026-11-05T05:00:00Z", "2026-11-05T06:00:00Z", baner), item("b", "2026-11-05T05:30:00Z", "2026-11-05T06:30:00Z", baner),
      item("c", "2026-11-05T06:40:00Z", "2026-11-05T07:00:00Z", kharadi)];
    const a1 = conflictAlerts(items, "Asia/Kolkata", now);
    expect(a1.map((x) => x.kind).sort()).toEqual(["overlap", "travel"]);
    expect(conflictAlerts(items, "Asia/Kolkata", now).map((x) => x.dedupeKey)).toEqual(a1.map((x) => x.dedupeKey));
    const moved = items.map((i) => (i.id === "b" ? { ...i, version_key: "v-b-moved" } : i));
    expect(conflictAlerts(moved, "Asia/Kolkata", now).find((x) => x.kind === "overlap")!.dedupeKey).not.toBe(a1.find((x) => x.kind === "overlap")!.dedupeKey);
    expect(conflictAlerts(items, "Asia/Kolkata", new Date("2026-11-06T00:00:00Z"))).toEqual([]); // past conflicts don't alert
  });
});

describe("14 visit checklist", () => {
  it("site visits get the default checklist merged with stored ticks and custom items", () => {
    const list = checklistFor("site_visit", [{ id: "1", item_key: "access", label: "x", position: 20, done: true }, { id: "2", item_key: "custom:abc", label: "Check DG fuel", position: 1000, done: false }]);
    expect(list).toHaveLength(SITE_VISIT_CHECKLIST.length + 1);
    expect(list.find((i) => i.key === "access")!.done).toBe(true);
    expect(list[list.length - 1]).toMatchObject({ key: "custom:abc", custom: true });
    expect(checklistFor("call", [])).toEqual([]);
  });
});

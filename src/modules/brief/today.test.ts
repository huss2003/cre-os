import { describe, expect, it } from "vitest";
import { buildAccounts, buildFollowups, buildLeaseEvents, buildMeetings, buildMilestones, buildSignals, leaseWindow, loadToday, recommendActions, type AccountRow } from "./today";
import { loadCurrentScoresWithSource, scoreResultToRow, tierFromScoreResult } from "./plan";

/** Minimal chainable Supabase stand-in: table → rows | Error | "hang"; records which tables were read. */
export function fakeDb(tables: Record<string, any[] | Error | "hang">, reads: string[] = []) {
  return {
    reads,
    from(t: string) {
      reads.push(t);
      const v = tables[t] ?? [];
      const res = () => (v === "hang" ? new Promise(() => {}) : Promise.resolve(v instanceof Error ? { data: null, error: { message: v.message }, count: null } : { data: v, error: null, count: v.length }));
      const b: any = new Proxy({}, { get: (_o, k) => (k === "then" ? (ok: any, ko: any) => res().then(ok, ko) : k === "maybeSingle" ? () => res().then((r: any) => ({ ...r, data: r.data?.[0] ?? null })) : () => b) });
      return b;
    },
  };
}

const TODAY = "2026-11-11"; // Wednesday
const NOW = new Date("2026-11-11T03:30:00Z"); // 09:00 IST
const acct = (id: string, score: number, extra: Partial<AccountRow> = {}): AccountRow => ({
  entity_id: id, score, band: "High", disqualified: false, confidence: "medium", completeness: 80, missing: [], recommended_action: "Call the CFO",
  factors: [{ key: "need", label: "Identifiable need", known: true, points: 20, max: 25, explanation: "Lease expires Mar 2027" }, { key: "budget", label: "Budget", known: false, points: 0, max: 10, explanation: "No data." }],
  ...extra,
});

describe("section builders", () => {
  it("accounts: top 10 by current lead score with why-now; unknown is listed separately, never as low", () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => acct(`o${i}`, 90 - i)), acct("unk", 0, { confidence: "insufficient", completeness: 20, missing: ["lease expiry", "contact"] }), acct("dq", 0, { disqualified: true })];
    const names = new Map(rows.map((r) => [r.entity_id, r.entity_id.toUpperCase()]));
    const s = buildAccounts(rows, names, null);
    expect(s.source).toBe("score_result");
    expect(s.items).toHaveLength(10);
    expect(s.items[0].title).toBe("O0");
    expect(s.items[0].detail).toContain("Call the CFO");
    expect(s.items[0].detail).toContain("Lease expires Mar 2027");
    expect(s.items.map((i) => i.id)).not.toContain("unk");
    expect(s.missing.map((m) => m.title)).toEqual(["UNK"]);
    expect(s.missing[0].badges.map((b) => b.label)).toContain("score unknown — not low");
    expect(s.items[0].href).toBe("/scoring/lead/o0");
  });

  it("accounts: legacy lead_score only when no score_result rows, and labelled", () => {
    const s = buildAccounts([], new Map([["a", "Acme"]]), [{ subject_id: "a", total: 71, tier: "act_this_week" }]);
    expect(s.source).toBe("lead_score_legacy");
    expect(s.note).toMatch(/Legacy lead_score/);
    expect(s.items[0].badges.map((b) => b.label)).toContain("legacy score");
    // score_result present → legacy ignored
    expect(buildAccounts([acct("b", 50)], new Map([["b", "B"], ["a", "Acme"]]), [{ subject_id: "a", total: 99, tier: "x" }]).items.map((i) => i.title)).toEqual(["B"]);
  });

  it("meetings: today's unprepared meeting ranks high with a Prepare link; ready prep is not recommended", () => {
    const s = buildMeetings([
      { id: "p1", status: "preparation_pending", readiness: 30, meeting: { title: "Acme review", start_at: "2026-11-11T08:30:00Z" }, org: { display_name: "Acme" } },
      { id: "p2", status: "brief_ready", readiness: 90, meeting: { title: "Beta", start_at: "2026-11-12T05:00:00Z" }, org: null },
    ], TODAY, "Asia/Kolkata");
    expect(s.items[0]).toMatchObject({ href: "/meetings/p1", actionLabel: "Prepare", urgency: 90 });
    expect(s.items[0].title).toMatch(/^Today 14:00/);
    expect(s.items[1]).toMatchObject({ actionLabel: "Review brief", urgency: 0 });
  });

  it("lease windows: 3/6/12 months by edate, lock-in/notice as deadlines, past dates dropped", () => {
    expect(leaseWindow("expiry", "2027-01-20", TODAY)).toBe("3 months");
    expect(leaseWindow("expiry", "2027-04-01", TODAY)).toBe("6 months");
    expect(leaseWindow("break", "2027-10-01", TODAY)).toBe("12 months");
    expect(leaseWindow("expiry", "2027-12-01", TODAY)).toBeNull();
    expect(leaseWindow("notice_deadline", "2026-11-20", TODAY)).toBe("deadline");
    expect(leaseWindow("lockin_end", "2026-11-01", TODAY)).toBeNull();
    const s = buildLeaseEvents([
      { id: "e1", event_type: "expiry", event_date: "2027-04-01", date_basis: "contractual", confirmed: true, lease: { tenant_name_raw: "X" } },
      { id: "e2", event_type: "notice_deadline", event_date: "2026-11-21", date_basis: "estimated", confirmed: false, lease: { tenant: { display_name: "Acme" } } },
    ], TODAY);
    expect(s.items[0].id).toBe("e2");
    expect(s.items[0].urgency).toBe(90);
    expect(s.items[0].badges.map((b) => b.label)).toContain("estimated · unconfirmed");
  });

  it("follow-ups, signals and milestones rank overdue first and link to the record", () => {
    const f = buildFollowups([{ id: "o1", planned_on: "2026-11-08", channel: "email", person: { full_name: "Ravi" }, org: null }],
      [{ id: "t1", title: "Send heads of terms", due_at: "2026-11-11T10:00:00Z" }], TODAY, "Asia/Kolkata");
    expect(f.items.map((i) => i.href)).toEqual(["/outreach/o1", "/tasks"]);
    expect(f.items[0].badges[0].label).toBe("3 d overdue");
    const sg = buildSignals([{ id: "s1", title: "Pune GCC", status: "new", verification: "hypothesis", priority: 80, priority_band: "high", recommended_action: "Verify with HR head" }], "Tue 10 Nov");
    expect(sg.items[0]).toMatchObject({ href: "/signals/s1", actionLabel: "Review", urgency: 68 });
    const m = buildMilestones([{ id: "m1", title: "Fit-out approval", due_date: "2026-11-09", status: "open", opportunity_id: "op1", opportunity: { name: "Acme move" } }], TODAY);
    expect(m.items[0]).toMatchObject({ href: "/deals/op1", urgency: 87 });
  });

  it("recommended: deterministic top 5 across sections, failed sections excluded", () => {
    const mk = (key: any, urg: number[], state: "ok" | "failed" = "ok") => ({ key, title: key, state, empty: { text: "", href: "", label: "" },
      items: urg.map((u, i) => ({ id: `${key}${i}`, title: `${key}${i}`, badges: [], href: `/${key}/${i}`, actionLabel: "Go", urgency: u, reason: `r${u}` })) });
    const r = recommendActions([mk("accounts", [59, 0]), mk("leases", [95]), mk("followups", [80, 81]), mk("signals", [99], "failed"), mk("meetings", [90, 75])]);
    expect(r.map((i) => i.urgency)).toEqual([95, 90, 81, 80, 75]);
    expect(r.every((i) => i.reason)).toBe(true);
    expect(recommendActions([mk("accounts", [59, 0]), mk("leases", [95])])).toEqual(recommendActions([mk("leases", [95]), mk("accounts", [59, 0])]));
  });
});

describe("loadToday", () => {
  const base = {
    meeting_prep: [], signal: [], outreach_item: [], task: [], change_proposal: [{ id: 1 }, { id: 2 }], assistant_approval: [{ id: 3 }], lease_event: [], deal_milestone: [],
    score_result: [acct("o1", 77)], organisation: [{ id: "o1", display_name: "Acme" }], lead_score: [{ subject_id: "zz", total: 99, tier: "act_this_week" }],
  };

  it("assembles sections from the new tables and never reads lead_score when score_result has rows", async () => {
    const reads: string[] = [];
    const v = await loadToday({ db: fakeDb(base, reads), workspaceId: "w", userId: "u" }, NOW);
    expect(v.date).toBe(TODAY);
    expect(v.since).toBe("2026-11-10");
    expect(v.failed).toEqual([]);
    expect(v.sections.accounts.items.map((i) => i.title)).toEqual(["Acme"]);
    expect(reads).toContain("score_result");
    expect(reads).not.toContain("lead_score");
    expect(v.sections.approvals.items[0].title).toBe("3 pending approvals");
    expect(v.sections.meetings.items).toEqual([]);
    expect(v.sections.meetings.empty.text).toMatch(/Add one/);
    expect(v.recommended.map((r) => r.title)).toEqual(["Acme", "3 pending approvals"]);
  });

  it("a failing or slow section is marked failed (visible), others still load", async () => {
    const v = await loadToday({ db: fakeDb({ ...base, signal: new Error("boom"), deal_milestone: "hang" }), workspaceId: "w", userId: "u" }, NOW, { timeoutMs: 50 });
    expect(v.sections.signals.state).toBe("failed");
    expect(v.sections.milestones.state).toBe("failed");
    expect(v.failed.sort()).toEqual(["milestones", "signals"]);
    expect(v.sections.accounts.state).toBe("ok");
  });
});

describe("plan scores: lead_score → score_result", () => {
  const ctx = (tables: any, reads: string[]) => ({ db: fakeDb(tables, reads) as any, workspaceId: "w", userId: "u", tz: "Asia/Kolkata", access: null });
  const sr = { entity_id: "o1", score: 72, band: "High", disqualified: false, confidence: "medium", completeness: 80, missing: [], recommended_action: null, calculated_at: "2026-11-11T00:00:00Z",
    factors: [{ key: "authority", label: "Decision-maker access", known: true, points: 12, max: 15, explanation: "CFO known" }, { key: "evidence", label: "Evidence", known: true, points: 5, max: 10, explanation: "news" }] };

  it("reads score_result first and maps it to plan rows", async () => {
    const reads: string[] = [];
    const r = await loadCurrentScoresWithSource(ctx({ score_result: [sr], lead_score: [{ subject_id: "o1", total: 10, tier: "suppressed" }], organisation: [{ id: "o1", display_name: "Acme" }] }, reads));
    expect(r.source).toBe("score_result");
    expect(reads).not.toContain("lead_score");
    expect(r.rows[0]).toMatchObject({ subject_id: "o1", name: "Acme", total: 72, tier: "act_this_week" });
    expect(r.rows[0].components.relationship).toMatchObject({ points: 12, max: 15 });
  });

  it("falls back to lead_score (labelled) only when the workspace has no score_result rows", async () => {
    const reads: string[] = [];
    const r = await loadCurrentScoresWithSource(ctx({ score_result: [], lead_score: [{ subject_id: "o1", total: 55, tier: "validate_nurture", components: {}, overrides: [] }], organisation: [{ id: "o1", display_name: "Acme" }] }, reads));
    expect(r.source).toBe("lead_score_legacy");
    expect(r.rows[0].total).toBe(55);
    expect((await loadCurrentScoresWithSource(ctx({}, []))).source).toBe("none");
  });

  it("tier: disqualified → suppressed, insufficient (unknown) → enrich, not ranked low", () => {
    expect(tierFromScoreResult({ score: 90, disqualified: true, confidence: "high" })).toBe("suppressed");
    expect(tierFromScoreResult({ score: 90, disqualified: false, confidence: "insufficient" })).toBe("enrich_or_park");
    expect(tierFromScoreResult({ score: 45, disqualified: false, confidence: "low" })).toBe("validate_nurture");
    expect(scoreResultToRow(sr as any).evidence_confidence).toBe("credible_reported");
  });
});

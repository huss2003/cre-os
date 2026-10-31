/** Workflow 17 acceptance (pure): blocked dependencies are visible; overdue / blocked alerts are deduped. */
import { describe, it, expect } from "vitest";
import { closingAlerts, dependencyTimeline, outstandingDocuments, wouldCycle, type MilestoneLite } from "./closing";
import { CLOSING_TEMPLATE } from "./stages";

const m = (id: string, o: Partial<MilestoneLite> = {}): MilestoneLite => ({
  id, opportunity_id: "opp1", title: id.toUpperCase(), kind: "document", status: "open", due_date: null, depends_on: null,
  required_for_stage: null, proof_required: false, sort_order: 0, ...o,
});

describe("closing coordinator: dependency timeline", () => {
  it("blocked dependencies are visible: a dependant lists every uncleared prerequisite it waits on", () => {
    const items = [m("loi", { due_date: "2026-11-01" }), m("legal", { depends_on: "loi", due_date: "2026-11-10" }), m("approval", { depends_on: "legal", due_date: "2026-11-05" }), m("free")];
    const tl = dependencyTimeline(items, "2026-10-31");
    const byId = new Map(tl.map((t) => [t.id, t]));
    expect(byId.get("approval")!.blocked).toBe(true);
    expect(byId.get("approval")!.waitingOn.map((w) => w.title)).toEqual(["LEGAL", "LOI"]);
    expect(byId.get("approval")!.level).toBe(2);
    expect(byId.get("approval")!.earliestFinish).toBe("2026-11-10"); // cannot finish before its prerequisite's due date
    expect(byId.get("free")!.blocked).toBe(false);
    expect(tl.map((t) => t.id).slice(0, 2).sort()).toEqual(["free", "loi"]); // level 0 first
    // clearing the prerequisite unblocks the dependant
    const tl2 = dependencyTimeline(items.map((x) => (x.id === "loi" ? { ...x, status: "done" } : x.id === "legal" ? { ...x, status: "waived" } : x)), "2026-10-31");
    expect(tl2.find((t) => t.id === "approval")!.blocked).toBe(false);
  });

  it("detects cycles before they are saved", () => {
    const items = [m("a"), m("b", { depends_on: "a" }), m("c", { depends_on: "b" })];
    expect(wouldCycle(items, "a", "c")).toBe(true);
    expect(wouldCycle(items, "a", "a")).toBe(true);
    expect(wouldCycle(items, "c", "a")).toBe(false);
  });

  it("CLOSING_TEMPLATE dependencies reference existing keys and form no cycle", () => {
    const keys = new Set(CLOSING_TEMPLATE.map((t) => t.key));
    for (const t of CLOSING_TEMPLATE) if (t.depends_on) expect(keys.has(t.depends_on)).toBe(true);
    const items = CLOSING_TEMPLATE.map((t) => m(t.key, { depends_on: t.depends_on }));
    for (const t of items) expect(wouldCycle(items.filter((x) => x.id !== t.id), t.id, t.depends_on)).toBe(false);
  });
});

describe("closing coordinator: overdue / blocked alerts", () => {
  it("raises overdue and blocked alerts with stable dedupe keys (re-running adds nothing new)", () => {
    const items = [m("loi", { due_date: "2026-10-20" }), m("legal", { depends_on: "loi", due_date: "2026-11-05" }), m("manual", { status: "blocked" }), m("done", { status: "done", due_date: "2026-01-01" })];
    const a1 = closingAlerts(items, "2026-10-31");
    expect(a1.map((a) => `${a.kind}:${a.milestoneId}`).sort()).toEqual(["blocked:legal", "blocked:manual", "overdue:loi"]);
    expect(a1.find((a) => a.milestoneId === "loi")!.message).toMatch(/11 days overdue/);
    expect(a1.find((a) => a.milestoneId === "legal")!.message).toMatch(/blocked by overdue "LOI"/);
    const a2 = closingAlerts(items, "2026-11-01");
    expect(a2.map((a) => a.dedupeKey).sort()).toEqual(a1.map((a) => a.dedupeKey).sort()); // same condition → same keys next day
    // a new due date is a new condition → new key
    const a3 = closingAlerts(items.map((x) => (x.id === "loi" ? { ...x, due_date: "2026-10-25" } : x)), "2026-11-01");
    expect(a3.find((a) => a.kind === "overdue")!.dedupeKey).not.toBe(a1.find((a) => a.kind === "overdue")!.dedupeKey);
  });

  it("outstanding-documents list: open document items, proof gaps and unreleased / stale client documents (latest version only)", () => {
    const items = [m("loi", { proof_required: true }), m("lease", { status: "done", proof_required: true, proof_text: null }), m("it", { kind: "move_dependency" })];
    const docs = [
      { id: "d1", purpose: "proposal", status: "approved", family_id: "f1", version_no: 1, input_versions: { title: "Proposal" } },
      { id: "d2", purpose: "proposal", status: "stale", family_id: "f1", version_no: 2, input_versions: { title: "Proposal", released_at: "2026-10-01" } },
      { id: "d3", purpose: "shortlist_deck", status: "released", family_id: "f2", version_no: 1, input_versions: {} },
    ];
    const out = outstandingDocuments(items, docs, "2026-10-31");
    expect(out.map((o) => o.id)).toEqual(["loi", "lease", "d2"]);
    expect(out.find((o) => o.id === "lease")!.status).toBe("proof missing");
    expect(out.find((o) => o.id === "d2")!.note).toMatch(/re-review before sharing again/);
  });
});

import { describe, it, expect } from "vitest";
import { parseFilter, filterHref, toListFilter, activeFilterCount, httpOnly, runSignalForm, FormProblem } from "./ui-data";

const U = "00000000-0000-4000-8000-000000000001";
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("signals UI — view/filter query builders", () => {
  it("parses every spec §10 filter and drops invalid values", () => {
    const f = parseFilter({ view: "lease", q: " acme ", orgId: U, industry: "IT", microMarket: "Kharadi", category: "expansion", subType: "new_office",
      eventFrom: "2026-01-01", eventTo: "nope", from: "2026-02-01", to: "2026-03-01", freshDays: "30", confidence: "high", urgency: "medium",
      status: "snoozed", source: "Press release", assigned: "me", sort: "event" });
    expect(f).toMatchObject({ view: "lease", q: "acme", orgId: U, industry: "IT", microMarket: "Kharadi", category: "expansion", subType: "new_office",
      eventFrom: "2026-01-01", from: "2026-02-01", to: "2026-03-01", freshDays: 30, confidence: "high", urgency: "medium", status: "snoozed", source: "Press release", assigned: "me", sort: "event" });
    expect(f.eventTo).toBeUndefined();
    const bad = parseFilter({ view: "drop table", orgId: "x", category: "spam", confidence: "very", freshDays: "-1", assigned: "someone", status: "x" });
    expect(bad).toEqual({ view: "all" });
  });
  it("arrays take the first value", () => { expect(parseFilter({ view: ["high", "lease"] }).view).toBe("high"); });
  it("builds hrefs that keep filters, override, and drop empties", () => {
    const f = parseFilter({ view: "high", q: "a b", urgency: "high" });
    expect(filterHref(f)).toBe("/signals?view=high&q=a+b&urgency=high");
    expect(filterHref(f, { view: "lease", urgency: undefined })).toBe("/signals?view=lease&q=a+b");
    expect(filterHref({ view: "all" })).toBe("/signals");
    expect(parseFilter(Object.fromEntries(new URL(`http://x${filterHref(f)}`).searchParams))).toEqual(f);
  });
  it("maps to the backend ListFilter with userId and counts active filters", () => {
    const f = parseFilter({ view: "all", assigned: "me", confidence: "low", sort: "detected" });
    expect(toListFilter(f, U)).toMatchObject({ view: "all", assigned: "me", userId: U, confidence: "low" });
    expect(activeFilterCount(f)).toBe(2);
  });
});

describe("signals UI — action form validation", () => {
  const ok = async () => ({ ok: true });
  const ctx = (role: string) => ({ db: {} as never, workspaceId: U, userId: U, role });
  it("only http/https evidence links", () => {
    expect(httpOnly("https://example.com/a")).toBe("https://example.com/a");
    expect(httpOnly(undefined)).toBeUndefined();
    expect(() => httpOnly("javascript:alert(1)")).toThrow(FormProblem);
    expect(() => httpOnly("ftp://x.com")).toThrow(FormProblem);
    expect(() => httpOnly("not a url")).toThrow(FormProblem);
  });
  it("refuses viewers, unknown actions, missing reasons and bad links before calling the backend", async () => {
    let calls = 0; const act = async () => { calls++; return {}; };
    await expect(runSignalForm(ctx("viewer"), U, fd({ action: "approve" }), act)).rejects.toThrow(/view-only/);
    await expect(runSignalForm(ctx("editor"), U, fd({ action: "delete_everything" }), act)).rejects.toThrow(/Unknown/);
    await expect(runSignalForm(ctx("editor"), U, fd({ action: "dismiss" }), act)).rejects.toThrow(/reason/);
    await expect(runSignalForm(ctx("editor"), U, fd({ action: "override_priority", band: "high" }), act)).rejects.toThrow(/reason/);
    await expect(runSignalForm(ctx("editor"), U, fd({ action: "snooze" }), act)).rejects.toThrow(/date/);
    await expect(runSignalForm(ctx("editor"), U, fd({ action: "add_evidence", text: "x", url: "javascript:alert(1)" }), act)).rejects.toThrow(/http/);
    await expect(runSignalForm(ctx("editor"), "not-a-uuid", fd({ action: "approve" }), act)).rejects.toThrow(/not found/);
    expect(calls).toBe(0);
    const r = await runSignalForm(ctx("editor"), U, fd({ action: "dismiss", reason: " dup " }), ok);
    expect(r.action).toBe("dismiss");
  });
});

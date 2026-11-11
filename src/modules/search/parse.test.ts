import { describe, it, expect } from "vitest";
import { parseAccountQuery } from "./parse";
import { resolveWindow, filterChips, dropChip, encodeFilter, decodeFilter, filterFromForm } from "./filter";

const PLACES = [{ name: "Kharadi", aliases: ["EON Kharadi"] }, { name: "Hinjewadi", aliases: ["Hinjawadi"] }, { name: "Pune" }];
const T = "2026-11-11";
const p = (s: string) => parseAccountQuery(s, PLACES, T).filter;

describe("deterministic NL parser", () => {
  it("spec example", () => {
    expect(p("Show companies occupying 15,000–40,000 SF in Kharadi with a lease event next year and a contact I already know")).toEqual({
      areaMinSf: 15000, areaMaxSf: 40000, places: ["Kharadi"], eventWindow: { kind: "next_calendar_year" }, knownContact: true,
    });
  });
  it("k notation, sq ft, basis, alias place, expiry within months", () => {
    expect(p("15k-40k sq ft chargeable in Hinjawadi expiring within 6 months")).toEqual({
      areaMinSf: 15000, areaMaxSf: 40000, areaBasis: "chargeable", places: ["Hinjewadi"], eventTypes: ["expiry"], eventWindow: { kind: "within_months", months: 6 },
    });
  });
  it("between … and …, '15-40k sf', over / under", () => {
    expect(p("between 20000 and 35000 sqft carpet")).toMatchObject({ areaMinSf: 20000, areaMaxSf: 35000, areaBasis: "carpet" });
    expect(p("15-40k sf in Pune")).toMatchObject({ areaMinSf: 15000, areaMaxSf: 40000, places: ["Pune"] });
    expect(p("tenants over 50,000 sf")).toEqual({ areaMinSf: 50000 });
    expect(p("occupiers under 10k sft")).toEqual({ areaMaxSf: 10000 });
  });
  it("lock-in / notice / break, grade, known contact variants, priority, deals, signals", () => {
    expect(p("lock-in ending in the next 12 months, grade A+")).toMatchObject({ eventTypes: ["lockin_end"], eventWindow: { kind: "within_months", months: 12 }, grades: ["A+"] });
    expect(p("notice deadline this year")).toMatchObject({ eventTypes: ["notice_deadline"], eventWindow: { kind: "this_calendar_year" } });
    expect(p("known contacts at BFSI companies")).toMatchObject({ knownContact: true, sectors: ["BFSI"] });
    expect(p("hot leads with an open deal")).toMatchObject({ scoreBands: ["Very High", "High"], hasOpenOpportunity: true });
    expect(p("no open deal but a confirmed requirement")).toMatchObject({ hasOpenOpportunity: false, requirementStatuses: ["client_confirmed"] });
    expect(p("expansion signal since 2026-09-01")).toMatchObject({ signalKinds: ["expansion"], signalSince: "2026-09-01" });
  });
  it("does not invent: no place for unknown names, no window without a lease context", () => {
    expect(p("companies in Atlantis next year")).toEqual({});
    expect(p("")).toEqual({});
  });
});

describe("filter helpers", () => {
  it("windows are computed deterministically", () => {
    expect(resolveWindow({ kind: "next_calendar_year" }, T)).toEqual({ from: "2027-01-01", to: "2027-12-31" });
    expect(resolveWindow({ kind: "within_months", months: 6 }, T)).toEqual({ from: T, to: "2027-05-11" });
    expect(resolveWindow({ kind: "this_calendar_year" }, T)).toEqual({ from: T, to: "2026-12-31" });
  });
  it("chips render, drop and round-trip through the URL", () => {
    const f = p("Show companies occupying 15,000–40,000 SF in Kharadi with a lease event next year and a contact I already know");
    expect(filterChips(f).map((c) => c.label)).toEqual(["Occupies 15k–40k SF", "In Kharadi", "Lease event next calendar year", "Contact I already know"]);
    expect(dropChip(f, "area")).not.toHaveProperty("areaMinSf");
    expect(decodeFilter(encodeFilter(f))).toEqual(f);
    expect(decodeFilter("not-json")).toBeNull();
    expect(decodeFilter(Buffer.from(JSON.stringify({ sql: "drop table x" })).toString("base64url"))).toBeNull();
  });
  it("edit form → filter", () => {
    const v: Record<string, string> = { amin: "15,000", amax: "40000", basis: "chargeable", places: "Kharadi", win: "months", months: "6", known: "1", opp: "0" };
    expect(filterFromForm((k) => v[k])).toEqual({ areaMinSf: 15000, areaMaxSf: 40000, areaBasis: "chargeable", places: ["Kharadi"], eventWindow: { kind: "within_months", months: 6 }, knownContact: true, hasOpenOpportunity: false });
  });
});

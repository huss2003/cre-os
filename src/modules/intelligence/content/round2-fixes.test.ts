import { describe, expect, it } from "vitest";
import { factCheck, type EvidenceFact } from "./editor";

const EV: EvidenceFact[] = [
  { text: "vacancy — SBD East — 2025: 15 msf of stock; 4.2 msf absorbed", source: "CBRE Pune H2 2025", date: "2026-01-15", kind: "market_note", ref: "n1" },
];

describe("Content Editor (20) — fact check matches units, not just values", () => {
  it("a '15%' in the draft is NOT supported by '15 msf' in the evidence", () => {
    const r = factCheck("Vacancy in SBD East is 15%.", EV);
    expect(r.unmatched.some((c) => c.kind === "number" && c.text === "15%")).toBe(true);
  });
  it("the same value with the same unit is supported", () => {
    const r = factCheck("SBD East has 15 msf of stock.", EV);
    expect(r.unmatched.filter((c) => c.kind === "number")).toEqual([]);
  });
  it("a bare number in the draft may match a number with a unit", () => {
    const r = factCheck("SBD East absorbed 4.2 last year.", EV);
    expect(r.claims.find((c) => c.kind === "number" && c.text === "4.2")?.matched).toBe(true);
  });
});

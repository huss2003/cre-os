// Browser-test fixes (docs/integration/BROWSER-B.md B10–B12): pure helpers.
import { describe, it, expect } from "vitest";
import { tokensInOrder, matchTier, scoreLabel } from "./context";
import { meetingWindow } from "./mock";
import { plainToolName } from "./run";
import { factLabel, areaSf } from "../tools/shared";

describe("browser-B fixes", () => {
  it("B11 partial distinctive-token company names resolve (strong), in order only", () => {
    expect(tokensInOrder("Northwind Halberd GCC India", "Northwind GCC")).toBe(true);
    expect(tokensInOrder("Northwind Halberd GCC India", "GCC Northwind")).toBe(false);
    expect(tokensInOrder("Northwind Halberd GCC India", "Northwind")).toBe(false); // single word stays a weak contains
    expect(matchTier("Northwind Halberd GCC India", "Northwind GCC")).toBe(1);
    expect(scoreLabel("Northwind Halberd GCC India", ["Northwind GCC"]).strong).toBe(true);
  });
  it("B12 'tomorrow' / 'today' limit the meeting window to that IST day", () => {
    const now = new Date("2026-11-12T20:00:00Z"); // 13 Nov 01:30 IST
    expect(meetingWindow("prepare tomorrow's meeting", undefined, now)).toEqual({ from: "2026-11-14", to: "2026-11-14" });
    expect(meetingWindow("prep today's meeting", "c1", now)).toEqual({ from: "2026-11-13", to: "2026-11-13", companyId: "c1" });
    expect(meetingWindow("prepare my next meeting", undefined, now)).toEqual({});
    expect(plainToolName("generate_meeting_brief")).toBe("Meeting brief");
  });
  it("B10 plain fact labels and formatted areas", () => {
    expect(factLabel("historical_observed")).toBe("Seen earlier (historical)");
    expect(factLabel(null)).toBe("Unknown");
    expect(areaSf(150000)).toBe("1,50,000 sq ft");
    expect(areaSf(null)).toBe("unknown");
  });
});

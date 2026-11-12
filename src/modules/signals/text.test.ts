// Browser-test fixes (BROWSER-TEST.md 2026-11-12): company from text, event dates, counter cues, short task titles, plain labels.
import { describe, it, expect } from "vitest";
import { extractCompanyName, eventDateFromText, counterCue, shortAction, humanize, plural } from "./text";
import { priorityOf } from "./engine";
import { counterMessage } from "./ui-data";
import { priorityTip } from "./ui/card";
import { retitle, lcLabel } from "./service";
import { GENERIC_TOKENS, tokenScore } from "./resolve";

describe("company name from text (#3)", () => {
  it("takes the leading capitalised name before a verb", () => {
    expect(extractCompanyName("Quillwave Robotics announces a new engineering centre in Pune with 200 roles.")).toBe("Quillwave Robotics");
    expect(extractCompanyName("Cobaltfern Systems says its 300 new Pune hires will work remotely.")).toBe("Cobaltfern Systems");
    expect(extractCompanyName("Last week, Marigold Loop Technologies signed a lease in Kharadi.")).toBe("Marigold Loop Technologies");
    expect(extractCompanyName("The Halcyon Group plans to expand.")).toBe("Halcyon Group");
  });
  it("returns null when no company-like name is present", () => {
    expect(extractCompanyName("office demand is rising across the city this year")).toBeNull();
    expect(extractCompanyName("Pune will get a new metro line next year.")).toBeNull();
  });
});

describe("event date from text (#4)", () => {
  const ref = "2026-11-12";
  it("quarters, months and years are estimated; calendar dates are announced", () => {
    expect(eventDateFromText("300 roles from Q1 2027", ref)).toMatchObject({ date: "2027-01-01", basis: "estimated" });
    expect(eventDateFromText("operational by Q2 2027", ref)).toMatchObject({ date: "2027-06-30", basis: "estimated" });
    expect(eventDateFromText("move by March 2027", ref)).toMatchObject({ date: "2027-03-31", basis: "estimated" });
    expect(eventDateFromText("opening in March 2027", ref)).toMatchObject({ date: "2027-03-01", basis: "estimated" });
    expect(eventDateFromText("starting next quarter", ref)).toMatchObject({ date: "2027-01-01", basis: "estimated" });
    expect(eventDateFromText("by 2028", ref)).toMatchObject({ date: "2028-12-31", basis: "estimated" });
    expect(eventDateFromText("inaugurated on 15 March 2027", ref)).toMatchObject({ date: "2027-03-15", basis: "announced" });
    expect(eventDateFromText("on March 15, 2027", ref)).toMatchObject({ date: "2027-03-15", basis: "announced" });
    expect(eventDateFromText("handover 2027-02-01", ref)).toMatchObject({ date: "2027-02-01", basis: "announced" });
    expect(eventDateFromText("Q1 FY27 hiring", ref)).toMatchObject({ date: "2026-04-01" });
  });
  it("no phrase → no date (never guessed)", () => { expect(eventDateFromText("expanding soon in Pune", ref)).toBeNull(); });
});

describe("counter-evidence cues (#2)", () => {
  it("detects remote work / no additional space", () => {
    expect(counterCue("Cobaltfern Systems says its 300 new Pune hires will work remotely and it needs no additional office space.")).toBe(true);
    expect(counterCue("The expansion has been put on hold.")).toBe(true);
    expect(counterCue("Cobaltfern Systems announces expansion of its Pune operations, adding 300 roles in Kharadi.")).toBe(false);
  });
});

describe("priority drops with counter-evidence (#2)", () => {
  const base = { category: "expansion" as const, daysAway: null, confidence: "low" as const, inFocusGeo: true, hasContact: false, hasOpenOpportunity: false, hasRequirement: false, leaseWithin18m: false, freshnessDays: 1, needsVerification: true };
  it("each counter item lowers the score with a reason", () => {
    const a = priorityOf(base); const b = priorityOf({ ...base, counterItems: 1 });
    expect(b.score).toBeLessThan(a.score);
    expect(b.reasons.join(" ")).toMatch(/Counter-evidence recorded/);
  });
  it("paste-box message names the updated signal", () => {
    expect(counterMessage([{ title: "Cobaltfern Systems: possible Pune expansion", priorityBefore: 47, priorityAfter: 35, bandBefore: "medium", bandAfter: "low" }]))
      .toBe("Added as counter-evidence to signal: “Cobaltfern Systems: possible Pune expansion” — priority 47 → 35/100 (This month → Watch). Nothing new was created.");
  });
});

describe("copy and labels (#10, #11, #13)", () => {
  it("task title from Approve is a short action", () => {
    const long = "Confirm whether the Pune expansion needs new space: call the facilities head, check spare capacity at the existing office and ask for headcount by quarter. On record: existing occupancy at Amberline.";
    const t = shortAction(long);
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t).not.toMatch(/On record/);
    expect(shortAction("Call the facilities head.")).toBe("Call the facilities head");
  });
  it("plain labels instead of raw codes", () => {
    expect(humanize("calculated_from_source_tenure")).toBe("Calculated from the lease tenure");
    expect(humanize("manual_paste")).toBe("Pasted text");
    expect(humanize("options_visits")).toBe("Options & site visits");
    expect(humanize("single_unverified")).toBe("Single unverified source");
    expect(humanize("none")).toBe("");
    expect(humanize("expansion_terms")).toBe("Expansion terms");
  });
  it("pluralisation and priority reason punctuation", () => {
    expect(plural(1, "month")).toBe("1 month"); expect(plural(2, "month")).toBe("2 months");
    expect(priorityTip("Act now", ["Expansion relevance (+14).", "Evidence low (+4)."])).toBe("Why act now: Expansion relevance (+14). Evidence low (+4).");
  });
  it("titles keep place names capitalised; correcting the company retitles", () => {
    expect(lcLabel("Pune expansion")).toBe("Pune expansion");
    expect(lcLabel("New office")).toBe("new office");
    expect(lcLabel("GCC setup")).toBe("GCC setup");
    expect(retitle("Cobaltfern Technologies: possible Pune expansion", ["Cobaltfern Technologies"], "Cobaltfern Systems")).toBe("Cobaltfern Systems: possible Pune expansion");
    expect(retitle("Unresolved company: possible hiring", [null, "Unresolved company"], "Acme")).toBe("Acme: possible hiring");
  });
  it("distinctive name words outrank generic ones", () => {
    expect(GENERIC_TOKENS.has("technologies")).toBe(true);
    expect(tokenScore(["cobaltfern"])).toBeGreaterThan(tokenScore(["technologies"]));
  });
});

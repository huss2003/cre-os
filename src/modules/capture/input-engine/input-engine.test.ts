/**
 * Module 10 Input Engine — pure tests (no DB, no AI). Spec §17 scenarios 1, 2, 3, 4, 6, 7, 17, 19, 20, 22 (logic level).
 */
import { describe, it, expect } from "vitest";
import { ruleExtract } from "../extract";
import { analyse, applyPermissions, buildReceipt, classifyIntents, contentHash, DEFAULT_PERMISSIONS, factClass, matchTier, sourceHash } from "./analysis";
import { classifyDates, extractCommercialTerms } from "./commercial";
import { detectLanguage, romanise } from "./hindi";
import { legacyOfficeText } from "./office";
import { parseBusinessCard, uncertainCardFields } from "../docs/card";

const SRC = { sourceAt: "2026-11-11T05:00:00Z", timezone: "Asia/Kolkata" };
const ANIL = "Spoke to Anil. They need around 20,000 feet in Kharadi by September. Budget is 85. Send options Friday.";

describe("§17.1 plain-text note (the Anil example)", () => {
  const ex = ruleExtract(ANIL, SRC);
  const a = analyse({ prefix: "cap:t", text: ANIL, extraction: ex, sourceType: "typed_note" });

  it("extracts contact, ~20,000 SF (estimate), Kharadi, informal September target, raw budget 85 and the Friday task", () => {
    expect(ex.mentions.find((m) => m.kind === "person")?.text).toBe("Anil");
    const area = a.observations.find((o) => o.field === "area_target")!;
    expect(area).toMatchObject({ value_json: 20000, unit: "sf", fact_class: "estimate", area_basis: "unknown", raw_text: "20,000 feet" });
    expect(a.observations.find((o) => o.field === "preferred_location")?.value_json).toBe("Kharadi");
    const target = a.observations.find((o) => o.field === "occupation_target")!;
    expect(target).toMatchObject({ date_class: "informal", value_json: { month: "September", year: null }, fact_class: "estimate" });
    const budget = a.observations.find((o) => o.field === "budget")!;
    expect(budget).toMatchObject({ value_json: 85, unit: null, pricing_basis: null, cam_treatment: "unknown", verification: "needs_clarification", review_category: "missing_units_or_dates" });
    expect(budget.missing).toEqual(expect.arrayContaining(["unit", "pricing_basis", "cam"]));
    const task = a.observations.find((o) => o.fact_class === "task")!;
    expect(task.value_json).toMatchObject({ description: expect.stringMatching(/^Send options/), due: "2026-11-13" });   // next Friday in IST
  });

  it("asks exactly ONE clarification, about the budget basis and CAM", () => {
    expect(a.clarifications).toHaveLength(1);
    expect(a.clarifications[0].question).toMatch(/₹85 per sq ft per month\? Is CAM extra\?/);
    const q = ex.ambiguities.find((x) => x.kind === "unit")!;
    expect(q.question).toMatch(/₹85 per sq ft per month\? Is CAM extra\?/);
    expect(q.options[0].value).toBe("budget_max|per_sf_month|cam_extra");
  });

  it("classifies intents and gives match tiers; uncertain contact routes values to review, never auto-merges", () => {
    expect(a.intents).toEqual(expect.arrayContaining(["new_property_requirement", "meeting_note", "follow_up_task"]));
    expect(a.matches.find((m) => m.kind === "person")?.tier).toBe("none");
    expect(a.observations.find((o) => o.field === "area_target")?.review_category).toBe("uncertain_contact_match");
    expect(a.observations.filter((o) => o.material).every((o) => applyPermissions(o, DEFAULT_PERMISSIONS).status === "pending_review")).toBe(true);
  });

  it("writes a plain-language receipt: saved / matched / proposed / questioned / scheduled", () => {
    const r = buildReceipt({ sourceLabel: "Note", matches: a.matches, requirementProposed: { status: "awaiting_match", summary: "20,000 feet (approx.), Kharadi" },
      questions: a.clarifications, tasks: [{ title: "Send options", due: "2026-11-13", created: true }], conflicts: [], repeats: 0, saved: a.observations.length });
    const kinds = r.lines.map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(["saved", "matched", "proposed", "questioned", "scheduled"]));
    expect(r.lines.find((l) => l.kind === "matched")!.text).toMatch(/Anil.*awaiting your confirmation/);
    expect(r.lines.find((l) => l.kind === "questioned")!.text).toMatch(/CAM extra/);
  });
});

describe("§4.4 intent classification", () => {
  const cls = (t: string) => classifyIntents(t, ruleExtract(t, SRC), extractCommercialTerms(t));
  it("covers the categories", () => {
    expect(cls("Acme is hiring 300 engineers and expanding to Pune")).toContain("business_signal");
    expect(cls("Raj prefers WhatsApp, never call before 10")).toContain("personal_working_preference");
    expect(cls("I think they might consolidate Baner and Hinjewadi")).toContain("hypothesis_or_research");
    expect(cls("Met Priya, she said it is too expensive")).toContain("client_objection");
    expect(cls("Landlord quoted ₹95 per sq ft per month plus CAM")).toContain("commercial_quotation");
    expect(cls("Lease expires in March 2027, lock-in 36 months")).toContain("lease_information");
    expect(cls("priya.shah@zenith.in 98220 12345")).toContain("new_contact_information");
    expect(cls("Raj has joined Zenith as CFO")).toContain("contact_update");
    expect(cls("Tower B has a 40,000 sq ft floor plate, warm shell")).toContain("property_information");
    expect(cls("Reference: see attached file")).toEqual(["general_reference"]);
  });
});

describe("§4.2 commercial extraction — rules 2, 3, 4", () => {
  it("never converts area bases and keeps the original wording", () => {
    const t = extractCommercialTerms("Carpet area 12,000 sq ft; chargeable area 16,800 sq ft; super built-up area of 18,000 sft. Also 20,000 sf.");
    expect(t.map((x) => [x.key, x.value, x.area_basis])).toEqual([
      ["carpet_area", 12000, "carpet"], ["chargeable_area", 16800, "chargeable"], ["super_built_up_area", 18000, "super_built_up"], ["area", 20000, "unknown"]]);
    expect(t[0].raw_text).toBe("12,000 sq ft");
  });
  it("never assumes rent includes CAM; missing values stay unknown (never 0)", () => {
    const [r1] = extractCommercialTerms("Rent ₹95 per sq ft per month");
    expect(r1).toMatchObject({ key: "rent_psf", value: 95, unit: "INR/sf/month", cam: "unknown" });
    expect(r1.missing).toContain("cam");
    expect(extractCommercialTerms("Rent ₹95/sq ft per month plus CAM")[0].cam).toBe("extra");
    expect(extractCommercialTerms("Rent Rs 110 psf per month inclusive of CAM")[0].cam).toBe("included");
    const terms = extractCommercialTerms("Rent ₹95/sf/month. Security deposit 6 months. Lock-in 36 months. Escalation 5% every 3 years. CAM Rs 18 psf per month.");
    expect(terms.map((x) => x.key)).toEqual(expect.arrayContaining(["rent_psf", "security_deposit", "lock_in", "escalation", "cam"]));
    expect(terms.find((x) => x.key === "security_deposit")).toMatchObject({ value: 6, unit: "months_rent" });
    expect(terms.some((x) => x.key === "brokerage")).toBe(false);          // not stated => absent, not 0
  });
  it("§17.19 missing area units: a bare number is never placed", () => {
    expect(extractCommercialTerms("they need 20 for the team").length).toBe(0);
    const ex = ruleExtract("need 20k in Baner", SRC);
    expect(ex.ambiguities.some((a) => a.kind === "unit")).toBe(true);
  });
  it("page references come from page breaks", () => {
    const t = extractCommercialTerms("Cover page\fProposal\nRent ₹88 per sq ft per month\fAnnexure");
    expect(t[0].page).toBe(2);
  });
});

describe("§4.3 / §17.20 date classes", () => {
  it("contractual + complete = confirmed; approximate = estimated; month/weekday only = informal", () => {
    const d = classifyDates("Lease commencement date 1 April 2027. Possession expected around 15 June 2027. Target by September. Call Friday.", { contractualSource: true });
    expect(d.map((x) => [x.raw_text, x.date_class])).toEqual([
      ["1 April 2027", "confirmed"], ["15 June 2027", "estimated"], ["by September", "informal"], ["Friday", "informal"]]);
    // the same date in a note / spreadsheet is never confirmed
    expect(classifyDates("commencement 1 April 2027")[0].date_class).toBe("estimated");
  });
});

describe("§2.2 / §17.2–3 Hindi and Hinglish", () => {
  it("romanises Devanagari so the same rules extract contact, area, place and task", () => {
    const hi = "अनिल से बात हुई। खराडी में लगभग बीस हज़ार स्क्वेयर फीट चाहिए। शुक्रवार को ऑप्शन्स भेजना है।";
    expect(detectLanguage(hi)).toBe("hi");
    const r = romanise(hi);
    expect(r).toMatch(/^Anil se baat hui\. Kharadi mein lagbhag bees hazaar sq ft chahiye/);
    const ex = ruleExtract(r, SRC);
    expect(ex.mentions.map((m) => m.text)).toEqual(expect.arrayContaining(["Anil", "Kharadi"]));
    expect(ex.facts.find((f) => f.field === "area_target_sf")).toMatchObject({ proposed_value: 20000, status: "tentative" });
    expect(ex.tasks[0]).toMatchObject({ due_date: "2026-11-13" });
  });
  it("Hinglish (Roman) is detected and parsed", () => {
    const t = "Anil se baat hui, Kharadi mein 20,000 sq ft chahiye, Friday ko options bhejna hai";
    expect(detectLanguage(t)).toBe("hinglish");
    const ex = ruleExtract(t, SRC);
    expect(ex.mentions.find((m) => m.kind === "person")?.text).toBe("Anil");
    expect(ex.tasks[0].description).toMatch(/^Send options/);
  });
});

describe("§2.4 / §17.4 business card", () => {
  it("extracts name, designation, company, email, phone, website and address; flags uncertain fields", () => {
    const c = parseBusinessCard("Meera Iyer\nHead of Workplace\nZenith Labs Pvt. Ltd.\n+91 98220 12345\n020 6700 1000\nmeera@zenithlabs.com\nwww.zenith.in\n7th Floor, Panchshil Tower, Kharadi, Pune 411014");
    expect(c).toMatchObject({ name: "Meera Iyer", title: "Head of Workplace", company: "Zenith Labs Pvt. Ltd.", emails: ["meera@zenithlabs.com"], website: "www.zenith.in" });
    expect(c.address).toMatch(/Panchshil Tower.*411014/);
    const u = uncertainCardFields(c).map((x) => x.field);
    expect(u).toContain("email");                     // domain differs from website
    expect(u).toContain("phone 020 6700 1000");       // unlabelled landline
  });
});

describe("§5.4 / §17.17 match confidence", () => {
  const cand = (id: string, label: string, score = 0.9) => ({ id, entity_type: "person", label, score });
  it("high / medium / low / none", () => {
    expect(matchTier({ kind: "person", text: "Anil Mehta" }, [cand("1", "Anil Mehta")]).tier).toBe("high");
    expect(matchTier({ kind: "person", text: "Anil" }, [cand("1", "Anil Mehta")]).tier).toBe("medium");
    expect(matchTier({ kind: "person", text: "Anil" }, [cand("1", "Anil Mehta"), cand("2", "Anil Shah")]).tier).toBe("low");
    expect(matchTier({ kind: "person", text: "Anil" }, []).tier).toBe("none");
    expect(matchTier({ kind: "person", text: "Anil" }, [cand("1", "Anil Mehta"), cand("2", "Anil Shah")], { exactContactHit: "2" })).toMatchObject({ tier: "high", id: "2" });
    expect(matchTier({ kind: "organisation", text: "Acme Pvt Ltd" }, [{ ...cand("9", "Acme"), entity_type: "organisation" }]).tier).toBe("high");
  });
});

describe("§8 fact classes, §6 hashing", () => {
  it("classes", () => {
    expect(factClass({ kind: "value", approximate: true, sourceType: "typed_note" })).toBe("estimate");
    expect(factClass({ kind: "value", inferred: true, sourceType: "typed_note" })).toBe("assumption");
    expect(factClass({ kind: "value", sourceType: "voice_note" })).toBe("estimate");           // machine reading ≠ client statement
    expect(factClass({ kind: "value", sourceType: "voice_note", userConfirmed: true })).toBe("confirmed");
    expect(factClass({ kind: "value", sourceType: "document", pageVerified: true })).toBe("confirmed");
    expect(factClass({ kind: "signal", sourceType: "typed_note" })).toBe("hypothesis");
    expect(factClass({ kind: "commitment", sourceType: "typed_note" })).toBe("commitment");
    expect(factClass({ kind: "preference", sourceType: "typed_note" })).toBe("preference");
  });
  it("§17.22 the same source re-sent hashes the same; content hash ignores formatting", () => {
    expect(sourceHash("Rent ₹95/sf.  CAM extra")).toBe(sourceHash("rent ₹95/sf cam extra"));
    expect(contentHash("rent_psf", 95, "r1")).toBe(contentHash("rent_psf", 95, "r1"));
    expect(contentHash("rent_psf", 95, "r1")).not.toBe(contentHash("rent_psf", 85, "r1"));
  });
});

describe("§2.5 legacy Office text", () => {
  it("reads UTF-16 runs from a binary .doc/.ppt (best effort)", () => {
    const s = "Quotation: Rent Rs 90 per sq ft per month";
    const u16 = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { u16[i * 2] = s.charCodeAt(i); u16[i * 2 + 1] = 0; }
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 1, 2, 3, ...u16, 0xff, 0xfe]);
    expect(legacyOfficeText(bytes)).toContain("Rent Rs 90 per sq ft");
  });
});

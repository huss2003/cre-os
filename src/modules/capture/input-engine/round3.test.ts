import { describe, it, expect } from "vitest";
import { ruleExtract, stripFunctionWords } from "../extract";
import { locateTerm } from "../docs/service";
import { parseBusinessCard } from "../docs/card";
import { cardObservations } from "./card-observations";
import { analyse } from "./analysis";
import { captureKindLabel, interactionLogWording, languageLabel } from "./ui/labels";
import { errorMessage, actionError } from "@/modules/changes/http";

describe("Module 10 round 3 fixes", () => {
  it("1. Hindi function words are never part of a location/entity candidate", () => {
    expect(stripFunctionWords("Unko Kharadi")).toEqual({ text: "Kharadi", offset: 5 });
    expect(stripFunctionWords("Hum")).toEqual({ text: "", offset: 0 });
    for (const t of ["Unko Kharadi mein 20,000 sq ft chahiye.", "Unhe Kharadi mein office chahiye", "Inko Baner wala office pasand hai"]) {
      const ex = ruleExtract(t);
      const geos = ex.mentions.filter((m) => m.kind === "geography").map((m) => m.text);
      for (const g of geos) expect(g).not.toMatch(/^(unko|unhe|inko|hum)\b|\b(mein|wala)$/i);
      for (const f of ex.facts.filter((x) => x.field === "preferred_geography")) expect(String(f.proposed_value)).not.toMatch(/unko|unhe|inko/i);
    }
    const ex = ruleExtract("Unko Kharadi mein 20,000 sq ft chahiye.");
    const g = ex.facts.find((f) => f.field === "preferred_geography")!;
    expect(g.proposed_value).toBe("Kharadi");
    const m = ex.mentions.find((x) => x.kind === "geography")!;
    expect("Unko Kharadi mein 20,000 sq ft chahiye.".slice(m.start, m.end)).toBe("Kharadi");
  });

  it("1b. same location from Hinglish and English yields the same value (no false conflict)", () => {
    const hi = analyse({ prefix: "a", text: "Unko Kharadi mein 20,000 sq ft chahiye.", extraction: ruleExtract("Unko Kharadi mein 20,000 sq ft chahiye."), sourceType: "typed_note", subject: null } as never);
    const en = analyse({ prefix: "b", text: "They need 20,000 sq ft in Kharadi.", extraction: ruleExtract("They need 20,000 sq ft in Kharadi."), sourceType: "typed_note", subject: null } as never);
    const loc = (a: typeof hi) => a.observations.find((o) => o.field === "preferred_location")?.value_json;
    expect(loc(hi)).toBe("Kharadi");
    expect(loc(hi)).toEqual(loc(en));
  });

  it("2. database errors show their real message, never [object Object]", () => {
    const pg = { code: "42501", message: 'new row violates row-level security policy for table "capture"', details: null, hint: null };
    expect(actionError(pg)).not.toContain("[object Object]");
    expect(actionError(pg)).toMatch(/permission/i);
    expect(errorMessage({ code: "23502", message: "null value in column", details: "Failing row", hint: null })).toBe("null value in column — Failing row");
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("5. quote date and security deposit get page references (dates in words, short numbers not matched inside years)", () => {
    const pages = ["Quotation\nProvider: Acme Realty\nIssued 2026", "Quote date: 1 October 2026\nRent: Rs 85 per sq ft chargeable\nSecurity deposit: 6 months\nLock-in 36 months"];
    expect(locateTerm(pages, "quote_date", "Quote date", "2026-10-01")).toEqual({ page: 2, snippet: "Quote date: 1 October 2026" });
    expect(locateTerm(pages, "deposit_months", "Security deposit (months)", 6)).toEqual({ page: 2, snippet: "Security deposit: 6 months" });
    expect(locateTerm(pages, "lockin_months", "Lock-in (months)", 36)?.page).toBe(2);
    expect(locateTerm(pages, "deposit_months", "Security deposit (months)", null)).toBeNull();
    expect(locateTerm(["Deposit equal to six months rent"], "deposit_months", "Security deposit (months)", 6)?.page).toBe(1);
  });

  it("6. voice-note captures are labelled as voice notes with language and sensible log wording", () => {
    expect(captureKindLabel("audio")).toBe("voice note");
    expect(captureKindLabel("text")).toBe("typed note");
    expect(languageLabel("hinglish")).toBe("Hinglish");
    expect(languageLabel(null, "hi")).toBe("Hindi");
    expect(languageLabel("en")).toBe("English");
    expect(languageLabel(null, null)).toBeNull();
    expect(interactionLogWording("audio", null, false)).toBe("Will be logged as a voice note.");
    expect(interactionLogWording("audio", "call", false)).toBe("Will be logged as a call (recorded from your voice note).");
    expect(interactionLogWording("text", "meeting", true)).toBe("Logged as a meeting (recorded from your note).");
  });

  it("7. business-card fields become extracted-information rows with fact class and uncertain flags", () => {
    const text = "Priya Sharma\nHead of Leasing\nZenith Realty Pvt Ltd\npriya@zenithrealty.com\n+91 98200 12345\nwww.zenith-realty.in\n4th Floor, Baner Road, Pune 411045";
    const card = parseBusinessCard(text);
    const obs = cardObservations(card, { prefix: "doc:x", text, fileName: "card.jpg", documentId: "x" });
    const fields = obs.map((o) => o.field);
    for (const f of ["contact_name", "contact_title", "company_name", "contact_email", "contact_phone", "company_website", "company_address"]) expect(fields).toContain(f);
    for (const o of obs) { expect(["estimate", "confirmed"]).toContain(o.fact_class); expect(typeof o.source_ref.uncertain).toBe("boolean"); }
    const email = obs.find((o) => o.field === "contact_email")!;
    expect(email.source_ref.uncertain).toBe(true);           // domain differs from website
    expect(email.status).toBe("pending_review");
    expect(email.review_category).toBe("uncertain_contact_match");
    expect(obs.find((o) => o.field === "contact_name")!.value_json).toBe("Priya Sharma");
    // nothing invented for missing fields
    const bare = cardObservations(parseBusinessCard("Raj Mehta\n98200 11111"), { prefix: "doc:y", text: "Raj Mehta\n98200 11111" });
    expect(bare.map((o) => o.field).sort()).toEqual(["contact_name", "contact_phone"]);
  });
});

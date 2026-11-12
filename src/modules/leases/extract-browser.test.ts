import { describe, it, expect } from "vitest";
import { buildExtraction } from "./extract";

// Browser test A (docs/integration/BROWSER-A.md) B1 / B2 regressions.
const B1_PARA = "LEASE DEED This Lease Deed is executed on 15 December 2026 between Landlord and BTA Lease Test Co. The term of the lease shall commence on 1 January 2027 and the lease term shall be 9 years.";

describe("B1: several date clauses in one paragraph", () => {
  const ex = buildExtraction([B1_PARA, "The lock-in period shall be 36 months from the commencement date.\n\nThe Lessee may terminate the lease by giving written notice not less than six months prior to expiry of the term."]);
  const by = (t: string) => ex.dates.find((d) => d.date_type === t)!;
  it("extracts execution, commencement and term, each with its own source span", () => {
    expect(by("execution")).toMatchObject({ calculated_date: "2026-12-15", page: 1, verification_status: "extracted" });
    expect(by("execution").clause_text).toMatch(/executed on 15 December 2026/);
    expect(by("execution").clause_text).not.toMatch(/commence/);
    expect(by("commencement")).toMatchObject({ calculated_date: "2027-01-01", page: 1, verification_status: "extracted" });
    expect(by("commencement").clause_text).toMatch(/^The term of the lease shall commence on 1 January 2027$/);
    expect(by("expiry")).toMatchObject({ calculated_date: "2035-12-31", origin: "calculated" });
    expect(by("expiry").clause_text).toMatch(/lease term shall be 9 years/);
    expect(ex.terms.termMonths).toBe(108);
    expect(ex.missing).not.toContain("commencement date");
    expect(ex.missing).not.toContain("expiry date / term");
  });
  it("lock-in and termination notice become calculable", () => {
    expect(by("lockin_end")).toMatchObject({ calculated_date: "2029-12-31", verification_status: "calculated" });
    expect(by("termination_notice_deadline")).toMatchObject({ calculated_date: "2035-06-30", verification_status: "calculated", label: "Termination / vacation notice deadline" });
    expect(by("termination_notice_deadline").method).toBeTruthy();
  });
});

describe("B2: renewal vs termination notice", () => {
  const base = "The lease shall commence on 1 January 2027 and the lease term shall be 9 years.";
  it("'may renew ... notice ... prior to expiry' → renewal notice deadline, not termination", () => {
    const ex = buildExtraction([base, "The Lessee may renew the lease by giving written notice not less than six months prior to expiry of the term."]);
    expect(ex.dates.find((d) => d.date_type === "renewal_notice_deadline")).toMatchObject({ calculated_date: "2035-06-30", verification_status: "calculated" });
    expect(ex.dates.find((d) => d.date_type === "termination_notice_deadline")).toBeUndefined();
  });
  it("extend verb → renewal", () => {
    const ex = buildExtraction([base, "The Lessee may extend the lease by giving notice not less than 6 months prior to expiry."]);
    expect(ex.dates.some((d) => d.date_type === "renewal_notice_deadline")).toBe(true);
  });
  it("notice without renew/terminate verb → needs_review", () => {
    const ex = buildExtraction([base, "Notice of not less than six months prior to expiry shall be given."]);
    const d = ex.dates.find((x) => x.date_type === "termination_notice_deadline")!;
    expect(d.verification_status).toBe("needs_review");
    expect(d.review_reason).toMatch(/renewal or for termination/);
  });
  it("both verbs → needs_review", () => {
    const ex = buildExtraction([base, "The Lessee may renew or terminate the lease by giving notice not less than six months prior to expiry."]);
    expect(ex.dates.find((x) => x.date_type === "renewal_notice_deadline")!.verification_status).toBe("needs_review");
  });
});

import { backUrl } from "./url";
describe("B3: flash query before hash", () => {
  it("puts ?ok/?err before #fragment", () => {
    expect(backUrl("/leases/abc#dates", { ok: "Saved." })).toBe("/leases/abc?ok=Saved.#dates");
    expect(backUrl("/leases/abc#dates", { err: "choose the date" })).toBe("/leases/abc?err=choose+the+date#dates");
    expect(backUrl("/leases/obligations?status=open#x", { ok: "Saved." })).toBe("/leases/obligations?status=open&ok=Saved.#x");
    expect(backUrl("/leases/abc", { ok: "Saved." })).toBe("/leases/abc?ok=Saved.");
  });
});

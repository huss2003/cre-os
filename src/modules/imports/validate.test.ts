import { describe, it, expect } from "vitest";
import { dateColumnConsistency, normalisePhone, parseArea, parseDate, parseEmail, parsePhones, parseRent, suspiciousArea } from "./validate";
import { detectContacts, suggestColumns } from "./adapters/contacts";
import { detectWorkbook, mapWorkbook } from "./detect";
import { layoutChanges, runReport, validationReport } from "./report";
import { buildStaged, markDuplicates } from "./reconcile";
import { LEASE_LARGE_HEADER, sheet, workbook } from "./testkit";
import { DEFAULT_SIZE_RULES, type Cell } from "./types";

const s = (v: string): Cell => ({ v, t: "s" });
const n = (v: number): Cell => ({ v, t: "n" });

describe("validators (spec §3.3)", () => {
  it("emails", () => {
    expect(parseEmail(s(" Raj.Mehta@Acme.co.in ")).value).toBe("raj.mehta@acme.co.in");
    expect(parseEmail(s("raj@acme")).valid).toBe(false);
    expect(parseEmail(s("NA")).valid).toBe(true);
  });
  it("Indian phone formats", () => {
    for (const p of ["98200 12345", "+91-98200-12345", "091 9820012345", "09820012345", "919820012345", "(+91) 98200-12345"]) expect(normalisePhone(p)?.e164).toBe("+919820012345");
    expect(normalisePhone("020-2612 3456")).toEqual({ e164: "+912026123456", kind: "landline" });
    expect(normalisePhone("1800-123-4567")?.kind).toBe("toll_free");
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("5820012345")?.kind).toBe("landline");
    const multi = parsePhones(s("98200 12345 / 020-26123456, abc"));
    expect(multi.values).toEqual(["+919820012345", "+912026123456"]);
    expect(multi.invalid).toEqual(["abc"]);
    expect(parsePhones(n(9820012345)).values).toEqual(["+919820012345"]);
  });
  it("dates: ambiguity and precision are kept, never invented", () => {
    expect(parseDate(s("25/03/2027"))).toMatchObject({ value: "2027-03-25", format: "dmy", ambiguous: false });
    expect(parseDate(s("03/04/2027"))).toMatchObject({ value: "2027-04-03", ambiguous: true, alternative: "2027-03-04" });
    expect(parseDate(s("03/25/2027"))).toMatchObject({ value: "2027-03-25", format: "mdy" });
    expect(parseDate(s("Mar 2027"))).toMatchObject({ value: null, precision: "month" });
    expect(parseDate(s("31st Mar 2027")).value).toBe("2027-03-31");
    expect(parseDate({ v: "2027-01-31", t: "d" }).format).toBe("excel_date");
    expect(parseDate(s("soon")).format).toBe("unparsed");
    expect(dateColumnConsistency([parseDate(s("25/03/2027")), parseDate(s("03/25/2027"))])).toMatchObject({ mixedOrder: true, inconsistent: true });
    expect(dateColumnConsistency([parseDate(s("25/03/2027")), parseDate(s("26/04/2027"))]).inconsistent).toBe(false);
  });
  it("areas: unit and basis are never assumed", () => {
    expect(parseArea(n(20000))).toMatchObject({ min: 20000, unit: null, basis: null, valid: true });
    expect(parseArea(s("15k-20k sq ft carpet"))).toMatchObject({ min: 15000, max: 20000, unit: "sq_ft", basis: "carpet" });
    expect(parseArea(n(20000), "Area (sft)")).toMatchObject({ unit: "sq_ft" });
    expect(parseArea(s("120 seats"))).toMatchObject({ min: 120, unit: "seats" });
    expect(parseArea(s("big"))).toMatchObject({ valid: false });
    expect(parseArea(n(-5))).toMatchObject({ valid: false });
    expect(parseArea(s("30000 - 20000")).reason).toMatch(/reversed/);
    expect(suspiciousArea(parseArea(n(9820012345), "area sq ft"))).toMatch(/implausibly|phone/);
    expect(suspiciousArea(parseArea(n(25), "sqft"))).toMatch(/too small/);
  });
  it("rent: basis only when stated; CAM not assumed", () => {
    expect(parseRent(s("₹85/sf"))).toMatchObject({ min: 85, basis: "per_sf" });
    expect(parseRent(s("85-90 per sq ft per month incl CAM"))).toMatchObject({ min: 85, max: 90, basis: "per_sf+per_month+cam_included" });
    expect(parseRent(n(85))).toMatchObject({ min: 85, basis: null });
  });
});

describe("automatic column mapping (spec §3.2, scenario 12)", () => {
  const SPEC = ["Company", "Contact Person", "Mobile", "Office Space", "Location", "Rent", "Expiry"];
  it("maps the spec example headers", () => {
    const m = Object.fromEntries(suggestColumns(SPEC).map((x) => [x.header, x.label]));
    expect(m).toEqual({ Company: "Company Name", "Contact Person": "Contact Name", Mobile: "Phone Number", "Office Space": "Required Area",
      Location: "Preferred Location", Rent: "Expected Rent", Expiry: "Lease Expiry Date" });
  });
  it("custom names, learned aliases, unmapped and ambiguous columns", () => {
    const sh = sheet("Leads", [["Lead list"], ["Client Name", "POC", "E-mail ID", "Desk Count", "Broker Code"], ["Acme", "Raj", "raj@acme.in", 50, "B7"]]);
    const d = detectContacts(sh)!;
    expect(d.headerRow).toBe(2);
    expect(d.columnMap).toMatchObject({ company: 0, contact_name: 1, email: 2 });
    expect(d.unmapped.join()).toMatch(/Broker Code/);
    const learned = detectContacts(sh, { "contacts_requirements_v1:contacts:required_area": ["desk count"] })!;
    expect(learned.columnMap.required_area).toBe(3);
    expect(learned.suggestions[3].source).toBe("learned");
    const amb = suggestColumns(["Company", "Contact", "Area Location"]);
    expect(amb[2].ambiguous).toBe(true);
  });
  it("tenant workbooks still go to their own adapters", () => {
    const lease = sheet("Lease", [LEASE_LARGE_HEADER]);
    const contacts = sheet("Leads", [["Company", "Contact Person", "Mobile", "Office Space"], ["Acme", "Raj", "9820012345", "20000 sft"]]);
    const det = detectWorkbook(workbook(lease, contacts));
    expect(det[0].adapter).not.toBe("contacts_requirements_v1");
    expect(det[1].adapter).toBe("contacts_requirements_v1");
  });
});

describe("row validation + report", () => {
  it("flags invalid values, missing company, duplicates; uncertain dates stay reported", () => {
    const wb = workbook(sheet("Contacts", [
      ["Company", "Contact Person", "Email", "Mobile", "Office Space", "Rent", "Expiry"],
      ["Acme Pvt Ltd", "Raj Mehta", "raj@acme.in", "98200 12345", "20000", "85", "03/04/2027"],
      ["ACME Private Limited", "Priya", "priya@acme", "12345", "-5", "", "25/03/2027"],
      ["", "Sam", "sam@x.in", "", "", "", "04/25/2027"],
      ["Acme Pvt Ltd", "Raj Mehta", "raj@acme.in", "", "", "", ""],
      [null, null, null, null, null, null, null],
      ["", "", "", "", "", "", "note only"],
    ]));
    const det = detectWorkbook(wb);
    const mapped = mapWorkbook(wb, det, { size_rules: DEFAULT_SIZE_RULES });
    const staged = buildStaged(mapped, new Map(wb.sheets.map((x) => [x.name, new Map(x.rows.map((r) => [r.rowNumber, r]))])));
    markDuplicates(staged);
    if (process.env.DEBUG_IMP) console.log(JSON.stringify(staged.map((r) => [r.row_number, r.status, r.issues.map((i) => i.kind)])));
    const kinds = (row: number) => staged.find((r) => r.row_number === row)!.issues.map((i) => i.kind);
    expect(kinds(2)).toEqual(expect.arrayContaining(["missing_area_unit", "ambiguous_date", "possible_duplicate_company"]));
    expect(kinds(3)).toEqual(expect.arrayContaining(["invalid_email", "invalid_phone", "invalid_area"]));
    expect(kinds(4)).toContain("missing_company");
    expect(staged.find((r) => r.row_number === 5)!.status).toBe("duplicate");
    expect(staged.find((r) => r.row_number === 7)!.status).toBe("quarantined");
    const rec = staged.find((r) => r.row_number === 2)!.record as { lease_expiry: { fact_status: string; ambiguous: boolean }; cell_refs: Record<string, string>; company_key: string };
    expect(rec.lease_expiry).toMatchObject({ fact_status: "reported", ambiguous: true });
    expect(rec.cell_refs.company).toBe("Contacts!A2");
    expect(rec.company_key).toBe("acme");
    const rep = validationReport(staged, mapped.flatMap((m) => m.result.issues.map((i) => ({ sheet: m.detection.sheet, issue: i }))));
    const labels = rep.checks.map((c) => c.kind);
    expect(labels).toEqual(expect.arrayContaining(["invalid_email", "invalid_phone", "inconsistent_date_formats", "missing_company", "duplicate_row"]));
  });
});

describe("layout + run reports", () => {
  it("detects added, removed, moved and remapped columns", () => {
    const ch = layoutChanges(
      [{ sheet: "Contacts", headers: ["Company", "Contact Person", "Mobile", "Rent"], column_map: { company: 0, contact_name: 1, phone: 2, expected_rent: 3 } }],
      [{ sheet: "Contacts", headers: ["Contact Person", "Company", "Phone No", "Notes"], column_map: { company: 1, contact_name: 0, phone: 2, notes: 3 } }],
    );
    expect(ch[0].added).toEqual(["Phone No", "Notes"]);
    expect(ch[0].removed).toEqual(["Mobile", "Rent"]);
    expect(ch[0].moved.map((m) => m.header)).toEqual(["Contact Person", "Company"]);
    expect(ch[0].remapped.map((r) => r.field)).toEqual(expect.arrayContaining(["phone", "expected_rent", "notes"]));
  });
  it("aggregates the completion report", () => {
    const r = runReport([
      { file_name: "a.xlsx", kind: "spreadsheet", status: "queued", error: null, batch: { status: "completed", error: null, counts: { accepted: 10, duplicates: 1, match_candidates: 2, exceptions: 3, masters: { organisation: { new: 4, existing_linked: 1 } }, observations: {}, steward: { conflicts: 2 } } } },
      { file_name: "b.xlsx", kind: "spreadsheet", status: "queued", error: null, batch: { status: "failed", error: "fetch failed", counts: null } },
      { file_name: "c.xls", kind: "unsupported", status: "failed", error: "Legacy", error_kind: "permanent" },
      { file_name: "d.pdf", kind: "document", status: "queued", error: null, capture: { status: "needs_review" } },
    ]);
    expect(r).toMatchObject({ files_received: 4, files_processed: 1, files_partial: 1, files_failed: 2, records_identified: 11, records_created: 4, records_updated: 1,
      potential_duplicates: 3, conflicts: 2, needs_review: 3, done: true });
    expect(r.failed_files.find((f) => f.file_name === "b.xlsx")!.retryable).toBe(true);
    expect(r.failed_files.find((f) => f.file_name === "c.xls")!.retryable).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { chunkSource, chunkText, embeddingProvider, rrf } from "./retrieval";
import { finaliseTerms, heuristicTerms, leasePatchFromTerms, parseArea, parseDate, parseInr, parseMonths, parsePercent, verifyTerm } from "./lease-terms";

const PAGES = [
  "LEAVE AND LICENSE AGREEMENT. This agreement is made between Acme Realty Pvt Ltd (Lessor) and Globex India Pvt Ltd (Lessee). The premises are Unit 501, 5th floor, Tower B, EON IT Park, Kharadi, Pune.",
  "The chargeable area of the premises is 12,500 sq. ft. The monthly rent shall be Rs. 85 per sq ft per month. The rent shall escalate by 15% every three (3) years.",
  "The lock-in period is 36 months. The term of the lease is five (5) years. The commencement date is 1st April 2025. The lease shall expire on 31/03/2030. A security deposit equal to six (6) months rent is payable. Notice period of 6 months applies.",
];

describe("chunker", () => {
  it("keeps short text as one chunk and splits long text with overlap and no empty chunks", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
    const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const ch = chunkText(long, 200, 20);
    expect(ch.length).toBeGreaterThan(3);
    for (const c of ch) expect(c.length).toBeLessThanOrEqual(800);
    // overlap: the start of chunk 2 appears at the end of chunk 1
    expect(ch[0].includes(ch[1].split(" ")[0])).toBe(true);
    // full coverage: last word is present
    expect(ch.at(-1)!.endsWith("word1999")).toBe(true);
  });
  it("is page-aware and hashes deterministically", () => {
    const a = chunkSource({ pages: PAGES });
    expect(a.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(a.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(chunkSource({ pages: PAGES })[1].contentHash).toBe(a[1].contentHash);
    expect(chunkSource({ text: "x y" })[0].page).toBeNull();
    expect(chunkSource({ text: "  " })).toEqual([]);
  });
});

describe("RRF", () => {
  it("fuses rankings: items in both lists win, scores are 1/(k+rank)", () => {
    const f = rrf([["a", "b", "c"], ["c", "d", "a"]], (x) => x, 60);
    expect(f[0].item).toBe("a");                  // ranks 1 + 3
    expect(f[1].item).toBe("c");                  // ranks 3 + 1 (tie, a seen first)
    expect(f[0].score).toBeCloseTo(1 / 61 + 1 / 63);
    expect(f.map((x) => x.item).sort()).toEqual(["a", "b", "c", "d"]);
    expect(rrf([[], []], (x: string) => x)).toEqual([]);
  });
});

describe("embedding provider selection", () => {
  it("no key ⇒ null (full-text fallback); Voyage preferred over OpenAI", () => {
    expect(embeddingProvider({})).toBeNull();
    expect(embeddingProvider({ OPENAI_API_KEY: "x" })!.name).toContain("text-embedding-3-small");
    expect(embeddingProvider({ OPENAI_API_KEY: "x", VOYAGE_API_KEY: "y" })!.name).toBe("voyage-3.5");
  });
  it("sends dimensions=1024 to OpenAI and output_dimension to Voyage", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] })); }) as unknown as typeof fetch;
    await embeddingProvider({ OPENAI_API_KEY: "x" }, f)!.embed(["q"], "query");
    await embeddingProvider({ VOYAGE_API_KEY: "y" }, f)!.embed(["q"], "query");
    expect(bodies[0]).toMatchObject({ model: "text-embedding-3-small", dimensions: 1024 });
    expect(bodies[1]).toMatchObject({ model: "voyage-3.5", output_dimension: 1024, input_type: "query" });
  });
});

describe("deterministic parsers", () => {
  it("dates (day-first), months, INR, area, percent", () => {
    expect(parseDate("on 1st April 2025")).toBe("2025-04-01");
    expect(parseDate("expire on 31/03/2030")).toBe("2030-03-31");
    expect(parseDate("April 5, 2026")).toBe("2026-04-05");
    expect(parseDate("31/02/2030")).toBeNull();
    expect(parseDate("sometime next year")).toBeNull();
    expect(parseMonths("five (5) years")).toBe(60);
    expect(parseMonths("36 months")).toBe(36);
    expect(parseInr("Rs. 1,25,000 per month")).toBe("125000");
    expect(parseInr("INR 2.5 lakh")).toBe("250000");
    expect(parseInr("₹1.2 crore")).toBe("12000000");
    expect(parseArea("chargeable area 12,500 sq. ft.")).toEqual({ kind: "area", sf: "12500", basis: "chargeable", unit: "sf" });
    expect(parseArea("carpet area of 100 sq m")!.sf).toBe("1076.39");
    expect(parsePercent("escalate by 15% every three (3) years")).toEqual({ kind: "percent", percent: "15", everyMonths: 36 });
  });
});

describe("page-verified snippets", () => {
  it("keeps a snippet that occurs on the stated page", () => {
    const v = verifyTerm({ field: "lock_in", value: "36 months", page: 3, snippet: "The lock-in period is 36 months.", confidence: 0.9 }, PAGES);
    expect(v).toMatchObject({ verified: true, page: 3, flag: null, normalised: { kind: "months", months: 36 } });
  });
  it("corrects the page when the snippet is on another page", () => {
    const v = verifyTerm({ field: "rent", value: "85", page: 1, snippet: "monthly rent shall be Rs. 85 per sq ft per month", confidence: 0.8 }, PAGES);
    expect(v).toMatchObject({ verified: true, page: 2, flag: "page_corrected", normalised: { kind: "money", amount: "85", unit: "per_sf_per_month" } });
  });
  it("drops a hallucinated snippet and its value (unknown stays unknown)", () => {
    const v = verifyTerm({ field: "rent", value: "Rs. 120 psf", page: 2, snippet: "The rent is Rs. 120 per sq ft", confidence: 0.95 }, PAGES);
    expect(v).toMatchObject({ verified: false, raw: null, snippet: null, normalised: null, flag: "snippet_not_found", confidence: 0 });
  });
  it("never takes numbers from the model value — only from the verified snippet", () => {
    const v = verifyTerm({ field: "lock_in", value: "48 months", page: 3, snippet: "The lock-in period is", confidence: 0.9 }, PAGES);
    expect(v.verified).toBe(true);
    expect(v.normalised).toBeNull();
    expect(v.flag).toBe("value_not_in_snippet");
  });
  it("clips snippets over 25 words", () => {
    const long = PAGES[0].split(" ").slice(0, 30).join(" ");
    const v = verifyTerm({ field: "parties", value: null, page: 1, snippet: long, confidence: 0.5 }, PAGES);
    expect(v.flag).toBe("snippet_truncated");
    expect(v.snippet!.split(" ").length).toBe(25);
  });
  it("heuristic mock finds the main terms and maps them to lease columns", () => {
    const terms = finaliseTerms(heuristicTerms(PAGES), PAGES);
    const by = Object.fromEntries(terms.map((x) => [x.field, x]));
    expect(by.area.normalised).toMatchObject({ sf: "12500", basis: "chargeable" });
    expect(by.start_date.normalised).toEqual({ kind: "date", iso: "2025-04-01" });
    expect(by.expiry_date.normalised).toEqual({ kind: "date", iso: "2030-03-31" });
    expect(by.term.normalised).toEqual({ kind: "months", months: 60 });
    expect(by.parking.verified).toBe(false);              // not in the document → unknown
    for (const x of terms.filter((y) => y.verified)) expect(PAGES[x.page! - 1]).toContain(x.snippet!);
    const cols = Object.fromEntries(leasePatchFromTerms(terms).map((p) => [p.column, p.value]));
    expect(cols).toMatchObject({ area_sf: "12500", area_basis: "chargeable", rent_per_sf: "85", start_date: "2025-04-01", contractual_expiry: "2030-03-31", tenure_months_raw: 60, lockin_months_raw: 36 });
  });
});

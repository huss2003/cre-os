import { describe, it, expect } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import { researchCompany } from "./research";

describe("Signals auto-research", () => {
  it("stores cited findings once, skips LinkedIn, records researched_at, builds a signal", async () => {
    const db = await userClient("owner");
    const t = tag("rs");
    const { data: org } = await db.from("organisation").insert({ workspace_id: WS1, display_name: `Kappa ${t}` }).select("id").single();
    await db.from("watchlist").insert({ workspace_id: WS1, org_id: org!.id, tier: "critical" });
    const fake = (async () => ({ mocked: false, model: "test", usage: { input: 0, output: 0, usd: 0 }, data: { insufficient_evidence: false, findings: [
      { kind: "expansion", summary: `Kappa ${t} opens new Pune office`, location: "Pune", event_date: null, published_on: "2026-11-01", source_url: `https://news.example.com/${t}`, source_name: "Example News", official_source: false },
      { kind: "hiring", summary: "x", location: null, event_date: null, published_on: null, source_url: "https://www.linkedin.com/x", source_name: "LinkedIn", official_source: false },
    ] } })) as never;
    const r1 = await researchCompany(db, WS1, org!.id, { ai: fake });
    const r2 = await researchCompany(db, WS1, org!.id, { ai: fake });
    expect(r1.stored).toBe(1); expect(r2.stored).toBe(0);
    const { data: w } = await db.from("watchlist").select("last_researched_at").eq("org_id", org!.id).single();
    expect(w!.last_researched_at).not.toBeNull();
    const { data: sig } = await db.from("signal").select("id, category").eq("workspace_id", WS1).eq("org_id", org!.id);
    expect(sig!.some((s) => s.category === "expansion")).toBe(true);
  });
});

describe("Market discovery picks one new prospect", () => {
  it("skips known companies, picks the one with most evidence, deep-dives it, saves nothing until asked", async () => {
    const { discoverMarket } = await import("./research");
    const db = await userClient("owner");
    const t = tag("dc");
    await db.from("organisation").insert({ workspace_id: WS1, display_name: `Known ${t}` });
    const item = (company: string, n: number) => ({ company, kind: "gcc_plan", summary: `${company} sets up GCC in Pune ${n}`, location: "Pune", published_on: "2026-11-05", source_url: `https://et.example.com/${t}/${company.replace(/\s/g, "")}/${n}`, source_name: "ET" });
    const fake = (async () => ({ mocked: false, model: "test", usage: { input: 0, output: 0, usd: 0.01 },
      web: { queries: [`pune gcc ${t}`], sources: [{ url: "https://other.example.com/x", title: "Other" }] },
      data: { findings: [item(`Known ${t}`, 1), item(`Known ${t}`, 2), item(`Known ${t}`, 3), item(`Alpha ${t}`, 1), item(`Beta ${t}`, 1), item(`Beta ${t}`, 2)] } })) as never;
    const assessAi = (async () => ({ mocked: false, model: "test", usage: { input: 0, output: 0, usd: 0.02 }, web: { queries: [`Beta ${t}`], sources: [] },
      data: { summary: "Beta is growing in Pune.", pune_presence: "Office in Kharadi", unknowns: ["Lease dates"], facts: [
        { factor: "gcc", point: "Beta sets up Pune GCC", location: "Pune", published_on: new Date().toISOString().slice(0, 10), source_url: "https://news.example.com/beta", source_name: "News" }] } })) as never;
    const r = await discoverMarket(db, WS1, { ai: fake, assessAi });
    expect(r.picked).toBe(`Beta ${t}`);
    expect(r.newCompanies).toBe(2);
    const { data: run } = await db.from("research_run").select("assessment, kind").eq("id", r.assessRunId!).single();
    expect(run!.kind).toBe("assess");
    expect((run!.assessment as { score: number; orgId: string | null }).orgId).toBeNull();
    expect((run!.assessment as { score: number }).score).toBe(10 + 18);
    const { data: orgs } = await db.from("organisation").select("id").eq("workspace_id", WS1).eq("display_name", `Beta ${t}`);
    expect(orgs).toHaveLength(0);
  });
});

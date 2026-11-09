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

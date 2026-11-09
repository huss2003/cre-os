// Spec §21 end-to-end: company + Pune expansion signal → company & lead scores (separate) → override keeps original →
// new observation → recalculated with history explaining the change. Also: no duplicate rows on retry, isolation.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import { scoreEntity, recalcOrg, overridePriority, saveVersion, activeVersion, preview } from "./service";

describe("Module 3 — scoring engine", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string;
  const t = tag("sc"); const id: Record<string, string> = {};
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    const one = async (table: string, row: Record<string, unknown>) => { const { data, error } = await db.from(table).insert({ workspace_id: WS1, ...row }).select("id").single(); if (error) throw new Error(`${table}: ${error.message}`); return data!.id as string; };
    id.org = await one("organisation", { display_name: `Orion ${t}`, sector: "IT services", headcount_min: 2000 });
    id.asset = await one("asset", { name: `Tower ${t}` });
    id.lease = await one("lease", { tenant_org_id: id.org, asset_id: id.asset, area_sf: 40000 });
    id.ev = await one("lease_event", { lease_id: id.lease, event_type: "expiry", event_date: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10), date_basis: "contractual", confirmed: true });
    id.person = await one("person", { full_name: `Meera ${t}` });
    await one("employment", { person_id: id.person, org_id: id.org, title: "Head of Facilities & Real Estate", is_current: true });
    id.sig = await one("signal", { category: "expansion", kind: "expansion", title: `Orion expanding in Pune ${t}`, org_id: id.org, location_text: "Pune", confidence: "medium", verification: "inference", dedupe_key: `test:${t}` });
    id.req = await one("requirement", { org_id: id.org, title: `Orion 30k ${t}`, area_min_sf: 25000, area_max_sf: 35000, status: "draft" });
  });

  it("company and lead are scored separately with explanations, evidence, confidence and completeness", async () => {
    await recalcOrg(db, WS1, id.org, "test");
    const { data: rows } = await db.from("score_result").select("*").eq("workspace_id", WS1).eq("entity_id", id.org).eq("is_current", true);
    const company = rows!.find((r) => r.model_key === "company")!; const lead = rows!.find((r) => r.model_key === "lead")!;
    expect(company.score).toBeGreaterThan(0); expect(lead.score).toBeGreaterThan(0);
    expect(company.factors.find((f: { key: string }) => f.key === "growth").evidence[0].id).toBe(id.sig);
    expect(lead.factors.find((f: { key: string }) => f.key === "budget").known).toBe(false);
    expect(lead.missing).toContain("Budget");
    expect(["high", "medium", "low", "insufficient"]).toContain(company.confidence);
    const { data: contact } = await db.from("score_result").select("extra").eq("entity_id", id.person).eq("model_key", "contact").eq("is_current", true).single();
    expect(contact!.extra.role_class).toBe("decision_maker");
    const { data: req } = await db.from("score_result").select("score, missing").eq("entity_id", id.req).eq("is_current", true).single();
    expect(req!.missing).toContain("Budget"); expect(req!.missing).toContain("Move-in date");
  });

  it("re-running with unchanged data adds no history row (retry-safe)", async () => {
    const a = await scoreEntity(db, WS1, "company", id.org, "retry");
    const b = await scoreEntity(db, WS1, "company", id.org, "retry");
    expect(a.id).toBe(b.id);
  });

  it("override is stored separately; calculated score is preserved", async () => {
    const before = await scoreEntity(db, WS1, "lead", id.org);
    await overridePriority(db, WS1, owner, "lead", id.org, "Very High", "CFO confirmed search started");
    const { data: cur } = await db.from("score_result").select("score").eq("id", before.id).single();
    expect(cur!.score).toBe(before.score);
    const { data: ov } = await db.from("score_override").select("original_score, value").eq("entity_id", id.org).eq("active", true).single();
    expect(ov!.original_score).toBe(before.score); expect(ov!.value).toBe("Very High");
  });

  it("new research observation → recalculated, history shows what changed", async () => {
    const before = await scoreEntity(db, WS1, "company", id.org);
    await db.from("signal").insert({ workspace_id: WS1, category: "expansion", kind: "gcc_plan", title: `Orion GCC ${t}`, org_id: id.org, location_text: "Pune", confidence: "high", verification: "fact", dedupe_key: `test2:${t}`, latest_evidence_on: new Date().toISOString().slice(0, 10) });
    const after = await scoreEntity(db, WS1, "company", id.org, "signal.insert");
    expect(after.id).not.toBe(before.id);
    expect(after.previous_score).toBe(before.score);
    expect(after.change_reason).toMatch(/Growth indicators/);
    const { data: hist } = await db.from("score_result").select("id, is_current").eq("entity_id", id.org).eq("model_key", "company");
    expect(hist!.filter((h) => h.is_current)).toHaveLength(1);
    expect(hist!.length).toBeGreaterThanOrEqual(2);
  });

  it("model versions: invalid weights rejected; new version changes score; preview saves nothing", async () => {
    const av = await activeVersion(db, WS1, "company");
    await expect(saveVersion(db, WS1, "company", { ...av.v, factors: av.v.factors.map((f) => ({ ...f, weight: -5 })) }, "bad")).rejects.toThrow(/between 0 and 100/);
    const draft = { ...av.v, factors: av.v.factors.map((f) => (f.key === "growth" ? { ...f, weight: 60 } : f)) };
    const p = await preview(db, WS1, "company", draft, id.org);
    expect(p.draft.score).not.toBe(p.current.score);
    const again = await activeVersion(db, WS1, "company");
    expect(again.id).toBe(av.id);
  });

  it("other workspace cannot read scores", async () => {
    const other = await userClient("other");
    const { data } = await other.from("score_result").select("id").eq("entity_id", id.org);
    expect(data ?? []).toHaveLength(0);
  });
});

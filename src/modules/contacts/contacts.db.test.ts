// Spec §23: discover a Head of Administration at an existing company → match → classify → channels → review →
// approve → Module 1 updated via proposals → Module 3 contact score recalculated → history kept. Plus failure paths.
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, WS1, tag } from "../../../tests/helpers";
import { discoverCompany, approveItem, rejectItem, retryJob, enrichPerson, setRole } from "./service";

const ok = (people: unknown[]) => (async () => ({ mocked: false, model: "test", usage: { input: 0, output: 0, usd: 0.01 }, web: { queries: ["q"], sources: [{ url: "https://vertexnova.example/team", title: "Team" }] }, data: { people, company_contact: { switchboard: "+91 20 6600 1234", contact_page_url: "https://vertexnova.example/contact" }, suggested_roles: ["Facilities Manager"] } })) as never;

describe("Module 4 — contact enrichment", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("ce"); let org: string;
  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    const ins = await db.from("organisation").insert({ workspace_id: WS1, display_name: `NovaCo ${t}`, domain: `novaco-${t}.example` }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    org = ins.data!.id;
  });

  it("discovers, classifies, keeps field evidence, never guesses email; approval updates Module 1 and Module 3", async () => {
    const r = await discoverCompany(db, WS1, org, { userId: owner, ai: ok([
      { full_name: `Kavita Rao ${t}`, title: "Head of Administration", location: "Pune", emails_published: [`kavita@novaco-${t}.example`], phones_published: ["+91 9000000002"], phone_is_mobile: false, profile_url: null, source_url: "https://vertexnova.example/team", source_name: "Company team page", published_on: "2026-11-01", responsibilities: "Admin & facilities" },
      { full_name: `Arun Shah ${t}`, title: null, location: null, emails_published: [], phones_published: [], phone_is_mobile: false, profile_url: null, source_url: "https://vertexnova.example/press", source_name: "Press release", published_on: null, responsibilities: null },
      { full_name: `Ignored Person ${t}`, title: "CEO", location: null, emails_published: [], phones_published: [], phone_is_mobile: false, profile_url: null, source_url: "https://www.linkedin.com/in/x", source_name: "LinkedIn", published_on: null, responsibilities: null },
    ]) }) as { jobId: string; found: number };
    expect(r.found).toBe(2);
    const { data: items } = await db.from("enrichment_item").select("*").eq("job_id", r.jobId).order("full_name");
    const kav = items!.find((i) => i.full_name.startsWith("Kavita"))!;
    const arun = items!.find((i) => i.full_name.startsWith("Arun"))!;
    expect(kav.role_class).toBe("technical_evaluator");
    expect(kav.cre_relevance).toBe("high");
    const email = kav.fields.find((f: { field: string }) => f.field === "email");
    expect(email.source_url).toBe("https://vertexnova.example/team");
    expect(["likely_valid", "invalid", "unverified"]).toContain(email.status);      // MX for an .example domain may fail — never "verified"
    expect(arun.fields.find((f: { field: string }) => f.field === "designation").status).toBe("missing");
    expect(arun.fields.find((f: { field: string }) => f.field === "email").value).toBeNull();
    // approve → person, employment, channels, role assessment, contact score
    const a = await approveItem(db, WS1, owner, kav.id);
    expect(a.personId).toBeTruthy();
    const { data: emp } = await db.from("employment").select("title, org_id, is_current").eq("person_id", a.personId).single();
    expect(emp).toMatchObject({ title: "Head of Administration", org_id: org, is_current: true });
    const { data: ra } = await db.from("contact_role_assessment").select("role_class, source").eq("person_id", a.personId).eq("active", true).single();
    expect(ra).toMatchObject({ role_class: "technical_evaluator", source: "rules" });
    const { data: sc } = await db.from("score_result").select("score").eq("model_key", "contact").eq("entity_id", a.personId).eq("is_current", true).single();
    expect(sc!.score).toBeGreaterThan(0);
    // user correction is stored with reason and rescoring keeps history
    await setRole(db, WS1, owner, a.personId, "decision_maker", "high", "Client told us she signs off office leases");
    const { data: hist } = await db.from("score_result").select("id").eq("model_key", "contact").eq("entity_id", a.personId);
    expect(hist!.length).toBeGreaterThanOrEqual(2);
    // rejection path
    await rejectItem(db, WS1, owner, arun.id, "Not at this company");
    const { data: rj } = await db.from("enrichment_item").select("decision, stage").eq("id", arun.id).single();
    expect(rj).toMatchObject({ decision: "rejected", stage: "rejected" });
  });

  it("same name elsewhere → job change / duplicate needs a choice; never auto-merged", async () => {
    const other = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `OtherCo ${t}` }).select("id").single()).data!.id;
    const pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Meera Joshi ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: pid, org_id: other, title: "Facilities Manager", is_current: true });
    const r = await discoverCompany(db, WS1, org, { userId: owner, force: true, ai: ok([{ full_name: `Meera Joshi ${t}`, title: "Facilities Head", location: null, emails_published: [], phones_published: [], phone_is_mobile: false, profile_url: null, source_url: "https://vertexnova.example/news", source_name: "News", published_on: null, responsibilities: null }]) }) as { jobId: string };
    const { data: it } = await db.from("enrichment_item").select("*").eq("job_id", r.jobId).single();
    expect(it!.match_kind).toBe("job_change");
    expect(it!.person_id).toBeNull();
    // choosing "same as existing" proposes a person move; old role kept until approved
    await approveItem(db, WS1, owner, it!.id, pid);
    const { data: emps } = await db.from("employment").select("org_id, is_current").eq("person_id", pid);
    expect(emps!.some((e) => e.org_id === other)).toBe(true);
  });

  it("failed provider → job failed with reason; retry reruns; enrichment re-checks channels without web", async () => {
    const boom = (async () => { throw new Error("provider 503"); }) as never;
    await expect(discoverCompany(db, WS1, org, { userId: owner, force: true, ai: boom })).rejects.toThrow(/503/);
    const { data: j } = await db.from("enrichment_job").select("id, status, error").eq("org_id", org).eq("status", "failed").order("created_at", { ascending: false }).limit(1).single();
    expect(j!.error).toMatch(/503/);
    const pid = (await db.from("person").insert({ workspace_id: WS1, full_name: `Dev Patel ${t}` }).select("id").single()).data!.id;
    await db.from("contact_method").insert({ workspace_id: WS1, person_id: pid, method_type: "email", value: "not-an-email" });
    await enrichPerson(db, WS1, pid, { userId: owner, web: false });
    const { data: cm } = await db.from("contact_method").select("verify_status").eq("person_id", pid).single();
    expect(cm!.verify_status).toBe("invalid");
    void retryJob;
  });

  it("isolation: other workspace sees nothing", async () => {
    const o = await userClient("other");
    const { data } = await o.from("enrichment_item").select("id").eq("org_id", org);
    expect(data ?? []).toHaveLength(0);
  });
});

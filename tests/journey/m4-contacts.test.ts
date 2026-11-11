// Journey STAGE 4 — Module 4 Contact Enrichment (TEST_PLAN 4.1–4.6). Service level, WS1 as owner, mock AI only.
// Synthetic ABC Technologies data; every name suffixed with tag(). Assertions follow the plan's expected results;
// where a feature does not exist the test fails on purpose (recorded in docs/journey/results-m4-m7.md).
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { userClient, WS1, tag } from "../helpers";
import * as C from "@/modules/contacts/service";
import * as Q from "@/modules/contacts/queries";
import { classify, DEPARTMENTS, matchIdentity } from "@/modules/contacts/rules";
import { warmPaths } from "@/modules/outreach/service";
import { approveAndApply } from "@/modules/changes/service";

type Row = Record<string, any>;
const noAi = (async (c: { mock: () => unknown }) => ({ data: c.mock(), mocked: true, model: "mock:test", usage: { input: 0, output: 0, usd: 0 } })) as never;

describe("STAGE 4 — Contact Enrichment (ABC Technologies)", () => {
  let db: Awaited<ReturnType<typeof userClient>>; let owner: string; const t = tag("j4");
  const dom = `abctech-${t}.example`;
  let abc: string; let rahul: string; let priya: string; let amit: string; let rahulEmp: string; let interactionId: string;

  beforeAll(async () => {
    db = await userClient("owner"); owner = (await db.auth.getUser()).data.user!.id;
    abc = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `ABC Technologies Pvt. Ltd. ${t}`, sector: "Information Technology", domain: dom }).select("id").single()).data!.id;
    const mk = async (name: string, title: string) => {
      const id = (await db.from("person").insert({ workspace_id: WS1, full_name: `${name} ${t}` }).select("id").single()).data!.id;
      const e = (await db.from("employment").insert({ workspace_id: WS1, person_id: id, org_id: abc, title, is_current: true, fact_status: "reported" }).select("id").single()).data!.id;
      return { id, e };
    };
    const r = await mk("Rahul Sharma", "Head of Administration"); rahul = r.id; rahulEmp = r.e;
    priya = (await mk("Priya Mehta", "Head of Finance")).id;
    amit = (await mk("Amit Verma", "Head of HR")).id;
    interactionId = (await db.from("interaction").insert({ workspace_id: WS1, occurred_at: "2026-10-01T10:00:00Z", channel: "call", direction: "outbound", summary: `Intro call with Rahul ${t}`, owner_user_id: owner }).select("id").single()).data!.id;
    await db.from("interaction_link").insert({ workspace_id: WS1, interaction_id: interactionId, entity_type: "person", entity_id: rahul, role: "to" });
  });

  it("4.1 identifies relevant professional functions for decision-maker search", async () => {
    const labels = DEPARTMENTS.map((d) => d.label).join(" | ");
    for (const f of [/Corporate Real Estate/, /Administration/, /Facilities/, /Procurement/, /Finance/, /Human Resources|HR/, /Business Leadership/]) expect.soft(labels).toMatch(f);
    // Running "Find people" in mock mode: no key → must fail visibly, never pretend nobody exists (S10).
    const r = await C.discoverCompany(db, WS1, abc, { userId: owner, force: true, ai: noAi });
    expect.soft(r.mocked).toBe(true);
    const { data: job } = await db.from("enrichment_job").select("status, error").eq("id", r.jobId).single();
    expect.soft(job!.status).toBe("failed");
    expect.soft(job!.error ?? "").toMatch(/off|failed|key/i);
    // Plan expects the system to IDENTIFY decision-makers: in mock mode it returns 0 people (only web research finds new people).
    expect(r.found ?? 0, "decision-makers found without an AI key").toBeGreaterThan(0);
  });

  it("4.2 builds a stakeholder map and identifies missing categories", async () => {
    const m = await Q.companyPeople(db, WS1, abc);
    const names = m.people.map((p: Row) => p.person.full_name);
    expect.soft(names).toEqual(expect.arrayContaining([`Rahul Sharma ${t}`, `Priya Mehta ${t}`, `Amit Verma ${t}`]));
    const r = classify("Head of Administration"), p = classify("Head of Finance"), a = classify("Head of HR");
    expect.soft(r.department).toBe("Facilities & Administration");
    expect.soft(["technical_evaluator", "operational"]).toContain(r.role);
    expect.soft(p.role).toBe("economic_buyer");
    expect.soft(a.department).toBe("Human Resources");
    expect.soft(new Set([r.role, p.role, a.role]).size).toBe(3);     // responsibilities distinguishable
    // Missing categories (e.g. Corporate Real Estate, Procurement, Leadership) — no service returns them.
    const svcSrc = fs.readFileSync(path.resolve("src/modules/contacts/queries.ts"), "utf8") + fs.readFileSync(path.resolve("src/app/(app)/contacts/company/[orgId]/page.tsx"), "utf8");
    expect((m as Row).missing ?? (/missing (stakeholder|categor|team)/i.test(svcSrc) ? "ui" : undefined), "stakeholder map reports missing categories").toBeDefined();
  });

  it("4.3 enriches Rahul from an approved synthetic fixture with source, status and date", async () => {
    const fixture = (async () => ({ mocked: false, model: "fixture:test", usage: { input: 0, output: 0, usd: 0 }, web: { queries: ["fixture"], sources: [] },
      data: { people: [{ full_name: `Rahul Sharma ${t}`, title: "Head of Administration", location: "Pune", emails_published: [`rahul.sharma@${dom}`], phones_published: ["+912066001234"], phone_is_mobile: false, profile_url: null, source_url: `https://${dom}/leadership`, source_name: "ABC Technologies leadership page (fixture)", published_on: "2026-11-01", responsibilities: "Admin & facilities, Pune", source_type: "company_site", company: null }], company_contact: null, suggested_roles: [] } })) as never;
    const r = await C.enrichPerson(db, WS1, rahul, { userId: owner, ai: fixture });
    expect(r.found).toBe(1);
    const { data: it } = await db.from("enrichment_item").select("*").eq("job_id", r.jobId).single();
    expect.soft(it!.match_kind).toBe("existing");
    const email = (it!.fields as Row[]).find((f) => f.field === "email")!;
    expect.soft(email.source_url).toMatch(/leadership/);
    expect.soft(email.status).not.toBe("verified");                    // published ≠ verified
    await C.approveItem(db, WS1, owner, it!.id);
    // .example has no MX → the email is rated invalid and (correctly) not stored; the published phone is stored.
    expect.soft(["invalid", "unverified", "likely_valid", "risky"]).toContain(email.status);
    const { data: cms } = await db.from("contact_method").select("*").eq("workspace_id", WS1).eq("value", "+912066001234").order("created_at", { ascending: false }).limit(1);
    const cm = cms?.[0];
    expect(cm, "approved phone stored").toBeTruthy();
    expect.soft(cm!.person_id, "channel stored on the EXISTING Rahul (not a new duplicate person)").toBe(rahul);
    expect.soft(cm!.source_name).toMatch(/leadership page/);
    expect.soft(cm!.verify_status).toBe("published_business");
    expect.soft(cm!.observed_on).toBe("2026-11-01");
    const { data: p } = await db.from("person").select("last_enriched_at, next_review_on").eq("id", rahul).single();
    expect.soft(p!.last_enriched_at).toBeTruthy();
    // "Last verification date is recorded" — verified_on/last_checked_at for the new channel
    expect(cm!.last_checked_at ?? cm!.verified_on, "last verification/check date on the stored channel").toBeTruthy();
  });

  it("4.4 employment change keeps history, adds a separate relationship, keeps interactions", async () => {
    const xyz = (await db.from("organisation").insert({ workspace_id: WS1, display_name: `XYZ Systems ${t}` }).select("id").single()).data!.id;
    const { proposePersonMove } = await import("@/modules/changes/service");
    const ps = await proposePersonMove(db, WS1, { personId: rahul, newOrgId: xyz, title: "Director Workplace", reason: `Rahul Sharma has moved to another company (${t})`, actorUserId: owner });
    expect.soft((await db.from("employment").select("is_current").eq("id", rahulEmp).single()).data!.is_current).toBe(true);   // nothing written before approval
    for (const p of ps as Row[]) await approveAndApply(db, p.id, { actorUserId: owner, note: "journey 4.4" });
    const { data: emps } = await db.from("employment").select("org_id, is_current, title").eq("person_id", rahul).is("archived_at", null);
    expect.soft(emps!.find((e) => e.org_id === abc)).toMatchObject({ is_current: false, title: "Head of Administration" });
    expect.soft(emps!.find((e) => e.org_id === xyz)).toMatchObject({ is_current: true });
    expect.soft((await db.from("organisation").select("id").in("id", [abc, xyz]).is("archived_at", null)).data!.length).toBe(2);   // not merged
    const { data: links } = await db.from("interaction_link").select("interaction_id").eq("entity_type", "person").eq("entity_id", rahul);
    expect(links!.map((l) => l.interaction_id)).toContain(interactionId);
  });

  it("4.5 duplicate Rahul record is flagged for review, not merged", async () => {
    const dup = (await db.from("person").insert({ workspace_id: WS1, full_name: `Rahul Sharma ${t}` }).select("id").single()).data!.id;
    await db.from("employment").insert({ workspace_id: WS1, person_id: dup, org_id: abc, title: "Admin Head", is_current: true });
    const { data: ppl } = await db.from("person").select("id, full_name, aliases, public_profile_url, employment(org_id, is_current)").eq("workspace_id", WS1).eq("full_name", `Rahul Sharma ${t}`);
    const existing = (ppl ?? []).map((p: Row) => ({ id: p.id, full_name: p.full_name, aliases: p.aliases ?? [], emails: [], profile: null, current_org_ids: p.employment.filter((e: Row) => e.is_current).map((e: Row) => e.org_id), past_org_ids: [] }));
    const m = matchIdentity({ full_name: `Rahul Sharma ${t}`, emails: [], profile: null, org_id: null }, existing);
    expect.soft(m.kind).toBe("possible_duplicate");
    expect.soft(m.candidates.length).toBeGreaterThanOrEqual(2);                         // shows matching records
    const merge = await C.flagDuplicate(db, WS1, owner, rahul, dup, "Same person, different designation");
    expect.soft((merge as Row).state).toBe("proposed");              // review, not blind merge
    expect((await db.from("person").select("archived_at").eq("id", dup).single()).data!.archived_at).toBeNull();
    // Creating the duplicate through the app raised no warning itself — detection only on the Duplicates tab / enrichment.
  });

  it("4.6 warm introduction path with evidence; nothing invented", async () => {
    const neha = (await db.from("person").insert({ workspace_id: WS1, full_name: `Neha Kapoor ${t}` }).select("id").single()).data!.id;
    await db.from("relationship_edge").insert({ workspace_id: WS1, from_user_id: owner, to_person_id: neha, edge_type: "client_of", warmth: "warm", strength_basis: "Closed a Baner lease together in 2025" });
    await db.from("relationship_edge").insert({ workspace_id: WS1, from_person_id: neha, to_person_id: rahul, edge_type: "worked_with", warmth: "warm", strength_basis: "Worked together at XYZ 2019–2022 (synthetic)" });
    const paths = await warmPaths(db, WS1, owner, rahul);
    expect.soft(paths).toHaveLength(1);
    expect.soft(paths[0]).toMatchObject({ personId: neha, introPermission: false });
    expect.soft(paths[0].yourLink).toMatch(/client_of/);
    expect.soft(await warmPaths(db, WS1, owner, amit)).toEqual([]);   // no invented mutual relationship
    expect((paths[0] as Row).evidence ?? (paths[0] as Row).strength_basis ?? (paths[0] as Row).basis, "path explains the evidence (strength_basis)").toBeTruthy();
  });
});

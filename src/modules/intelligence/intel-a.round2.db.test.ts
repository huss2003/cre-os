/**
 * Round 2 (intel-A) DB-backed acceptance tests (shared local Supabase, RLS enforced via the seeded owner).
 * Fixtures are uniquely tagged; only rows created here are removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { userClient, adminClient, tag, WS1, USERS } from "../../../tests/helpers";
import type { AiCall } from "./common";
import { addPastedEvidence, upsertWatch, webResearch, generateDossier } from "./research/service";
import { saveSource, setSourceAllowed, pasteSourceOptions } from "./research/registry";
import { recordJobMove, verifyJobMove, introPathsForOrg } from "./network/service";
import { recordRelationship, recordIntroConsent, revokeIntroConsent, draftIntroRequest, IntroConsentRequiredError } from "./network/relationships";
import { recentJobMoves } from "./research/queries";
import { strategyFor, saveStrategySnapshot, refreshStrategyForEvent, setConcessionStatus } from "./strategy/service";
import { handlers } from "./jobs";

type Db = Awaited<ReturnType<typeof userClient>>;
let db: Db;
const admin = adminClient();
const T = tag("intelA2");
const created: { table: string; id: string }[] = [];
const ids = { org: "", org2: "", target: "", introducer: "", mover: "", req: "", opp: "", quote: "", lic: "" };

async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  created.push({ table, id: data.id });
  return data.id as string;
}
const jobsFor = async (fragment: string) => (await admin.from("job").select("id, job_type, dedupe_key, payload").like("dedupe_key", `%${fragment}%`)).data ?? [];

beforeAll(async () => {
  db = await userClient("owner");
  ids.org = await ins("organisation", { display_name: `${T} Acme` });
  ids.org2 = await ins("organisation", { display_name: `${T} Beta` });
  ids.target = await ins("person", { full_name: `${T} Tara Target` });
  ids.introducer = await ins("person", { full_name: `${T} Ivan Introducer` });
  ids.mover = await ins("person", { full_name: `${T} Mona Mover` });
  await ins("employment", { person_id: ids.target, org_id: ids.org, title: "Head of Real Estate", is_current: true, fact_status: "currently_confirmed", start_date: "2024-01-01" });
  await ins("employment", { person_id: ids.mover, org_id: ids.org, title: "Admin Lead", is_current: true, fact_status: "currently_confirmed", start_date: "2022-01-01" });
  ids.lic = await ins("licensed_source", { name: `${T} Matrix`, allowed_purposes: ["research"], permits_ai_processing: false, expires_on: "2030-01-01" });
}, 60_000);

afterAll(async () => {
  const people = [ids.target, ids.introducer, ids.mover];
  await admin.from("introduction_consent").delete().eq("workspace_id", WS1).in("target_person_id", people);
  await admin.from("consent_permission").delete().eq("workspace_id", WS1).in("person_id", people);
  await admin.from("draft").delete().eq("workspace_id", WS1).in("recipient_person_id", people);
  await admin.from("relationship_edge").delete().eq("workspace_id", WS1).in("to_person_id", people);
  await admin.from("task").delete().eq("workspace_id", WS1).like("idempotency_key", `network.verify_job_move:${ids.mover}:%`);
  const { data: claims } = await admin.from("signal_claim").select("id").eq("workspace_id", WS1).in("subject_id", [ids.org, ids.org2, ...people]);
  const claimIds = (claims ?? []).map((c) => c.id);
  for (const cid of claimIds) await admin.from("change_proposal").delete().eq("workspace_id", WS1).like("idempotency_key", `jobmove:${cid}:%`);
  await admin.from("research_dossier").delete().eq("workspace_id", WS1).in("org_id", [ids.org, ids.org2]);
  await admin.from("watchlist").delete().eq("workspace_id", WS1).in("org_id", [ids.org, ids.org2]);
  await admin.from("signal_claim").delete().eq("workspace_id", WS1).in("subject_id", [ids.org, ids.org2, ...people]);
  await admin.from("research_source_registry").delete().eq("workspace_id", WS1).like("name", `${T}%`);
  if (ids.opp) {
    await admin.from("negotiation_log").delete().eq("opportunity_id", ids.opp);
    const { data: st } = await admin.from("concession_step").select("id").eq("opportunity_id", ids.opp);
    for (const x of st ?? []) await admin.from("job").delete().like("dedupe_key", `deals.concession_npv:${x.id}:%`);
    await admin.from("concession_step").delete().eq("opportunity_id", ids.opp);
    await admin.from("objection_log").delete().eq("opportunity_id", ids.opp);
    await admin.from("opportunity_stage_history").delete().eq("opportunity_id", ids.opp);
  }
  for (const f of [ids.org, ids.org2, ids.opp, ids.req].filter(Boolean)) await admin.from("job").delete().like("dedupe_key", `%${f}%`);
  await admin.from("employment").delete().eq("workspace_id", WS1).in("person_id", people);
  if (ids.req) await admin.from("quote").delete().eq("workspace_id", WS1).eq("requirement_id", ids.req);
  for (const c of [...created].reverse()) await admin.from(c.table).delete().eq("id", c.id);
});

describe("05 source registry: approved sources can be managed and unlock evidence + web research", () => {
  it("registry entries can be added, disabled and re-enabled; disabled sources cannot be cited", async () => {
    const s = await saveSource(db, WS1, { name: `${T} Acme press`, kind: "press", baseUrl: "https://acme.example", acquisitionMethod: "manual_paste", licence: "public press release" }, { userId: USERS.owner.id });
    expect(s.prohibited_methods).toEqual(expect.arrayContaining(["scraping", "captcha_bypass"]));
    const again = await saveSource(db, WS1, { name: `${T} Acme press`, kind: "press", acquisitionMethod: "manual_paste" }, { userId: USERS.owner.id });
    expect(again.id).toBe(s.id); // replay-safe
    expect((await pasteSourceOptions(db, WS1)).some((o) => o.id === s.id)).toBe(true);
    const ev = await addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "footprint", text: `${T} Acme occupies two floors in Kharadi`, url: "https://acme.example/news/1", sourceId: String(s.id), evidenceTier: "credible_reported" }, USERS.owner.id);
    expect(ev.evidence_tier).toBe("credible_reported");
    expect((ev.value_json as Record<string, unknown>).registry_source_id).toBe(s.id);
    await setSourceAllowed(db, WS1, String(s.id), false, USERS.owner.id);
    await expect(addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "footprint", text: `${T} another note`, sourceId: String(s.id) }, USERS.owner.id)).rejects.toThrow(/not an allowed source/);
    await setSourceAllowed(db, WS1, String(s.id), true, USERS.owner.id);
  });

  it("evidence with no named source is refused; a manual note is stored with a lowered tier", async () => {
    await expect(addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "other", text: `${T} unsourced` }, USERS.owner.id)).rejects.toThrow(/Name the source/);
    const m = await addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "headcount", text: `${T} about 300 people`, manualNote: true, evidenceTier: "documentary_current" }, USERS.owner.id);
    expect(m.evidence_tier).toBe("single_unverified");
    expect(m.source_locator).toMatch(/manual note/);
  });

  it("licensed-source evidence is stored licensed_restricted and kept out of AI synthesis when the licence forbids AI", async () => {
    const s = await saveSource(db, WS1, { name: `${T} Matrix export`, kind: "licensed", acquisitionMethod: "licensed_export", licensedSourceId: ids.lic, storageRights: "internal", reuseRights: "no redistribution" }, { userId: USERS.owner.id });
    const ev = await addPastedEvidence(db, WS1, { orgId: ids.org2, claimType: "footprint", text: `${T} LICENSED-ROW Beta leases 40,000 sf`, sourceId: String(s.id), evidenceTier: "documentary_current" }, USERS.owner.id);
    expect(ev.classification).toBe("licensed_restricted");
    let seen = "";
    const spy: AiCall = async (call) => { seen = call.evidence ?? ""; return { data: call.mock!(), mocked: true, model: "spy", usage: { input: 0, output: 0, usd: 0 } } as never; };
    const d = await generateDossier(db, WS1, ids.org2, { userId: USERS.owner.id, force: true, ai: spy });
    expect(JSON.stringify(d.dossier.sections)).toContain("LICENSED-ROW"); // shown to the user
    expect(seen).not.toContain("LICENSED-ROW");                          // never sent to the model
  });

  it("web research becomes possible once an allowed web-search source exists, within its rate limit", async () => {
    const fake: AiCall = async () => ({ data: { claims: [{ claim_type: "expansion", summary: `${T} Acme to open a new office in Hinjewadi`, source_url: "https://news.example/acme", published_on: "2026-10-01", evidence_excerpt: "new office" }] }, mocked: false, model: "fake", usage: { input: 0, output: 0, usd: 0 } }) as never;
    const before = await webResearch(db, WS1, ids.org, { ai: fake, userId: USERS.owner.id });
    if (before.status === "skipped") expect(before.reason).toMatch(/registry|rate limit/);
    await saveSource(db, WS1, { name: `${T} Web search`, kind: "website", acquisitionMethod: "gateway_web_search", rateLimitPerDay: 1 }, { userId: USERS.owner.id });
    const r = await webResearch(db, WS1, ids.org, { ai: fake, userId: USERS.owner.id });
    expect(r.status).toBe("ok");
    const again = await webResearch(db, WS1, ids.org, { ai: fake, userId: USERS.owner.id });
    expect(again).toMatchObject({ status: "skipped" }); // rate limit (1/day) or another allowed source already used
  });
});

describe("05 signal detection triggers a deduped research refresh for watchlist companies", () => {
  it("creates a linked, expiring hypothesis and enqueues one refresh job per evidence item", async () => {
    await upsertWatch(db, WS1, { orgId: ids.org, tier: "active", userId: USERS.owner.id });
    const ev = await addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "other", manualNote: true, text: `${T} Acme announced it is hiring 500 engineers and will open a new campus in Pune`, observedOn: "2026-10-20" }, USERS.owner.id);
    const { data: hyps } = await admin.from("signal_claim").select("claim_type, status, evidence_tier, expires_on, value_json").eq("workspace_id", WS1).eq("value_json->>source_claim_id", ev.id);
    const kinds = (hyps ?? []).map((h) => h.claim_type).sort();
    expect(kinds).toEqual(expect.arrayContaining(["expansion", "hiring"]));
    for (const h of hyps ?? []) { expect(h.status).toBe("ai_inference"); expect(h.evidence_tier).toBe("inference"); expect(h.expires_on).toBeTruthy(); }
    const hiring = (hyps ?? []).find((h) => h.claim_type === "hiring")!;
    expect(String((hiring.value_json as Record<string, unknown>).summary)).toMatch(/not an office-size commitment/);
    const jobs = (await jobsFor(`intelligence.research_org:${WS1}:${ids.org}:${ev.id}`));
    expect(jobs).toHaveLength(1);
    // replay: same paste => no new hypotheses, still one job
    await addPastedEvidence(db, WS1, { orgId: ids.org, claimType: "other", manualNote: true, text: `${T} Acme announced it is hiring 500 engineers and will open a new campus in Pune`, observedOn: "2026-10-20" }, USERS.owner.id);
    const { count } = await admin.from("signal_claim").select("id", { count: "exact", head: true }).eq("value_json->>source_claim_id", ev.id);
    expect(count).toBe(hyps!.length);
    expect(await jobsFor(`intelligence.research_org:${WS1}:${ids.org}:${ev.id}`)).toHaveLength(1);
    // the queued job refreshes the dossier and leaves one in-app notice for the watch owner
    const job = jobs[0];
    const out = await handlers["intelligence.research_org"]({ id: job.id, workspace_id: WS1, job_type: job.job_type, payload: job.payload, attempts: 1, due_at: new Date().toISOString(), dedupe_key: job.dedupe_key }) as { status: string };
    expect(["generated", "skipped"]).toContain(out.status);
    const sig = String((job.payload as Record<string, unknown>).signal_claim_id);
    const { count: notes } = await admin.from("outbox").select("id", { count: "exact", head: true }).eq("workspace_id", WS1).eq("dedupe_key", `research.signal:${sig}`);
    expect(notes).toBe(1);
    await admin.from("outbox").delete().eq("workspace_id", WS1).eq("dedupe_key", `research.signal:${sig}`);
  });
});

describe("06 relationships and introduction consent", () => {
  it("records who knows whom without permission; intro drafts need confirmed consent; revocation blocks them again", async () => {
    await recordRelationship(db, WS1, { fromKind: "me", toPersonId: ids.introducer, edgeType: "friend", warmth: "trusted", lastContact: "2026-10-01" }, USERS.owner.id);
    const { edge } = await recordRelationship(db, WS1, { fromKind: "person", fromPersonId: ids.introducer, toPersonId: ids.target, edgeType: "worked_with", warmth: "warm", strengthBasis: "Worked together at a previous firm" }, USERS.owner.id);
    expect(edge.intro_permission).toBe(false);
    const dupe = await recordRelationship(db, WS1, { fromKind: "person", fromPersonId: ids.introducer, toPersonId: ids.target, edgeType: "worked_with", warmth: "hot" }, USERS.owner.id);
    expect(dupe.created).toBe(false);

    let paths = await introPathsForOrg(db, WS1, ids.org, USERS.owner.id);
    const p = paths.find((x) => x.target_person_id === ids.target)!;
    expect(p.needs_permission).toBe(true);
    expect(p.consent_edge_id).toBe(edge.id);
    await expect(draftIntroRequest(db, WS1, { edgeId: String(edge.id), userId: USERS.owner.id })).rejects.toBeInstanceOf(IntroConsentRequiredError);

    const consent = await recordIntroConsent(db, WS1, { edgeId: String(edge.id), givenBy: "introducer", givenOn: "2026-10-30", method: "call", evidence: "said happy to connect" }, USERS.owner.id);
    expect(consent.owner_user_id).toBe(USERS.owner.id);   // recorded by whom
    expect(consent.given_on).toBe("2026-10-30");          // when
    const { data: e2 } = await admin.from("relationship_edge").select("intro_permission").eq("id", edge.id).single();
    expect(e2!.intro_permission).toBe(true);
    paths = await introPathsForOrg(db, WS1, ids.org, USERS.owner.id);
    expect(paths.find((x) => x.target_person_id === ids.target)!.needs_permission).toBe(false);

    const draft = await draftIntroRequest(db, WS1, { edgeId: String(edge.id), userId: USERS.owner.id });
    expect(draft.channel).toBe("introduction");
    expect(draft.state).toBe("drafted"); // never sent

    await revokeIntroConsent(db, WS1, String(consent.id), "changed mind");
    const { data: e3 } = await admin.from("relationship_edge").select("intro_permission").eq("id", edge.id).single();
    expect(e3!.intro_permission).toBe(false);
    await expect(draftIntroRequest(db, WS1, { edgeId: String(edge.id), userId: USERS.owner.id })).rejects.toBeInstanceOf(IntroConsentRequiredError);
  });
});

describe("06 job move: dedicated deduped verification task; unverified until confirmed", () => {
  it("creates one verification task per move, keeps the move unverified, then confirms it", async () => {
    const input = { personId: ids.mover, fromOrgId: ids.org, toOrgId: ids.org2, newTitle: "Workplace Head", sourceKind: "native_alert" as const };
    const a = await recordJobMove(db, WS1, input, USERS.owner.id);
    const b = await recordJobMove(db, WS1, input, USERS.owner.id);
    expect(a.task).toBeTruthy();
    expect(b.task!.id).toBe(a.task!.id);
    expect(b.claim!.id).toBe(a.claim!.id);
    const { count } = await admin.from("task").select("id", { count: "exact", head: true }).eq("workspace_id", WS1).eq("idempotency_key", `network.verify_job_move:${ids.mover}:${ids.org2}`);
    expect(count).toBe(1);
    expect(a.proposals!.length).toBeGreaterThan(0); // approval proposals still created
    let moves = await recentJobMoves(db, WS1, 50);
    expect(moves.find((m) => m.id === a.claim!.id)!.verified).toBe(false);
    const { data: emp } = await admin.from("employment").select("is_current").eq("person_id", ids.mover).eq("org_id", ids.org).single();
    expect(emp!.is_current).toBe(true); // history intact until approved

    const v = await verifyJobMove(db, WS1, String(a.claim!.id), "Confirmed on company website");
    expect(v.taskClosed).toBe(true);
    moves = await recentJobMoves(db, WS1, 50);
    expect(moves.find((m) => m.id === a.claim!.id)!.verified).toBe(true);
  });
});

describe("15 deal strategist: deal events re-run the snapshot; recommendations cite facts; ladder on concession_step", () => {
  it("reads the deals objection log, cites it, triggers jobs on stage/quote/objection and stays suggestion-only", async () => {
    ids.req = await ins("requirement", { org_id: ids.org, title: `${T} Pune HQ`, status: "draft" });
    ids.opp = await ins("opportunity", { org_id: ids.org, requirement_id: ids.req, name: `${T} deal`, stage: "options_visits", outcome: "open" });
    ids.quote = await ins("quote", { requirement_id: ids.req, version: 1, valid_until: "2027-01-31", terms_json: { rent: 90, escalation: 5, deposit: 10, lockin: 36, rent_free: 1 }, evidence: "landlord email" });
    expect(await jobsFor(`intelligence.strategy:${WS1}:${ids.opp}:quote:${ids.quote}`)).toHaveLength(1);

    const obj = await ins("objection_log", { opportunity_id: ids.opp, requirement_id: ids.req, category: "price", objection: `${T} Rent is above the approved budget` });
    expect(await jobsFor(`intelligence.strategy:${WS1}:${ids.opp}:objection:${obj}`)).toHaveLength(1);

    const s = await strategyFor(db, WS1, ids.opp);
    const objFact = s.context.objections.find((o) => typeof o !== "string" && o.id === obj);
    expect(objFact).toBeTruthy();
    expect(s.batna_questions.some((q) => q.basis.some((b) => b.kind === "objection" && b.id === obj) && q.basis.some((b) => b.kind === "quote" && b.id === ids.quote))).toBe(true);
    expect(s.concession_ladder[0].basis.some((b) => b.id === ids.quote)).toBe(true);

    const first = await saveStrategySnapshot(db, WS1, ids.opp, USERS.owner.id);
    expect(first.saved).toBe(5);
    expect(first.ladderAdded).toBeGreaterThan(0);
    const { data: steps } = await admin.from("concession_step").select("id, status, quote_id, value_json, row_version").eq("opportunity_id", ids.opp);
    expect(steps!.every((x) => x.status === "planned" && x.quote_id === ids.quote)).toBe(true);
    const vj = (item: string) => steps!.map((x) => x.value_json as Record<string, unknown>).find((v) => v.item === item)!;
    expect(vj("rent_free")).toMatchObject({ finance_type: "rent_free", finance_value: 1 });   // quote: 1 month rent-free
    expect(vj("escalation")).toMatchObject({ finance_type: "escalation_pct", finance_value: -1 });
    expect("finance_value" in vj("capex")).toBe(false);                                      // unknown => absent, never 0
    expect((await admin.from("concession_item").select("id", { count: "exact", head: true }).eq("opportunity_id", ids.opp)).count).toBe(0);
    await setConcessionStatus(db, WS1, steps![0].id, "offered", Number(steps![0].row_version));

    const same = await saveStrategySnapshot(db, WS1, ids.opp, USERS.owner.id);
    expect(same).toMatchObject({ saved: 0, ladderAdded: 0 });

    await admin.from("opportunity").update({ stage: "proposal_negotiation" }).eq("id", ids.opp);
    const stageJobs = (await jobsFor(`intelligence.strategy:${WS1}:${ids.opp}:stage:proposal_negotiation`));
    expect(stageJobs).toHaveLength(1);
    const r = await refreshStrategyForEvent(admin, WS1, ids.opp);
    expect(r).toMatchObject({ saved: 5 });
    const { data: opp } = await admin.from("opportunity").select("stage").eq("id", ids.opp).single();
    expect(opp!.stage).toBe("proposal_negotiation"); // never moved by the strategist
    const { data: kept } = await admin.from("concession_step").select("status").eq("id", steps![0].id).single();
    expect(kept!.status).toBe("offered"); // user's decision untouched
  });
});

/**
 * intel-B round 2 — DB-backed acceptance tests (shared local Supabase, RLS via seeded users). Fixtures are tagged and
 * only rows created here are removed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { userClient, adminClient, tag, WS1, WS2, USERS } from "../../../tests/helpers";
import { makePdf } from "./intel-b.fixtures";
import { uploadLegalDocument, legalOriginal } from "./legal/upload";
import { addLegalDocument, compareDocuments, FamilyMismatchError } from "./legal/service";
import { marketOverview, draftMarketNote, setMarketNoteStatus, proposeGeographyMapping } from "./market/service";
import { addPostIdea, linkMarketNote, draftPost, approvePost, checkPost, saveConfidentialTerms, confidentialTerms } from "./content/service";
import { handlers } from "./jobs";

type Db = Awaited<ReturnType<typeof userClient>>;
let db: Db;
const admin = adminClient();
const T = tag("intelb");
const created: { table: string; id: string }[] = [];
const storagePaths: string[] = [];

async function ins(table: string, row: Record<string, unknown>, ws = WS1, owner: string = USERS.owner.id) {
  const { data, error } = await admin.from(table).insert({ workspace_id: ws, owner_user_id: owner, ...row }).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  created.push({ table, id: data.id });
  return data.id as string;
}

beforeAll(async () => { db = await userClient("owner"); }, 60_000);

afterAll(async () => {
  await admin.from("job").delete().like("dedupe_key", `%${T}%`);
  // jobs enqueued by the market_observation trigger for this file's releases (key = md5("<source_version>@<release_date>"))
  const releases = [[`${T} release`, "2026-01-15"], [`${T} west release`, "2026-02-01"], [`${T} north release`, "2026-03-01"]];
  await admin.from("job").delete().in("dedupe_key", releases.map(([v, d]) => `intelligence.market_analysis:${WS1}:release:${createHash("md5").update(`${v}@${d}`).digest("hex")}`));
  await admin.from("change_proposal").delete().eq("workspace_id", WS1).like("idempotency_key", `market.geomap:%`).in("target_id", created.filter((c) => c.table === "geography").map((c) => c.id));
  for (const c of [...created].reverse()) await admin.from(c.table).delete().eq("id", c.id);
  if (storagePaths.length) await admin.storage.from("mudar-workspace-files").remove(storagePaths);
}, 60_000);

describe("Legal Desk (16) persistence", () => {
  it("uploads a PDF: original stored + source_object linked, page locators kept, related lease sets org + building", async () => {
    const org = await ins("organisation", { display_name: `${T} Tenant` });
    const asset = await ins("asset", { name: `${T} Tower`, asset_kind: "building" });
    const lease = await ins("lease", { tenant_org_id: org, asset_id: asset });
    const pdf = makePdf([["LETTER OF INTENT", `Ref ${T}`, "1. Rent", "The monthly rent shall be Rs. 85 per sq ft."], ["2. Lock-in", "The lock-in period shall be 36 months for the Tenant."]]);
    const r = await uploadLegalDocument(db, WS1, { name: `${T}.pdf`, bytes: pdf }, { title: `${T} LOI`, familyKey: `${T}-loi`, leaseId: lease }, { userId: USERS.owner.id });
    created.push({ table: "legal_document", id: r.document.id });
    const doc = r.document;
    expect(doc.file_kind).toBe("pdf");
    expect(doc.page_count).toBe(2);
    expect(doc.source_object_id).toBeTruthy();
    expect(doc.org_id).toBe(org);
    expect(doc.asset_id).toBe(asset);
    expect(doc.lease_id).toBe(lease);
    const { data: so } = await admin.from("source_object").select("id, uri, sha256").eq("id", doc.source_object_id).single();
    created.splice(created.findIndex((c) => c.id === r.document.id), 0, { table: "source_object", id: so!.id });
    storagePaths.push(String(so!.uri).replace("storage://mudar-workspace-files/", ""));
    const { data: clauses } = await admin.from("clause_extract").select("clause_type, locator").eq("document_id", doc.id);
    expect(clauses!.find((c) => c.clause_type === "lock_in")!.locator.page).toBe(2);
    const orig = await legalOriginal(db, WS1, doc.id);
    expect(orig.buffer.length).toBe(pdf.length);
    // same file again => same version, no duplicate rows
    const again = await uploadLegalDocument(db, WS1, { name: `${T}.pdf`, bytes: pdf }, { title: `${T} LOI`, familyKey: `${T}-loi` }, { userId: USERS.owner.id });
    expect(again.duplicate).toBe(true);
  });

  it("scanned PDF upload is stored as OCR-needed with no clauses", async () => {
    const r = await uploadLegalDocument(db, WS1, { name: `${T}-scan.pdf`, bytes: makePdf([[], [`x${T}`.slice(0, 0)]]) }, { title: `${T} scanned lease`, familyKey: `${T}-scan` }, { userId: USERS.owner.id });
    created.push({ table: "legal_document", id: r.document.id });
    const { data: so } = await admin.from("source_object").select("id, uri").eq("id", r.document.source_object_id).single();
    created.splice(created.length - 1, 0, { table: "source_object", id: so!.id });
    storagePaths.push(String(so!.uri).replace("storage://mudar-workspace-files/", ""));
    expect(r.document.ocr_status).toBe("ocr_needed");
    expect(r.clauseCount).toBe(0);
  });

  it("only versions of the same family are compared unless confirmed; redline stores versions + full-document redline", async () => {
    const text = (n: string) => `LOI ${T}\n\n1. Rent\nThe monthly rent shall be Rs. ${n} per sq ft.\n\n2. Lock-in\nLock-in of 36 months for the Tenant.\n\nSigned in Pune.\n`;
    const a = await addLegalDocument(db, WS1, { title: `${T} A`, familyKey: `${T}-a`, text: text("85") }, { userId: USERS.owner.id });
    const a2 = await addLegalDocument(db, WS1, { title: `${T} A`, familyKey: `${T}-a`, text: text("90").replace("Signed in Pune.", "Signed in Mumbai.") }, { userId: USERS.owner.id });
    const other = await addLegalDocument(db, WS1, { title: `${T} B`, familyKey: `${T}-b`, text: text("70") }, { userId: USERS.owner.id });
    await expect(compareDocuments(db, WS1, a.document.id, other.document.id, USERS.owner.id)).rejects.toThrow(FamilyMismatchError);
    const cross = await compareDocuments(db, WS1, a.document.id, other.document.id, USERS.owner.id, { confirmCrossFamily: true });
    expect(cross.same_family).toBe(false);
    expect(cross.cross_family_confirmed).toBe(true);
    const cmp = await compareDocuments(db, WS1, a.document.id, a2.document.id, USERS.owner.id);
    created.push({ table: "clause_comparison", id: cross.id }, { table: "clause_comparison", id: cmp.id });
    created.push(...[a2, other, a].map((d) => ({ table: "legal_document", id: d.document.id })));
    expect([cmp.base_version, cmp.compare_version]).toEqual([1, 2]);
    const lines = (cmp.full_redline.hunks as { lines: { op: string; text: string; new_line: number | null }[] }[]).flatMap((h) => h.lines);
    expect(lines.some((l) => l.op === "ins" && /Mumbai/.test(l.text) && l.new_line! > 0)).toBe(true); // outside any clause
    const items = cmp.exposure_checklist as { document: { version: number } | null; locator: unknown; clause_type: string }[];
    expect(items.filter((i) => i.locator).every((i) => i.document?.version === 2)).toBe(true);
  });
});

describe("Market Analyst (19) persistence", () => {
  const metric = `absorption_${T.replace(/-/g, "_")}`;

  it("a new release enqueues ONE deduped analysis job (SQL trigger) and the job flags inconsistencies", async () => {
    const base = { metric, geography_raw: `${T} East`, unit: "msf", definition: "Gross absorption", release_date: "2026-01-15", source_version: `${T} release` };
    const { data: rows, error } = await admin.from("market_observation").insert([
      { workspace_id: WS1, owner_user_id: USERS.owner.id, ...base, period_start: "2024-01-01", period_type: "full_year", value: 3 },
      { workspace_id: WS1, owner_user_id: USERS.owner.id, ...base, period_start: "2025-01-01", period_type: "full_year", value: 4, definition: "Net absorption" },
    ]).select("id");
    if (error) throw error;
    created.push(...rows!.map((r) => ({ table: "market_observation", id: r.id })));
    const r3 = await ins("market_observation", { ...base, period_start: "2025-04-01", period_type: "quarter", value: 1 }); // second statement, same release
    expect(r3).toBeTruthy();
    const { data: jobs } = await admin.from("job").select("id, dedupe_key, payload, workspace_id, job_type, attempts, due_at").eq("workspace_id", WS1).eq("job_type", "intelligence.market_analysis").contains("payload", { trigger: "release" }).gte("created_at", new Date(Date.now() - 60_000).toISOString());
    const mine = (jobs ?? []).filter((j) => /release:/.test(j.dedupe_key));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    // dedupe: the same release key yields a single job
    const keys = mine.map((j) => j.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
    const job = mine[mine.length - 1];
    await admin.from("job").update({ dedupe_key: `${job.dedupe_key}:${T}` }).eq("id", job.id); // so afterAll removes it
    const out = (await handlers["intelligence.market_analysis"]({ ...job, dedupe_key: `${job.dedupe_key}:${T}` } as never)) as { analysis_id: string; duplicate: boolean };
    created.push({ table: "market_analysis", id: out.analysis_id });
    const { data: an } = await admin.from("market_analysis").select("flags, trigger_kind").eq("id", out.analysis_id).single();
    expect(an!.trigger_kind).toBe("release");
    expect((an!.flags as { kind: string; series: string | null }[]).some((f) => f.kind === "definition_change" && (f.series ?? "").includes(T))).toBe(true);
    const again = (await handlers["intelligence.market_analysis"]({ ...job, dedupe_key: `${job.dedupe_key}:${T}` } as never)) as { duplicate: boolean };
    expect(again.duplicate).toBe(true);
    await admin.from("outbox").delete().eq("workspace_id", WS1).eq("dedupe_key", `market.analysis:${out.analysis_id}`);
  });

  it("market note stores sources + release dates, sample size and caveats; raw-name geography mapping is a proposal", async () => {
    const geo = await ins("geography", { level: "micro_market", name: `${T} West`, aliases: [] });
    const base = { metric, geography_raw: `${T} West`, unit: "msf", definition: "Gross absorption", release_date: "2026-02-01", source_version: `${T} west release` };
    await ins("market_observation", { ...base, period_start: "2024-01-01", period_type: "full_year", value: 2 });
    await ins("market_observation", { ...base, period_start: "2025-01-01", period_type: "full_year", value: 2.5 });
    const ov = await marketOverview(db, WS1);
    const s = ov.series.find((x) => x.metric === metric && x.geographyLabel === `${T} West`)!;
    expect(s.geographyStatus).toBe("name_match_only");
    expect(s.geographySuggestion!.id).toBe(geo);
    const prop = await proposeGeographyMapping(db, WS1, { raw: `${T} West`, geographyId: geo }, USERS.owner.id);
    expect(prop.status).toBe("proposed");
    expect(prop.proposal!.target_type).toBe("geography");
    const { data: g } = await admin.from("geography").select("aliases").eq("id", geo).single();
    expect(g!.aliases).toEqual([]); // nothing applied without approval (S4)

    const note = await draftMarketNote(db, WS1, { metric, geography: `${T} West`, seriesKey: s.key }, { userId: USERS.owner.id });
    created.push({ table: "market_note", id: note.id });
    expect(note.sources[0]).toEqual(expect.objectContaining({ name: `${T} west release`, release_date: "2026-02-01" }));
    expect(note.sample_size).toBe(2);
    expect(note.caveats.join(" ")).toMatch(/Not comprehensive/);
    expect((note.facts as { text: string }[]).every((f) => /released 2026-02-01/.test(f.text))).toBe(true);
    expect(note.body).toMatch(/Sources: .* \(released 2026-02-01\)/);
  });
});

describe("Content Editor (20) persistence", () => {
  it("only approved market notes feed drafts; approving a note adds one linked idea; fact-checked draft can be approved", async () => {
    const metric = `supply_${T.replace(/-/g, "_")}`;
    const base = { metric, geography_raw: `${T} North`, unit: "msf", definition: "Completed supply", release_date: "2026-03-01", source_version: `${T} north release` };
    await ins("market_observation", { ...base, period_start: "2024-01-01", period_type: "full_year", value: 1.1 });
    await ins("market_observation", { ...base, period_start: "2025-01-01", period_type: "full_year", value: 1.6 });
    const note = await draftMarketNote(db, WS1, { metric, geography: `${T} North` }, { userId: USERS.owner.id });
    created.push({ table: "market_note", id: note.id });
    const idea = await addPostIdea(db, WS1, { topic: `${T} supply post`, audience: "general" }, USERS.owner.id);
    created.push({ table: "content_post", id: idea.id });
    await expect(linkMarketNote(db, WS1, idea.id, note.id)).rejects.toThrow(/Only approved market notes/);
    await setMarketNoteStatus(db, WS1, note.id, "approved", true, { userId: USERS.owner.id });
    const { data: auto } = await admin.from("content_post").select("id").eq("market_note_id", note.id);
    expect(auto).toHaveLength(1);
    created.push({ table: "content_post", id: auto![0].id });
    await setMarketNoteStatus(db, WS1, note.id, "approved", true, { userId: USERS.owner.id });
    expect((await admin.from("content_post").select("id").eq("market_note_id", note.id)).data).toHaveLength(1); // deduped

    await linkMarketNote(db, WS1, idea.id, note.id);
    const drafted = await draftPost(db, WS1, idea.id);
    expect(drafted.fact_check.unmatched).toBe(0); // template quotes the approved facts verbatim
    const ok = await approvePost(db, WS1, idea.id);
    expect(ok.status).toBe("approved");

    // an unsupported claim reopens review and blocks approval
    const edited = await checkPost(db, WS1, idea.id, { body: `${drafted.body}\nSupply rose 40% in 2026 thanks to Zeta Infotech.`, status: "in_review" });
    expect(edited.fact_check.unmatched).toBeGreaterThanOrEqual(3);
    await expect(approvePost(db, WS1, idea.id)).rejects.toThrow(/every number, date, company and claim/i);

    // un-approving the note removes it as evidence for drafting
    await setMarketNoteStatus(db, WS1, note.id, "in_review");
    await expect(draftPost(db, WS1, idea.id)).rejects.toThrow(/Only approved market notes/);
  });

  it("confidential terms from the workspace setting block approval and yield a private-shareable version", async () => {
    const other = await userClient("other");
    const before = await confidentialTerms(other, WS2);
    try {
      await saveConfidentialTerms(other, WS2, [...before, `Falcon${T}`]);
      const { data: post, error } = await other.from("content_post").insert({ workspace_id: WS2, owner_user_id: USERS.other.id, week_start: "2031-01-06", topic: `${T} confidential`, status: "idea" }).select().single();
      if (error) throw error;
      created.push({ table: "content_post", id: post.id });
      const checked = await checkPost(other, WS2, post.id, { body: `We just wrapped Falcon${T} — notice windows matter.`, status: "in_review" });
      expect((checked.review_checklist as { key: string; ok: boolean }[]).find((i) => i.key === "no_confidential_terms")!.ok).toBe(false);
      expect(checked.private_version).toBe("We just wrapped [confidential] — notice windows matter.");
      await expect(approvePost(other, WS2, post.id)).rejects.toThrow(/confidential/i);
    } finally {
      await saveConfidentialTerms(other, WS2, before);
    }
  });

  it("weekly content plan job is deduped per week and sets planned publish dates", async () => {
    const week = "2031-02-03";
    const job = { id: "x", workspace_id: WS2, job_type: "intelligence.content_plan", payload: { week, owner_user_id: USERS.other.id }, attempts: 0, due_at: new Date().toISOString(), dedupe_key: null };
    const first = (await handlers["intelligence.content_plan"](job as never)) as { created: number };
    const second = (await handlers["intelligence.content_plan"](job as never)) as { created: number };
    const { data: posts } = await admin.from("content_post").select("id, planned_publish_on").eq("workspace_id", WS2).eq("week_start", week);
    created.push(...(posts ?? []).map((p) => ({ table: "content_post", id: p.id })));
    expect(first.created).toBe(3);
    expect(second.created).toBe(0);
    expect((posts ?? []).map((p) => p.planned_publish_on).sort()).toEqual(["2031-02-04", "2031-02-05", "2031-02-06"]);
  });
});

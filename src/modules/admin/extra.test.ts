import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminClient, userClient, USERS, WS1, WS2, tag } from "../../../tests/helpers";
import { setArchived, normaliseInput, vacancyState } from "./entities";
import { createConfig, updateConfig, archiveConfig, listConfig, verifyTemplatePath } from "./config";
import { purgeWorkspace } from "./retention";
import { updateTenantSettings } from "./platform";
import { saveGeneral } from "./settings";
import { AdminError } from "./errors";
import { Client } from "pg";

/** Remove a test-only workspace that has business rows (cascade would fire audit triggers). Test fixtures only. */
async function dropTestWorkspace(id: string) {
  const c = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("delete from mudar.workspace where id = $1 and (slug like 'retention-%' or slug like 'budget-%')", [id]);
    await c.query("commit");
  } finally { await c.end(); }
}

type C = Awaited<ReturnType<typeof userClient>>;

describe("security-review H3: alias_matches only returns aliases of records the caller can read", () => {
  it("colleague gets no alias rows for an unshared account, and gets them once it is shared", async () => {
    const owner = await userClient("owner");
    const colleague = await userClient("colleague");
    const t = tag("aliasleak");
    const { data: org } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: `Hidden ${t}`, owner_user_id: USERS.owner.id, classification: "corporate_confidential" }).select().single();
    const raw = `Secret Alias ${t}`;
    await owner.from("entity_alias").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, raw_alias: raw,
      canonical_alias: raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), owner_user_id: USERS.owner.id, classification: "corporate_confidential" });
    const before = await colleague.schema("mudar_app").rpc("alias_matches", { p_workspace: WS1, p_query: raw });
    expect(before.error).toBeNull();
    expect((before.data as { entity_id: string }[]).map((r) => r.entity_id)).not.toContain(org.id);
    const other = await (await userClient("other")).schema("mudar_app").rpc("alias_matches", { p_workspace: WS1, p_query: raw });
    expect(((other.data ?? []) as { entity_id: string }[]).map((r) => r.entity_id)).not.toContain(org.id);

    await adminClient().from("record_share").insert({ workspace_id: WS1, entity_type: "organisation", entity_id: org.id, user_id: USERS.colleague.id });
    const after = await colleague.schema("mudar_app").rpc("alias_matches", { p_workspace: WS1, p_query: raw });
    expect((after.data as { entity_id: string }[]).map((r) => r.entity_id)).toContain(org.id);
  });
});

describe("entity edits", () => {
  it("archiving a company is a change proposal (material), not a direct write", async () => {
    const owner = await userClient("owner");
    const { data: org } = await owner.from("organisation").insert({ workspace_id: WS1, display_name: tag("ArchiveMe"), owner_user_id: USERS.owner.id }).select().single();
    const res = await setArchived(owner, WS1, "organisation", org.id, Number(org.row_version), true, "duplicate");
    expect(res.proposalId).toBeTruthy();
    const { data: still } = await owner.from("organisation").select("archived_at").eq("id", org.id).single();
    expect(still?.archived_at).toBeNull();
    const { data: cp } = await owner.from("change_proposal").select("operation, risk, approval_required, target_id").eq("id", res.proposalId!).single();
    expect(cp).toMatchObject({ operation: "archive", risk: "material_fact", approval_required: true, target_id: org.id });
    // stale version => conflict
    await expect(setArchived(owner, WS1, "organisation", org.id, Number(org.row_version) - 1, true)).rejects.toMatchObject({ status: 409 });
  });

  it("blank form values stay unknown (null), never 0; vacancy is never invented", () => {
    expect(normaliseInput("organisation", { display_name: "X", headcount_min: "", is_gcc: "" })).toEqual({ display_name: "X", headcount_min: null, is_gcc: null });
    expect(normaliseInput("asset", { name: "T", total_area_sf: "1,20,000" }).total_area_sf).toBe(120000);
    expect(() => normaliseInput("asset", { name: "T", floors: "abc" })).toThrow(AdminError);
    expect(vacancyState(null)).toBe("no_evidence");
    expect(vacancyState({ status: "available", valid_until: "2020-01-01" }, "2026-10-31")).toBe("expired");
    expect(vacancyState({ status: "available", valid_until: null }, "2026-10-31")).toBe("available");
  });
});

describe("tenant configuration records", () => {
  let owner: C;
  beforeAll(async () => { owner = await userClient("owner"); });

  it("partners: JSON terms validated, optimistic concurrency, archive not delete", async () => {
    await expect(createConfig(owner, WS1, USERS.owner.id, "partner", { name: "Bad", partner_type: "referral", terms_json: "{not json" })).rejects.toThrow();
    const name = tag("FitoutFin");
    const row = await createConfig(owner, WS1, USERS.owner.id, "partner", { name, partner_type: "fitout_finance", terms_json: '{"referral_fee_pct": 1}', active: "on" });
    expect(row.terms_json).toEqual({ referral_fee_pct: 1 });
    expect(row.active).toBe(true);
    await expect(updateConfig(owner, WS1, "partner", row.id, Number(row.row_version) + 5, { name, partner_type: "referral" })).rejects.toMatchObject({ status: 409 });
    await updateConfig(owner, WS1, "partner", row.id, Number(row.row_version), { name, partner_type: "referral" });
    await archiveConfig(owner, WS1, "partner", row.id, true);
    expect((await listConfig(owner, WS1, "partner")).map((r) => r.id)).not.toContain(row.id);
    expect((await listConfig(owner, WS1, "partner", { archived: true })).map((r) => r.id)).toContain(row.id);
  });

  it("data lanes keep their original approval time; licensed sources parse purposes", async () => {
    const lane = await createConfig(owner, WS1, USERS.owner.id, "data_lane", { name: tag("Lane"), allowed_classifications: ["public", "permitted_personal"], approved_processors: "supabase, openai", approved: "on" });
    expect(lane.approved_processors).toEqual(["supabase", "openai"]);
    expect(lane.approved_at).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    await updateConfig(owner, WS1, "data_lane", lane.id, Number(lane.row_version), { name: lane.name, allowed_classifications: "public", approved: "on" });
    const { data: after } = await owner.from("data_lane").select("approved_at, allowed_classifications").eq("id", lane.id).single();
    expect(new Date(after!.approved_at).getTime()).toBe(new Date(lane.approved_at).getTime());
    expect(after!.allowed_classifications).toEqual(["public"]);
    const src = await createConfig(owner, WS1, USERS.owner.id, "licensed_source", { name: tag("LeaseDB"), allowed_purposes: "internal_research,\nclient_advice", retention_days: "" });
    expect(src.allowed_purposes).toEqual(["internal_research", "client_advice"]);
    expect(src.retention_days).toBeNull();
    expect(src.permits_ai_processing).toBe(false);
    // clean up: a lane left in the shared test workspace would switch on data-lane enforcement for other suites
    await adminClient().from("data_lane").delete().eq("id", lane.id);
    await adminClient().from("licensed_source").delete().eq("id", src.id);
  });

  it("template paths must be this workspace's templates/ prefix, an Office file of the right kind, and exist", async () => {
    await expect(verifyTemplatePath(owner, WS1, `${WS2}/templates/x.pptx`, "pptx")).rejects.toThrow(/invalid template path/);
    await expect(verifyTemplatePath(owner, WS1, `${WS1}/templates/../backups/x.pptx`, "pptx")).rejects.toThrow(/invalid/);
    await expect(verifyTemplatePath(owner, WS1, `${WS1}/templates/x.docx`, "pptx")).rejects.toThrow(/template format/);
    await expect(verifyTemplatePath(owner, WS1, `${WS1}/templates/${tag("missing")}.pptx`, "pptx")).rejects.toThrow(/not found/);
    const path = `${WS1}/templates/${tag("deck")}.pptx`;
    const up = await owner.storage.from("mudar-workspace-files").upload(path, new Blob(["PK fake"]), { contentType: "application/octet-stream" });
    expect(up.error).toBeNull();
    expect(await verifyTemplatePath(owner, WS1, path, "pptx")).toBe(path);
    await adminClient().storage.from("mudar-workspace-files").remove([path]);
  });
});

describe("retention purge (spec §14)", () => {
  const admin = adminClient();
  let ws: string;
  beforeAll(async () => {
    const slug = tag("retention").toLowerCase();
    const { data } = await admin.from("workspace").insert({ name: `Retention ${slug}`, slug }).select().single();
    ws = data!.id;
  });
  afterAll(async () => {
    await admin.storage.from("mudar-workspace-files").remove([`${ws}/captures/old.m4a`]);
    await dropTestWorkspace(ws);
  });

  it("purges only approved categories, honours legal hold, keeps provenance rows", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await admin.storage.from("mudar-workspace-files").upload(`${ws}/captures/old.m4a`, new Blob(["audio"]), { upsert: true });
    const { data: caps } = await admin.from("capture").insert([
      { workspace_id: ws, kind: "audio", status: "reviewed", source_at: old, transcript: "old words", storage_paths: [`${ws}/captures/old.m4a`, `${ws}/captures/photo.jpg`] },
      { workspace_id: ws, kind: "text", status: "needs_review", source_at: old, transcript: "unreviewed", storage_paths: [] },
      { workspace_id: ws, kind: "text", status: "reviewed", source_at: new Date().toISOString(), transcript: "fresh", storage_paths: [] },
    ]).select("id, status, transcript");
    expect(caps?.length).toBe(3);

    // seeded/unapproved defaults never purge
    let r = await purgeWorkspace(admin, ws);
    expect(r.categories.working_transcripts.status).toBe("skipped");

    const now = new Date().toISOString();
    const pol = await admin.from("retention_policy").insert([
      { workspace_id: ws, category: "raw_audio", retain_days: 30, basis: "x", approved_at: now, legal_hold: true },
      { workspace_id: ws, category: "working_transcripts", retain_days: 180, basis: "x", approved_at: now, legal_hold: false },
      { workspace_id: ws, category: "research_downloads", retain_days: 30, basis: "x", approved_at: null, legal_hold: false },  // not approved
      { workspace_id: ws, category: "audit_records", retain_days: 365, basis: "x", approved_at: now, legal_hold: false },
    ]);
    expect(pol.error).toBeNull();
    const dry = await purgeWorkspace(admin, ws, { dryRun: true });
    expect(dry.categories.working_transcripts.affected).toBe(1);
    r = await purgeWorkspace(admin, ws);
    expect(r.categories.raw_audio).toMatchObject({ status: "skipped", reason: "legal hold" });
    expect(r.categories.research_downloads).toMatchObject({ status: "skipped", reason: "policy not approved by an admin" });
    expect(r.categories.working_transcripts).toMatchObject({ status: "purged", affected: 1 });
    expect(r.categories.audit_records.status).toBe("skipped");
    const { data: after } = await admin.from("capture").select("status, transcript, source_at").eq("workspace_id", ws).order("source_at");
    expect(after?.map((c) => c.transcript).sort()).toEqual([null, "fresh", "unreviewed"].sort() as (string | null)[]);

    // lift the hold => audio file removed, capture row kept with its other files
    await admin.from("retention_policy").update({ legal_hold: false }).eq("workspace_id", ws).eq("category", "raw_audio");
    r = await purgeWorkspace(admin, ws);
    expect(r.categories.raw_audio).toMatchObject({ status: "purged", affected: 1 });
    const { data: audioCap } = await admin.from("capture").select("storage_paths").eq("workspace_id", ws).eq("kind", "audio").single();
    expect(audioCap?.storage_paths).toEqual([`${ws}/captures/photo.jpg`]);
    const { data: files } = await admin.storage.from("mudar-workspace-files").list(`${ws}/captures`);
    expect((files ?? []).map((f) => f.name)).not.toContain("old.m4a");
    const { data: audit } = await admin.from("audit_event").select("action").eq("workspace_id", ws).eq("action", "retention_purge");
    expect(audit?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("platform-only tenant settings (security-review M1 compatible)", () => {
  const admin = adminClient();
  let ws: string;
  beforeAll(async () => {
    const slug = tag("budget").toLowerCase();
    const { data } = await admin.from("workspace").insert({ name: `Budget ${slug}`, slug }).select().single();
    ws = data!.id;
  });
  afterAll(async () => { await dropTestWorkspace(ws); });

  it("only platform admins change AI budget / currency; audited", async () => {
    await expect(updateTenantSettings(admin, USERS.other.id, ws, { monthlyAiBudgetInr: 99999, currency: "USD" })).rejects.toMatchObject({ status: 403 });
    await updateTenantSettings(admin, USERS.owner.id, ws, { monthlyAiBudgetInr: 4500, currency: "inr" });
    const { data } = await admin.from("workspace").select("monthly_ai_budget_inr, currency").eq("id", ws).single();
    expect(Number(data!.monthly_ai_budget_inr)).toBe(4500);
    expect(data!.currency).toBe("INR");
    const { data: audit } = await admin.from("audit_event").select("action").eq("workspace_id", ws).eq("action", "tenant_settings");
    expect(audit?.length).toBe(1);
  });

  it("tenant general settings save only name + timezone (budget input is ignored)", async () => {
    const owner = await userClient("owner");
    const { data: before } = await owner.from("workspace").select("name, timezone, monthly_ai_budget_inr").eq("id", WS1).single();
    await saveGeneral(owner, WS1, { name: before!.name, timezone: before!.timezone, monthly_ai_budget_inr: 1 });
    const { data: after } = await owner.from("workspace").select("monthly_ai_budget_inr").eq("id", WS1).single();
    expect(Number(after!.monthly_ai_budget_inr)).toBe(Number(before!.monthly_ai_budget_inr));
    await expect(saveGeneral(owner, WS1, { name: before!.name, timezone: "Mars/Olympus" })).rejects.toThrow();
  });
});

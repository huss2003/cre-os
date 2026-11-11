/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
/*
 * Input Engine spec §17 scenarios owned by the spreadsheet engine:
 * 10 Excel import · 11 CSV import · 12 automatic column mapping · 13 changed layout · 14 duplicate company ·
 * 15 duplicate contact · 21 duplicate spreadsheet upload · 23 large batch · 24 partial failure (+ temporary retry) ·
 * 28 source traceability · 29 historical value preservation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userClient, adminClient, USERS, tag } from "../../../tests/helpers";
import { approveMapping, processBatch, registerImport } from "./pipeline";
import { createRun, getRun, retryRun } from "./runs";
import { runIsActive } from "./report";
import { handlers } from "./jobs";
import { originalUrl, recordSources, valueHistory } from "./trace";
import { xlsxBytes, type FixtureCell } from "./testkit";

type Db = SupabaseClient<any, any, any>;
const BUCKET = "mudar-workspace-files";
const HEAD = ["Company", "Contact Person", "Designation", "Email", "Mobile", "Office Space", "Location", "Rent", "Expiry", "Source Channel"];

describe("Input Engine spreadsheet engine (DB)", () => {
  const admin = adminClient();
  let ws = "";
  let db: Db;
  const t = tag("ie");
  const C = (s: string) => `${t} ${s}`; // unique company names (prefix keeps legal suffixes at the end)
  const mail = (u: string) => `${u}.${t}@example.in`.toLowerCase();

  beforeAll(async () => {
    const slug = t.toLowerCase();
    const { data, error } = await admin.from("workspace").insert({ name: `Input engine test ${slug}`, slug }).select().single();
    if (error) throw error;
    ws = data.id;
    const m = await admin.from("membership").insert([
      { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true,
        allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] },
    ]);
    if (m.error) throw m.error;
    db = await userClient("owner");
  });
  afterAll(async () => {
    if (!ws) return;
    for (const prefix of [`${ws}/imports`, `${ws}/captures`]) {
      const { data: objs } = await admin.storage.from(BUCKET).list(prefix, { limit: 200 });
      for (const o of objs ?? []) {
        const { data: files } = await admin.storage.from(BUCKET).list(`${prefix}/${o.name}`);
        await admin.storage.from(BUCKET).remove([...(files ?? []).map((f) => `${prefix}/${o.name}/${f.name}`), `${prefix}/${o.name}`]);
      }
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  const count = async (table: string, filter: (q: any) => any = (q) => q) => {
    const { count: n, error } = await filter(admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", ws));
    if (error) throw error;
    return n ?? 0;
  };
  const batch = async (id: string) => (await admin.from("import_batch").select("*").eq("id", id).single()).data as any;
  const orgByName = async (name: string) => (await admin.from("organisation").select("id, display_name, archived_at").eq("workspace_id", ws).eq("display_name", name)).data ?? [];
  const personByEmail = async (email: string) => {
    const { data } = await admin.from("contact_method").select("person_id").eq("workspace_id", ws).eq("value", email);
    return [...new Set((data ?? []).map((d: any) => d.person_id))];
  };
  const upload = async (fileName: string, bytes: Uint8Array) => {
    const reg = await registerImport(db, { workspaceId: ws, userId: USERS.owner.id, fileName, bytes });
    const res = reg.duplicate ? null : await processBatch(db, { workspaceId: ws, batchId: reg.batchId });
    return { reg, res };
  };

  const v1Rows = (): FixtureCell[][] => [
    HEAD,
    [C("Acme Pvt Ltd"), "Raj Mehta", "Head Admin", mail("raj"), "+91 98200 12345", "20,000 sq ft carpet", "Baner", "₹85/sf", "31/03/2027", "Referral"],
    [C("ACME Private Limited"), "Priya Shah", "CFO", mail("priya"), "98201-11111", 15000, "Kharadi", 90, "03/04/2027", "Event"],
    [C("Zen Labs"), "Amit Rao", "", "amit@", "12345", "", "", "", "", ""],
    ["", "No Company Person", "", mail("noco"), "9820033333", "", "", "", "", ""],
  ];
  let v1Batch = "";

  it("10 Excel import + 12 automatic mapping: multiple sheets, mapped, validated, preserved, records created", async () => {
    const bytes = await xlsxBytes([{ name: "Contacts", rows: v1Rows() }, { name: "Readme", rows: [["Exported from CRM"]] }]);
    const { reg, res } = await upload(`leads ${t}.xlsx`, bytes);
    v1Batch = reg.batchId;
    expect(res!.status).toBe("completed_with_exceptions");
    const b = await batch(reg.batchId);
    const sh = b.sheets.find((s: any) => s.sheet === "Contacts");
    expect(sh.adapter).toBe("contacts_requirements_v1");
    // spec §3.2 example mapping
    expect(sh.column_map).toMatchObject({ company: 0, contact_name: 1, designation: 2, email: 3, phone: 4, required_area: 5, preferred_location: 6, expected_rent: 7, lease_expiry: 8 });
    expect(b.sheets.find((s: any) => s.sheet === "Readme").status).not.toBe("mapped");
    // original preserved byte-for-byte
    const so = (await admin.from("source_object").select("sha256, meta").eq("id", b.source_object_id).single()).data!;
    const dl = await admin.storage.from(BUCKET).download(so.meta.storage_path);
    expect(new Uint8Array(await dl.data!.arrayBuffer()).length).toBe(bytes.length);
    // Acme spellings => one company; people with email created with contact methods + employment
    expect((await orgByName(C("Acme Pvt Ltd"))).length + (await orgByName(C("ACME Private Limited"))).length).toBe(1);
    expect(await personByEmail(mail("raj"))).toHaveLength(1);
    expect(await count("contact_method", (q) => q.eq("value", "+919820012345"))).toBe(1);
    // validation report
    const kinds = b.counts.validation.checks.map((c: any) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["invalid_email", "invalid_phone", "missing_company", "missing_area_unit", "possible_duplicate_company", "ambiguous_date"]));
    // custom column kept under its own name
    const { data: sr } = await admin.from("staged_row").select("mapped_json").eq("batch_id", reg.batchId).eq("row_number", 2).single();
    expect(sr!.mapped_json.custom).toEqual({ "Source Channel": "Referral" });
    // requirement is a PROPOSAL (material); area only as sq ft when the unit is stated; expiry stays reported
    const { data: props } = await admin.from("change_proposal").select("patch, state, target_type, operation").eq("workspace_id", ws).eq("target_type", "requirement");
    expect(props!.length).toBe(2);
    const acme = props!.find((p: any) => p.patch.some((o: any) => o.path === "/area_target_sf"))!;
    expect(acme.patch.find((o: any) => o.path === "/area_target_sf").value).toBe(20000);
    expect(acme.patch.find((o: any) => o.path === "/area_basis").value).toBe("carpet");
    const priya = props!.find((p: any) => p !== acme)!;
    expect(priya.patch.some((o: any) => o.path.startsWith("/area_"))).toBe(false); // 15000 without a unit is not assumed sq ft
    const cons = priya.patch.find((o: any) => o.path === "/constraints").value;
    expect(cons.lease_expiry_reported).toMatchObject({ raw: "03/04/2027", ambiguous: true, confirmed: false, fact_status: "reported" });
    expect(cons.area_unit).toBeNull();
    expect(await count("lease_event")).toBe(0); // a spreadsheet expiry never becomes a contractual date
    // orchestrator event
    expect(await count("event_outbox", (q) => q.eq("event_type", "import.completed").eq("subject_id", reg.batchId))).toBe(1);
  }, 60_000);

  it("11 CSV import", async () => {
    const csv = `Company Name,POC,E-mail ID,Phone No,Area Required (sft),Preferred Location\n${C("Csv Corp")},Neha Kulkarni,${mail("neha")},020-26123456,"12,000",Hinjewadi\n`;
    const { res } = await upload(`csv ${t}.csv`, new TextEncoder().encode(csv));
    expect(["completed", "completed_with_exceptions"]).toContain(res!.status);
    expect(await orgByName(C("Csv Corp"))).toHaveLength(1);
    expect(await count("contact_method", (q) => q.eq("value", "+912026123456"))).toBe(1);
    const { data: props } = await admin.from("change_proposal").select("patch").eq("workspace_id", ws).eq("target_type", "requirement").ilike("reason", `%Csv Corp%`);
    expect(props![0].patch.find((o: any) => o.path === "/area_target_sf").value).toBe(12000); // unit stated in the header
  }, 60_000);

  it("12 mapping correction is remembered for future layouts", async () => {
    const rows: FixtureCell[][] = [["Client Name", "Contact Name", "Email", "Desk Count"], [C("Desk Co"), "Ravi Iyer", mail("ravi"), 50]];
    const { reg } = await upload(`desks ${t}.xlsx`, await xlsxBytes([{ name: "Leads", rows }]));
    let b = await batch(reg.batchId);
    expect(b.sheets[0].column_map.required_area).toBeUndefined();
    expect(b.sheets[0].extra_columns.join()).toMatch(/Desk Count/);
    await approveMapping(db, ws, USERS.owner.id, { batchId: reg.batchId, sheet: "Leads", adapter: "contacts_requirements_v1", role: "contacts",
      columnMap: { ...b.sheets[0].column_map, required_area: 3 }, positional: false, headerRow: b.sheets[0].header_row });
    await processBatch(db, { workspaceId: ws, batchId: reg.batchId, allowFrom: ["completed", "completed_with_exceptions"] });
    b = await batch(reg.batchId);
    expect(b.sheets[0].mapping_source).toBe("approved_mapping");
    // a different file with a different layout still containing "Desk Count" maps it automatically
    const other = await upload(`desks2 ${t}.xlsx`, await xlsxBytes([{ name: "Q3", rows: [["Desk Count", "Company", "Contact Person", "Mobile"], [80, C("Desk Two"), "Kiran", "9820044444"]] }]));
    const b2 = await batch(other.reg.batchId);
    expect(b2.sheets[0].column_map.required_area).toBe(0);
    expect(b2.sheets[0].mapping_source).toBe("builtin");
  }, 60_000);

  it("14 duplicate company + 15 duplicate contact against existing records (link, no duplicates; differences proposed)", async () => {
    const { data: org } = await admin.from("organisation").insert({ workspace_id: ws, display_name: C("Zenith Technologies") }).select("id").single();
    const { data: person } = await admin.from("person").insert({ workspace_id: ws, full_name: "Meera Joshi" }).select("id").single();
    await admin.from("contact_method").insert({ workspace_id: ws, person_id: person!.id, method_type: "email", value: mail("meera"), verify_status: "unverified" });
    const people0 = await count("person");
    const rows: FixtureCell[][] = [HEAD,
      [C("Zenith Technologies Pvt Ltd"), "Meera J Joshi", "Admin", mail("meera"), "9820055555", "", "", "", "", ""],
      [C("Zenith Technologies"), "Meera Joshi", "Admin", mail("meera"), "", "", "", "", "", ""], // in-file duplicate
    ];
    const { reg } = await upload(`zenith ${t}.xlsx`, await xlsxBytes([{ name: "Contacts", rows }]));
    expect(await orgByName(C("Zenith Technologies Pvt Ltd"))).toHaveLength(0); // linked to the existing company
    expect(await count("person")).toBe(people0); // linked to the existing person by email
    const { data: staged } = await admin.from("staged_row").select("row_number, status, targets").eq("batch_id", reg.batchId).order("row_number");
    expect(staged!.find((r: any) => r.row_number === 3)!.status).toBe("duplicate");
    expect(staged![0].targets).toEqual(expect.arrayContaining([expect.objectContaining({ type: "organisation", id: org!.id, created: false }), expect.objectContaining({ type: "person", id: person!.id, created: false })]));
    // differences: new phone => contact_method proposal; different name => field conflict + proposal; new employer => employment proposal
    expect(await count("change_proposal", (q) => q.eq("target_type", "contact_method").eq("idempotency_key", `imports.contact_method:${person!.id}|+919820055555`))).toBe(1);
    expect(await count("change_proposal", (q) => q.eq("target_type", "employment").like("idempotency_key", `imports.employment:${person!.id}|%`))).toBe(1);
    const hist = await valueHistory(db, ws, person!.id);
    expect(hist.find((h: any) => h.field === "full_name")).toMatchObject({ master_value: "Meera Joshi", source_value: "Meera J Joshi" });
    expect((await admin.from("person").select("full_name").eq("id", person!.id).single()).data!.full_name).toBe("Meera Joshi"); // never overwritten
  }, 60_000);

  it("21 duplicate spreadsheet upload: same bytes => no-op; re-processing => no new rows", async () => {
    const bytes = await xlsxBytes([{ name: "Contacts", rows: [HEAD, [C("Dup Co"), "Dev Patel", "", mail("dev"), "9820066666", "5000 sft", "Aundh", "", "", ""]] }]);
    const first = await upload(`dup ${t}.xlsx`, bytes);
    const snap = async () => Promise.all(["organisation", "person", "contact_method", "employment", "change_proposal", "staged_row", "source_object", "import_batch"].map((x) => count(x)));
    const before = await snap();
    const again = await upload(`renamed copy ${t}.xlsx`, bytes);
    expect(again.reg.duplicate).toBe(true);
    expect(again.reg.batchId).toBe(first.reg.batchId);
    await processBatch(db, { workspaceId: ws, batchId: first.reg.batchId, allowFrom: ["completed", "completed_with_exceptions"] });
    expect(await snap()).toEqual(before);
  }, 60_000);

  let v2Batch = "";
  it("13 changed layout + 29 history: updated version is diffed, changes proposed, nothing deleted or overwritten", async () => {
    const reqBefore = await count("change_proposal", (q) => q.eq("target_type", "requirement"));
    // reordered + renamed (Mobile -> Phone No) + removed (Rent, Source Channel) + Notes added; Priya's area changed; Zen Labs row removed; new row added
    const v2: FixtureCell[][] = [
      ["Contact Person", "Company", "Email", "Phone No", "Office Space", "Location", "Expiry", "Designation", "Notes"],
      ["Raj Mehta", C("Acme Pvt Ltd"), mail("raj"), "+91 98200 12345", "20,000 sq ft carpet", "Baner", "31/03/2027", "Head Admin", "hot"],
      ["Priya Shah", C("ACME Private Limited"), mail("priya"), "98201-11111", "18000 sft", "Kharadi", "03/04/2027", "CFO", ""],
      ["No Company Person", "", mail("noco"), "9820033333", "", "", "", "", ""],
      ["Tara Nair", C("Nova Systems"), mail("tara"), "9820077777", "8000 sft", "Viman Nagar", "", "VP", ""],
    ];
    const { reg, res } = await upload(`leads ${t}.xlsx`, await xlsxBytes([{ name: "Contacts", rows: v2 }]));
    v2Batch = reg.batchId;
    expect(reg.version).toBe(2);
    expect(res!.status).not.toBe("failed");
    const b = await batch(reg.batchId);
    expect(b.previous_batch_id).toBe(v1Batch);
    expect(b.diff.added).toBeGreaterThanOrEqual(1);
    expect(b.diff.removed).toBeGreaterThanOrEqual(1);
    expect(b.diff.changed).toBeGreaterThanOrEqual(1);
    expect(b.diff.removed_policy).toMatch(/no record is deleted/);
    const lay = b.diff.layout[0];
    expect(lay.removed).toEqual(expect.arrayContaining(["Mobile", "Rent", "Source Channel"]));
    expect(lay.added).toEqual(expect.arrayContaining(["Phone No", "Notes"]));
    expect(lay.moved.length).toBeGreaterThan(0);
    expect(await count("import_exception", (q) => q.eq("batch_id", reg.batchId).eq("kind", "layout_changed"))).toBe(1);
    // removed row: Zen Labs company still there, not archived
    const zen = await orgByName(C("Zen Labs"));
    expect(zen).toHaveLength(1);
    expect(zen[0].archived_at).toBeNull();
    // Priya changed (15000 no unit -> 18000 sft): a new proposal; the earlier one is kept (history)
    const { data: pri } = await admin.from("change_proposal").select("id, patch, created_at").eq("workspace_id", ws).eq("target_type", "requirement").ilike("reason", "%ACME%");
    expect(pri!.length + 0).toBeGreaterThanOrEqual(1);
    expect(await count("change_proposal", (q) => q.eq("target_type", "requirement"))).toBeGreaterThan(reqBefore);
    // unchanged Raj row => no new requirement proposal (same values => same idempotency key)
    expect(await count("change_proposal", (q) => q.eq("target_type", "requirement").ilike("reason", `%${C("Acme Pvt Ltd")}%`))).toBe(1);
    // v1 staged rows are kept (import history)
    expect(await count("staged_row", (q) => q.eq("batch_id", v1Batch))).toBeGreaterThan(0);
  }, 60_000);

  it("28 source traceability: worksheet + cell per value, original openable", async () => {
    const raj = (await personByEmail(mail("raj")))[0] as string;
    const refs = await recordSources(db, ws, raj);
    expect(refs.length).toBeGreaterThanOrEqual(2); // v1 and v2 rows
    const r1 = refs.find((r) => r.batch_id === v1Batch)!;
    expect(r1.cell_refs).toMatchObject({ company: "Contacts!A2", email: "Contacts!D2", phone: "Contacts!E2" });
    expect(r1.values.find((v) => v.field === "email")!.raw).toBe(mail("raj"));
    expect(r1.version).toBe(1);
    const r2 = refs.find((r) => r.batch_id === v2Batch)!;
    expect(r2.cell_refs.company).toBe("Contacts!B2");
    expect(await originalUrl(db, ws, r1.source_object_id)).toMatch(/^http/);
    // tenant-adapter rows get cell refs too (generic column map)
    const org = (await orgByName(C("Csv Corp")))[0];
    const csvRefs = await recordSources(db, ws, org.id);
    expect(csvRefs[0].cell_refs.company).toMatch(/!A2$/);
  }, 60_000);

  let runId = "";
  it("23 large batch: many files at once, async, progress, completion report", async () => {
    const big: FixtureCell[][] = [["Company", "Contact Person", "Email", "Mobile", "Office Space"]];
    for (let i = 0; i < 600; i++) big.push([C(`Bulk ${i % 150}`), `Person ${i}`, mail(`bulk${i}`), `98${String(30000000 + i).padStart(8, "0")}`, i % 50 === 0 ? "10000 sft" : ""]);
    const files = [
      { name: `bulk ${t}.xlsx`, bytes: await xlsxBytes([{ name: "Leads", rows: big }]) },
      { name: `small ${t}.csv`, bytes: new TextEncoder().encode(`Company,Contact Person,Email\n${C("Small Co")},Asha,${mail("asha")}\n`) },
      { name: `brochure ${t}.pdf`, type: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 fake brochure 25,000 sft Baner") },
    ];
    const t0 = Date.now();
    const run = await createRun(db, ws, USERS.owner.id, files, { idempotencyKey: `run-${t}` });
    runId = run.run_id;
    expect(Date.now() - t0).toBeLessThan(30_000); // returns without processing
    let r = (await getRun(db, ws, runId))!;
    expect(r.run.report).toMatchObject({ files_received: 3, done: false });
    expect(r.items.map((i) => i.kind)).toEqual(["spreadsheet", "spreadsheet", "document"]);
    expect(r.items[2].capture_id).toBeTruthy();
    // background jobs
    for (const it of r.items.filter((i) => i.batch_id)) await handlers["imports.process"]({ workspace_id: ws, payload: { batch_id: it.batch_id, allow_from: ["registered", "failed"] } } as any);
    r = (await getRun(db, ws, runId))!;
    expect(r.run.report.files_processed + r.run.report.files_partial).toBe(2);
    expect(r.run.report.records_identified).toBeGreaterThanOrEqual(601);
    expect(r.run.report.records_created).toBeGreaterThanOrEqual(600);
    expect(r.run.report.progress).toBeCloseTo(2 / 3, 2);
    expect(await count("person", (q) => q.like("full_name", "Person %"))).toBe(600);
    // same Idempotency-Key => same run, nothing re-registered
    expect((await createRun(db, ws, USERS.owner.id, files, { idempotencyKey: `run-${t}` })).run_id).toBe(runId);
  }, 180_000);

  it("24 partial failure: bad files identified, good results kept, temporary failure retried", async () => {
    const good = await xlsxBytes([{ name: "Contacts", rows: [HEAD, [C("Good Co"), "Gita", "", mail("gita"), "9820088888", "", "", "", "", ""]] }]);
    const flaky = await xlsxBytes([{ name: "Contacts", rows: [HEAD, [C("Flaky Co"), "Farhan", "", mail("farhan"), "9820099999", "", "", "", "", ""]] }]);
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const legacy = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const run = await createRun(db, ws, USERS.owner.id, [
      { name: `good ${t}.xlsx`, bytes: good }, { name: `broken ${t}.xlsx`, bytes: corrupt }, { name: `old ${t}.xls`, bytes: legacy }, { name: `flaky ${t}.xlsx`, bytes: flaky },
    ]);
    let r = (await getRun(db, ws, run.run_id))!;
    const flakyItem = r.items.find((i) => i.file_name.startsWith("flaky"))!;
    // simulate a temporary storage outage for one file: its original is unreadable during the first attempt
    const fb = await batch(flakyItem.batch_id!);
    const path = (await admin.from("source_object").select("meta").eq("id", fb.source_object_id).single()).data!.meta.storage_path;
    await admin.storage.from(BUCKET).remove([path]);
    for (const it of r.items.filter((i) => i.batch_id)) {
      const job = { workspace_id: ws, payload: { batch_id: it.batch_id, allow_from: ["registered", "failed"] } } as any;
      if (it.file_name.startsWith("flaky")) await expect(handlers["imports.process"](job)).rejects.toThrow(/could not read original/); // temporary => queue retries
      else await handlers["imports.process"](job); // permanent failures are not thrown
    }
    r = (await getRun(db, ws, run.run_id))!;
    expect(r.run.report).toMatchObject({ files_received: 4, files_failed: 3, done: true });
    const ff = Object.fromEntries(r.run.report.failed_files.map((f) => [f.file_name.split(" ")[0], f.retryable]));
    expect(ff).toEqual({ broken: false, old: false, flaky: true });
    expect(await orgByName(C("Good Co"))).toHaveLength(1); // successful file kept
    // the outage is over: retry only the retryable item
    await admin.storage.from(BUCKET).upload(path, flaky, { upsert: true });
    const retry = await retryRun(db, ws, run.run_id, { inline: true });
    expect(retry.retried.find((x) => x.file_name.startsWith("flaky"))!.result).toMatch(/completed/);
    expect(retry.retried.filter((x) => x.result === "not_retryable").length).toBe(2);
    expect(retry.report).toMatchObject({ files_failed: 2 });
    expect(await orgByName(C("Flaky Co"))).toHaveLength(1);
    const { data: runRow } = await admin.from("import_run").select("status").eq("id", run.run_id).single();
    expect(runRow!.status).toBe("completed_with_failures");
  }, 120_000);
  it("24b queued retry keeps the batch page live (auto-refresh) until the retried file finishes", async () => {
    const flaky = await xlsxBytes([{ name: "Contacts", rows: [HEAD, [C("Requeue Co"), "Rina", "", mail("rina"), "9820077777", "", "", "", "", ""]] }]);
    const run = await createRun(db, ws, USERS.owner.id, [{ name: `requeue ${t}.xlsx`, bytes: flaky }]);
    let r = (await getRun(db, ws, run.run_id))!;
    const item = r.items[0];
    const fb = await batch(item.batch_id!);
    const path = (await admin.from("source_object").select("meta").eq("id", fb.source_object_id).single()).data!.meta.storage_path;
    await admin.storage.from(BUCKET).remove([path]);
    const job = { workspace_id: ws, payload: { batch_id: item.batch_id, allow_from: ["registered", "failed"] } } as any;
    await expect(handlers["imports.process"](job)).rejects.toThrow(/could not read original/);
    r = (await getRun(db, ws, run.run_id))!;
    expect(r.run.report.done).toBe(true);
    expect(runIsActive(r.run.report, r.items)).toBe(false);
    await admin.storage.from(BUCKET).upload(path, flaky, { upsert: true });
    await retryRun(db, ws, run.run_id, { inline: false });          // what the "Retry failed file" button does
    r = (await getRun(db, ws, run.run_id))!;
    expect(r.items[0].live_status).toBe("queued");
    expect(runIsActive(r.run.report, r.items)).toBe(true);            // page keeps refreshing
    await handlers["imports.process"](job);
    r = (await getRun(db, ws, run.run_id))!;
    expect(runIsActive(r.run.report, r.items)).toBe(false);           // and stops when done
    expect(await orgByName(C("Requeue Co"))).toHaveLength(1);
  }, 120_000);
});

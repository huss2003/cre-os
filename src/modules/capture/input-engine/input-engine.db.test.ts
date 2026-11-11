/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed PostgREST rows in assertions */
/**
 * Module 10 Input Engine acceptance against the local Supabase (AI gateway in mock mode), in a throwaway workspace.
 * Spec §17 scenarios 1–9, 14–22, 25–30 (spreadsheet scenarios 10–13, 23–24 belong to the imports module).
 * Fixtures (PDF / DOCX / PPTX / business card image) are generated in-test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph } from "docx";
import PptxGenJS from "pptxgenjs";
import { userClient, adminClient, USERS, tag } from "../../../../tests/helpers";
import { createCapture, getReview, submitReview, type Extractor } from "../service";
import { intakeDocument, type DocCtx, type DocDeps } from "../docs/service";
import { AiUnavailableError } from "@/lib/ai/gateway";
import { localDate, atLocal, IST } from "@/lib/util/time";
import { weekdayOptions } from "../extract";
import {
  processAndAnalyse, runInputEngine, correctObservation, rejectObservation, confirmObservation, associateObservation, requestClarification,
  correctTranscript, reviewQueue, captureHistory, searchCaptures, observationsFor, correctionsFor, savePermissions, loadPermissions,
} from "./service";
import { intakeRecording } from "./recording";
import { getTool } from "@/modules/assistant/tools";

const ANIL = "Spoke to Anil. They need around 20,000 feet in Kharadi by September. Budget is 85. Send options Friday.";
const letters = (n: number) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const Cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const enc = (s: string) => new TextEncoder().encode(s);

async function pdf(pages: string[][]) {
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) { const p = d.addPage([595, 842]); lines.forEach((l, i) => p.drawText(l, { x: 50, y: 780 - i * 20, size: 12, font })); }
  return new Uint8Array(await d.save());
}
async function docx(paras: string[]) {
  const d = new Document({ sections: [{ children: paras.map((t) => new Paragraph(t)) }] });
  return new Uint8Array(await Packer.toBuffer(d));
}
async function pptx(slides: string[]) {
  const p = new PptxGenJS();
  for (const s of slides) p.addSlide().addText(s, { x: 0.5, y: 0.5, w: 9, h: 1 });
  return new Uint8Array(await p.write({ outputType: "nodebuffer" }) as Buffer);
}

describe("Input Engine (DB)", () => {
  const admin = adminClient();
  let ws = "";
  let colleague: any;
  let ctx: DocCtx;
  const t = tag("ie");
  const f: Record<string, any> = {};
  const noAi: DocDeps = { processCaptures: false, transcribe: async () => null };
  const own = () => ({ workspace_id: ws, owner_user_id: USERS.colleague.id });
  const ins = async (tbl: string, row: any) => { const r = await admin.from(tbl).insert({ ...own(), ...row }).select().single(); if (r.error) throw r.error; return r.data; };
  const capture = async (text: string, key: string, extra: any = {}) => (await createCapture(colleague, ws, USERS.colleague.id, { kind: "text", text, ...extra }, `${t}-${key}`)).capture;
  const obsOf = (captureId: string) => observationsFor(colleague, ws, { captureId });

  beforeAll(async () => {
    const { data, error } = await admin.from("workspace").insert({ name: `Input ${t}`, slug: t.toLowerCase() }).select().single();
    if (error) throw error;
    ws = data.id;
    await admin.from("membership").insert([
      { workspace_id: ws, user_id: USERS.owner.id, role: "owner", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] },
      { workspace_id: ws, user_id: USERS.colleague.id, role: "editor", see_all_accounts: true, allowed_classifications: ["public", "permitted_personal", "corporate_confidential"] },
    ]);
    colleague = await userClient("colleague");
    ctx = { db: colleague, workspaceId: ws, userId: USERS.colleague.id, role: "editor" };
    f.kharadi = await ins("geography", { level: "locality", name: "Kharadi" });
  });
  afterAll(async () => {
    if (!ws) return;
    for (const dir of ["captures", "captures/docs"]) {
      const { data: objs } = await admin.storage.from("mudar-workspace-files").list(`${ws}/${dir}`, { limit: 100 });
      for (const o of objs ?? []) {
        const { data: files } = await admin.storage.from("mudar-workspace-files").list(`${ws}/${dir}/${o.name}`);
        if (files?.length) await admin.storage.from("mudar-workspace-files").remove(files.map((x) => `${ws}/${dir}/${o.name}/${x.name}`));
      }
    }
    await admin.from("workspace").delete().eq("id", ws);
  });

  // ------------------------------------------------------------------------------------------------ 1, 28, 30
  it("§17.1 Anil example end-to-end: saved, awaiting contact, requirement noted, ONE budget question, Friday task in IST, events", async () => {
    const c = await capture(ANIL, "anil");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine).toBeTruthy();
    const kinds = engine!.receipt.lines.map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(["saved", "matched", "proposed", "questioned", "scheduled"]));
    expect(engine!.receipt.lines.find((l) => l.kind === "matched")!.text).toMatch(/Contact Anil: no existing record — awaiting your confirmation/);
    const proposed = engine!.receipt.lines.find((l) => l.kind === "proposed")!.text;
    for (const part of [/^Requirement noted/, /20,000 feet \(approx\.\)/, /Kharadi/, /September \(informal\)/, /budget 85 \(basis unknown\)/, /once the company is confirmed/]) expect(proposed).toMatch(part);
    expect(engine!.clarifications).toHaveLength(1);
    expect(engine!.clarifications[0].question).toMatch(/₹85 per sq ft per month\? Is CAM extra\?/);
    // the Friday task: next Friday after the capture, 18:00 IST
    const due = weekdayOptions(localDate(new Date(c.source_at), IST), 5)[0];
    const { data: task } = await admin.from("task").select("title, due_at").eq("workspace_id", ws).eq("idempotency_key", `capture:${c.id}:task:0`).single();
    expect(task!.title).toMatch(/^Send options/);
    expect(new Date(task!.due_at).toISOString()).toBe(atLocal(due, "18:00", IST).toISOString());
    // Review: the informal September year and the auto-resolved Friday don't block; budget unit + who is Anil do
    const r = await getReview(colleague, ws, c.id);
    expect(r.open.map((q) => q.kind).sort()).toEqual(["entity", "unit"]);
    // observations: raw budget kept with unknown unit/basis/CAM; source traceability (§17.28)
    const obs = await obsOf(c.id);
    const budget = obs.find((o) => o.field === "budget")!;
    expect(budget).toMatchObject({ raw_text: "Budget is 85", value_json: 85, unit: null, pricing_basis: null, cam_treatment: "unknown", verification: "needs_clarification", status: "pending_review" });
    expect(budget.source_ref).toMatchObject({ capture_id: c.id, locator: expect.stringMatching(/^text:\d+-\d+$/) });
    expect(ANIL.slice(budget.source_ref.start, budget.source_ref.end)).toBe("85");
    expect(obs.find((o) => o.field === "occupation_target")).toMatchObject({ date_class: "informal", value_json: { month: "September", year: null } });
    expect(obs.every((o) => o.observed_at && o.extracted_at && o.source_type === "typed_note")).toBe(true);
    // §17.30 orchestrator notified
    const { data: ev } = await admin.from("event_outbox").select("event_type").eq("workspace_id", ws).eq("subject_id", c.id);
    expect(ev!.map((e) => e.event_type)).toContain("capture.processed");
    // answering the one question confirms basis + CAM; nothing else is asked
    const qi = r.open.find((q) => q.kind === "unit")!.index;
    await submitReview(colleague, admin, ws, USERS.colleague.id, c.id, { answers: { [qi]: "budget_max|per_sf_month|cam_extra" } });
    const e2 = await runInputEngine(admin, ws, c.id);
    expect(e2.clarifications).toEqual([]);
    const b2 = (await obsOf(c.id)).find((o) => o.field === "budget")!;
    expect(b2).toMatchObject({ pricing_basis: "per_sf_month", unit: "INR/sf/month", cam_treatment: "extra", verification: "user_confirmed", fact_class: "confirmed", raw_text: "Budget is 85" });
  });

  it("§5.4 high-confidence contact → company from current employment → requirement proposed (approval, not applied)", async () => {
    const sur = Cap(letters(7));
    const org = await ins("organisation", { display_name: `${Cap(letters(6))} Systems` });
    const p = await ins("person", { full_name: `Anil ${sur}` });
    await ins("employment", { person_id: p.id, org_id: org.id, title: "Admin head", is_current: true });
    const c = await capture(`Spoke to Anil ${sur}. They need around 20,000 feet in Kharadi by September. Budget is 85. Send options Friday.`, "anil-hi");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine!.matches.find((m) => m.kind === "person")).toMatchObject({ tier: "high", id: p.id });
    expect(engine!.receipt.lines.find((l) => l.kind === "proposed")!.text).toMatch(/^Requirement proposed/);
    const { data: cp } = await admin.from("change_proposal").select("state, target_type, operation, patch").eq("workspace_id", ws).eq("idempotency_key", `capture:${c.id}:requirement`).single();
    expect(cp).toMatchObject({ state: "proposed", target_type: "requirement", operation: "create" });
    expect(JSON.stringify(cp!.patch)).toContain("20000");
    expect(JSON.stringify(cp!.patch)).not.toContain("budget_max");           // 85 waits for its basis
    const { count } = await admin.from("requirement").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("org_id", org.id);
    expect(count).toBe(0);                                                    // nothing written without approval
  });

  // ------------------------------------------------------------------------------------------------ 18, 27, 29
  it("§17.18 / §17.29 / §17.27 conflicting values: new observation + approval-gated proposal, previous kept; rejection changes nothing", async () => {
    const sur = Cap(letters(7));
    const org = await ins("organisation", { display_name: `${Cap(letters(6))} Foods` });
    const p = await ins("person", { full_name: `Kiran ${sur}` });
    await ins("employment", { person_id: p.id, org_id: org.id, title: "CFO", is_current: true });
    const req = await ins("requirement", { org_id: org.id, title: "Pune office", status: "estimated", area_target_sf: 15000 });
    const c = await capture(`Spoke to Kiran ${sur}. They now need 20,000 sq ft.`, "conflict");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine!.conflicts).toEqual([expect.objectContaining({ field: "area_target", before: "15000", after: "20000 sf" })]);
    expect(engine!.receipt.lines.some((l) => l.kind === "changed" && /Previous value kept/.test(l.text))).toBe(true);
    const o = (await obsOf(c.id)).find((x) => x.field === "area_target")!;
    expect(o).toMatchObject({ subject_type: "requirement", subject_id: req.id, review_category: "conflicting_commercial_value", status: "pending_review" });
    const { data: prop } = await admin.from("change_proposal").select("id, state, approval_required").eq("id", o.proposal_id).single();
    expect(prop).toMatchObject({ state: "proposed", approval_required: true });
    expect((await admin.from("requirement").select("area_target_sf").eq("id", req.id).single()).data!.area_target_sf).toBe(15000);
    // reject → proposal rejected, record unchanged, history kept
    // an editor's rejection does not decide a material proposal (approver role needed) …
    expect(await rejectObservation(colleague, ws, USERS.colleague.id, o.id, "client said 15k still")).toMatchObject({ status: "rejected", proposal_rejected: false });
    // … the owner (approver) rejects the update
    const owner = await userClient("owner");
    await rejectObservation(owner, ws, USERS.owner.id, o.id, "client said 15k still");
    expect((await admin.from("change_proposal").select("state").eq("id", o.proposal_id).single()).data!.state).toBe("rejected");
    expect((await admin.from("requirement").select("area_target_sf").eq("id", req.id).single()).data!.area_target_sf).toBe(15000);
    const hist = await correctionsFor(colleague, ws, c.id);
    expect(hist.filter((h) => h.target === "status" && h.after?.status === "rejected" && h.note === "client said 15k still").length).toBe(2);
  });

  it("§7 quotation ₹85 → ₹95: second quotation is a new versioned observation, the first is preserved, review + event", async () => {
    const org = await ins("organisation", { display_name: `${Cap(letters(6))} Realty` });
    const req = await ins("requirement", { org_id: org.id, title: "Quote target", status: "estimated" });
    const q1 = await intakeDocument(ctx, { name: `quote-${t}-1.txt`, mime: "text/plain", bytes: enc(`Commercial quotation ${t}\nRent ₹85 per sq ft per month plus CAM. Valid till 31 December 2026.`) }, { links: { requirement_id: req.id } }, noAi);
    const q2 = await intakeDocument(ctx, { name: `quote-${t}-2.txt`, mime: "text/plain", bytes: enc(`Revised commercial quotation ${t}\nRent ₹95 per sq ft per month plus CAM.`) }, { links: { requirement_id: req.id } }, noAi);
    const o1 = (await observationsFor(colleague, ws, { documentId: q1.doc.id })).find((o) => o.field === "rent_psf")!;
    const o2 = (await observationsFor(colleague, ws, { documentId: q2.doc.id })).find((o) => o.field === "rent_psf")!;
    expect(o1).toMatchObject({ value_json: 85, version: 1, cam_treatment: "extra", conflict_with: null, raw_text: "₹85 per sq ft per month" });
    expect(o2).toMatchObject({ value_json: 95, version: 2, conflict_with: o1.id, review_category: "conflicting_commercial_value", source_type: "document" });
    expect(o2.source_ref).toMatchObject({ document_id: q2.doc.id, page: 1 });
    expect((await observationsFor(colleague, ws, { documentId: q1.doc.id })).find((o) => o.id === o1.id)!.value_json).toBe(85);
    const { data: ev } = await admin.from("event_outbox").select("event_type, payload").eq("workspace_id", ws).eq("dedupe_key", `input:conflict:${o2.id}`);
    expect(ev![0]).toMatchObject({ event_type: "commercial.offer_revised", payload: expect.objectContaining({ before: "85 INR/sf/month", after: "95 INR/sf/month" }) });
    const queue = await reviewQueue(colleague, ws);
    expect(queue.conflicting_commercial_value.some((x) => x.id === o2.id)).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------ 21, 22
  it("§17.21 duplicate file upload and §17.22 the same note re-sent is a repeat, not new evidence", async () => {
    const bytes = enc(`Minutes of meeting ${t}. Attendees: team. Rent ₹70 per sq ft per month.`);
    const a = await intakeDocument(ctx, { name: `dup-${t}.txt`, mime: "text/plain", bytes }, {}, noAi);
    const b = await intakeDocument(ctx, { name: `dup-${t}-copy.txt`, mime: "text/plain", bytes }, {}, noAi);
    expect(b).toMatchObject({ duplicate: true, doc: { id: a.doc.id } });
    const text = `Met Sunil ${Cap(letters(6))}. Landlord quoted ₹77 per sq ft per month for Tower C.`;
    const c1 = await capture(text, "rep1"); await processAndAnalyse(admin, ws, c1.id);
    const c2 = await capture(text, "rep2"); const { engine } = await processAndAnalyse(admin, ws, c2.id);
    const r2 = (await obsOf(c2.id)).find((o) => o.field === "rent_psf")!;
    const r1 = (await obsOf(c1.id)).find((o) => o.field === "rent_psf")!;
    expect(r2).toMatchObject({ independent: false, repeat_of: r1.id, review_category: "potential_duplicate" });
    expect(engine!.duplicate_of).toBe(c1.id);
    expect(engine!.receipt.lines[0]).toMatchObject({ kind: "duplicate" });
    // the same value from a DIFFERENT source corroborates instead
    const c3 = await capture(`Broker confirmed: landlord quoted ₹77 per sq ft per month.`, "rep3"); await processAndAnalyse(admin, ws, c3.id);
    expect((await obsOf(c3.id)).find((o) => o.field === "rent_psf")).toMatchObject({ independent: true, corroborates: r1.id });
  });

  // ------------------------------------------------------------------------------------------------ 4, 14, 15
  it("§17.4 / §17.15 business card: email matches an existing contact (high), uncertain fields flagged, no duplicate person proposed", async () => {
    const sur = Cap(letters(7)); const email = `meera.${letters(6)}@zenith${letters(4)}.in`;
    const p = await ins("person", { full_name: `Meera ${sur}` });
    await ins("contact_method", { person_id: p.id, method_type: "email", value: email, verify_status: "unverified" });
    const card = `Meera ${sur}\nHead of Workplace\nZenith ${sur} Labs Pvt. Ltd.\n${email}\n020 6700 1000\n7th Floor, Panchshil Tower, Kharadi, Pune 411014`;
    const r = await intakeDocument(ctx, { name: `card-${t}.jpg`, mime: "image/jpeg", bytes: enc(`jpeg-${t}-1`) }, { userType: "business_card" }, { ...noAi, ocr: async () => ({ text: card, mocked: true }) });
    expect(r.doc.result.person_match).toMatchObject({ tier: "high", person_id: p.id });
    expect(r.doc.result.person_proposal_id).toBeUndefined();
    expect(r.doc.result.card.address).toMatch(/411014/);
    expect(r.doc.result.uncertain_fields.map((u: any) => u.field)).toContain("phone 020 6700 1000");
    expect(r.doc.storage_path).toBeTruthy();                                   // original image kept
    // same name, no matching email/phone => only a suggestion (medium), never a new duplicate person
    const r2 = await intakeDocument(ctx, { name: `card-${t}-2.jpg`, mime: "image/jpeg", bytes: enc(`jpeg-${t}-2`) }, { userType: "business_card" },
      { ...noAi, ocr: async () => ({ text: `Meera ${sur}\nDirector\n+91 99999 ${String(10000 + Math.floor(Math.random() * 89999))}`, mocked: true }) });
    expect(r2.doc.result.person_match.tier).toBe("medium");
    expect(r2.doc.result.person_proposal_id).toBeUndefined();
    // a new person with no match => new contact suggested (proposal only)
    const r3 = await intakeDocument(ctx, { name: `card-${t}-3.jpg`, mime: "image/jpeg", bytes: enc(`jpeg-${t}-3`) }, { userType: "business_card" },
      { ...noAi, ocr: async () => ({ text: `Rohit ${Cap(letters(7))}\nManager\nrohit@${letters(6)}.com`, mocked: true }) });
    expect(r3.doc.result.person_match.tier).toBe("none");
    expect(r3.doc.result.person_proposal_id).toBeTruthy();
  });

  it("§17.14 duplicate company: an existing same-name company is offered, not created; ambiguous names stay low confidence (§17.17)", async () => {
    const core = Cap(letters(8));
    await ins("organisation", { display_name: `${core} Technologies` });
    const r = await intakeDocument(ctx, { name: `card-${t}-co.jpg`, mime: "image/jpeg", bytes: enc(`jpeg-${t}-co`) }, { userType: "business_card" },
      { ...noAi, ocr: async () => ({ text: `Asha ${Cap(letters(6))}\nVP Sales\n${core} Technologies Pvt Ltd\nasha@${letters(5)}.com`, mocked: true }) });
    expect(r.doc.result.company_matches?.length).toBe(1);
    expect(r.doc.result.organisation_proposal_id).toBeUndefined();
    const same = `Ravi ${Cap(letters(6))}`;
    await ins("person", { full_name: same }); await ins("person", { full_name: same });
    const c = await capture(`Met ${same}. Need 10,000 sq ft in Kharadi.`, "amb");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine!.matches.find((m) => m.kind === "person")).toMatchObject({ tier: "low", id: null });
    expect((await obsOf(c.id)).find((o) => o.field === "area_target")!.review_category).toBe("uncertain_contact_match");
    const q = await reviewQueue(colleague, ws);
    expect(q.uncertain_contact_match.some((x) => x.capture_id === c.id)).toBe(true);
  });

  it("§17.16 contact employer change: recorded as a contact update; nothing transferred to the new company", async () => {
    const sur = Cap(letters(7));
    const oldOrg = await ins("organisation", { display_name: `${Cap(letters(6))} Old` });
    const p = await ins("person", { full_name: `Raj ${sur}` });
    await ins("employment", { person_id: p.id, org_id: oldOrg.id, title: "CFO", is_current: true });
    await ins("opportunity", { org_id: oldOrg.id, title: `Old deal ${t}` }).catch(() => null);
    const c = await capture(`Raj ${sur} has joined Borealis ${sur} as CFO.`, "move");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine!.intents).toContain("contact_update");
    const { data: props } = await admin.from("change_proposal").select("target_type").eq("workspace_id", ws).eq("capture_id", c.id);
    expect((props ?? []).filter((x) => ["opportunity", "employment"].includes(x.target_type))).toEqual([]);   // person move goes through proposePersonMove, never automatic
    const { data: emp } = await admin.from("employment").select("org_id, is_current").eq("person_id", p.id);
    expect(emp).toEqual([{ org_id: oldOrg.id, is_current: true }]);
    expect(engine!.events).toContain("contact.info_added");
  });

  // ------------------------------------------------------------------------------------------------ 6, 7, 8, 9 + PPTX
  it("§17.8 / §17.6 PDF brochure: page references, carpet vs chargeable kept separate", async () => {
    const bytes = await pdf([[`Tower ${t} brochure`, "Grade A office, Kharadi"], ["Floor plate details", "Carpet area 12,000 sq ft", "Chargeable area 16,800 sq ft", "Rent Rs 92 per sq ft per month"]]);
    const r = await intakeDocument(ctx, { name: `brochure-${t}.pdf`, mime: "application/pdf", bytes }, {}, noAi);
    const obs = await observationsFor(colleague, ws, { documentId: r.doc.id });
    const carpet = obs.find((o) => o.field === "carpet_area")!, charge = obs.find((o) => o.field === "chargeable_area")!;
    expect(carpet).toMatchObject({ value_json: 12000, area_basis: "carpet", verification: "page_verified" });
    expect(charge).toMatchObject({ value_json: 16800, area_basis: "chargeable" });
    expect(carpet.source_ref.page).toBe(2);
    expect(obs.find((o) => o.field === "rent_psf")).toMatchObject({ cam_treatment: "unknown", missing: ["cam"] });
  });

  it("§17.9 / §17.7 Word lease quotation and PowerPoint: lease terms with page/slide refs; unknown stays unknown", async () => {
    const w = await intakeDocument(ctx, { name: `proposal-${t}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: await docx([`Commercial proposal ${t}`, "Rent Rs 92 per sq ft per month exclusive of CAM.", "CAM Rs 15 psf per month.", "Security deposit 6 months. Lock-in period of 36 months. Escalation 5% every 3 years."]) }, {}, noAi);
    const wo = await observationsFor(colleague, ws, { documentId: w.doc.id });
    expect(wo.find((o) => o.field === "rent_psf")).toMatchObject({ value_json: 92, cam_treatment: "extra", unit: "INR/sf/month" });
    expect(wo.find((o) => o.field === "lock_in")).toMatchObject({ value_json: 36, unit: "months", intent: "lease_information" });
    expect(wo.find((o) => o.field === "security_deposit")).toMatchObject({ value_json: 6, unit: "months_rent" });
    expect(wo.some((o) => o.field === "brokerage")).toBe(false);
    const s = await intakeDocument(ctx, { name: `deck-${t}.pptx`, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: await pptx([`Options deck ${t}`, "Tower A: chargeable area 25,000 sq ft, rent Rs 88 per sq ft per month plus CAM"]) }, {}, noAi);
    expect(s.doc.status).not.toBe("unsupported");
    const so = await observationsFor(colleague, ws, { documentId: s.doc.id });
    expect(so.find((o) => o.field === "chargeable_area")!.source_ref.page).toBe(2);
    expect(so.find((o) => o.field === "rent_psf")).toMatchObject({ value_json: 88, cam_treatment: "extra" });
  });

  // ------------------------------------------------------------------------------------------------ 5, 2, 3, 26
  it("§17.5 screenshot OCR: values read from an image are estimates (machine reading), never confirmed", async () => {
    const c = (await createCapture(colleague, ws, USERS.colleague.id, { kind: "image", text: "WhatsApp from broker", file: { name: "shot.png", type: "image/png", bytes: enc(`png-${t}`).buffer as ArrayBuffer } }, `${t}-shot`)).capture;
    const { engine } = await processAndAnalyse(admin, ws, c.id, { ocr: async () => ({ text: "Landlord: Rs 90 per sq ft per month, CAM extra. Available Jan.", mocked: true, model: "mock" }) });
    expect(engine!.intents).toContain("commercial_quotation");
    const o = (await obsOf(c.id)).find((x) => x.field === "rent_psf")!;
    expect(o).toMatchObject({ value_json: 90, cam_treatment: "extra", source_type: "image", fact_class: "estimate", verification: "unverified" });
    expect(c.storage_paths.length).toBe(1);
  });

  it("§17.2 Hindi voice note (mock transcription) → romanised extraction; original kept; §17.26 transcript correction history", async () => {
    const hi = "अनिल से बात हुई। खराडी में लगभग बीस हज़ार स्क्वेयर फीट चाहिए। शुक्रवार को ऑप्शन्स भेजना है।";
    const c = (await createCapture(colleague, ws, USERS.colleague.id, { kind: "audio", text: hi, languageHint: "hi", file: { name: "note.webm", type: "audio/webm", bytes: enc(`webm-${t}`).buffer as ArrayBuffer } }, `${t}-hi`)).capture;
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    const { data: row } = await admin.from("capture").select("transcript, raw_text, extraction, storage_paths").eq("id", c.id).single();
    expect(row!.transcript).toMatch(/^Anil se baat hui/);
    expect(row!.extraction.meta.original_transcript).toBe(hi);
    expect(row!.extraction.meta.language).toBe("hi");
    expect(row!.storage_paths.length).toBe(1);                                  // audio kept
    expect(engine!.source_type).toBe("voice_note");
    const area = (await obsOf(c.id)).find((o) => o.field === "area_target_sf" || o.field === "area_target")!;
    expect(area).toMatchObject({ value_json: 20000, fact_class: "estimate" });
    // the user corrects the transcript: history kept, re-extracted
    const fixed = "Anil se baat hui. Kharadi mein lagbhag pachchis hazaar sq ft chahiye. Friday ko options bhejna hai.";
    await correctTranscript(colleague, ws, USERS.colleague.id, c.id, fixed);
    await submitReview(colleague, admin, ws, USERS.colleague.id, c.id, { text: fixed });
    await runInputEngine(admin, ws, c.id);
    const h = await correctionsFor(colleague, ws, c.id);
    expect(h.find((x) => x.target === "transcript")).toMatchObject({ after: { text: fixed } });
    expect((await obsOf(c.id)).some((o) => o.value_json === 25000)).toBe(true);
  });

  it("§17.3 Hinglish voice note", async () => {
    const hg = "Anil se baat hui, Kharadi mein 20,000 sq ft chahiye, Friday ko options bhejna hai";
    const c = (await createCapture(colleague, ws, USERS.colleague.id, { kind: "audio", text: hg, file: { name: "n2.webm", type: "audio/webm", bytes: enc(`webm2-${t}`).buffer as ArrayBuffer } }, `${t}-hg`)).capture;
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    const { data: row } = await admin.from("capture").select("extraction").eq("id", c.id).single();
    expect(row!.extraction.meta.language).toBe("hinglish");
    expect(engine!.intents).toEqual(expect.arrayContaining(["new_property_requirement", "follow_up_task", "meeting_note"]));
    const { data: task } = await admin.from("task").select("title").eq("idempotency_key", `capture:${c.id}:task:0`).single();
    expect(task!.title).toMatch(/^Send options/);
  });

  it("§2.6 permitted recording: consent required; timestamps kept; sent to Module 7 (meeting note + event)", async () => {
    await expect(intakeRecording(ctx, { name: "r.m4a", mime: "audio/mp4", bytes: enc(`m4a-${t}-0`) }, { consent: false })).rejects.toThrow(/agreed/);
    const org = await ins("organisation", { display_name: `${Cap(letters(6))} Meet` });
    void org;
    const visit = await ins("meeting_visit", { title: `Visit ${t}`, start_at: "2026-11-20T05:00:00Z", end_at: "2026-11-20T06:00:00Z" });
    const prep = await ins("meeting_prep", { meeting_visit_id: visit.id });
    const deps: DocDeps = { processCaptures: false, transcribe: async () => ({ text: "x", model: "mock", mocked: true, segments: [
      { start: 0, end: 8, text: "We need about 18,000 sq ft carpet.", speaker: null, speaker_certain: false },
      { start: 65, end: 72, text: "Rent above 90 per sq ft is too expensive.", speaker: null, speaker_certain: false }] }) };
    const r = await intakeRecording(ctx, { name: `rec-${t}.m4a`, mime: "audio/mp4", bytes: enc(`m4a-${t}-1`) }, { consent: true, consentReference: "verbal consent at start", meetingPrepId: prep.id }, deps);
    expect(r.doc.result.meeting_note_id).toBeTruthy();
    expect(r.doc.detection.consent_reference).toBe("verbal consent at start");
    const { data: tr } = await admin.from("capture_transcript").select("has_timestamps, diarised").eq("id", r.doc.result.transcript_id).single();
    expect(tr).toMatchObject({ has_timestamps: true, diarised: false });
    const { data: ev } = await admin.from("event_outbox").select("event_type").eq("workspace_id", ws).eq("dedupe_key", `capture_doc:${r.doc.id}:meeting_notes`);
    expect(ev![0].event_type).toBe("meeting.notes_uploaded");
  });

  // ------------------------------------------------------------------------------------------------ 25
  it("§17.25 temporary AI failure: raw note preserved, failure visible in the receipt, retry succeeds", async () => {
    const c = await capture(`Spoke to Neha ${Cap(letters(6))}. They need 8,000 sq ft.`, "fail");
    const failing: Extractor = async () => { throw new AiUnavailableError("provider_error"); };
    const { engine } = await processAndAnalyse(admin, ws, c.id, { extractor: failing });
    const { data: row } = await admin.from("capture").select("status, raw_text, error").eq("id", c.id).single();
    expect(row).toMatchObject({ status: "failed", raw_text: expect.stringMatching(/8,000 sq ft/) });
    expect(engine!.receipt.lines.map((l) => l.kind)).toEqual(expect.arrayContaining(["saved", "failed"]));
    const { engine: e2 } = await processAndAnalyse(admin, ws, c.id, { reextract: true });
    expect(e2!.receipt.lines.some((l) => l.kind === "failed")).toBe(false);
    expect((await obsOf(c.id)).some((o) => o.field === "area_target" || o.field === "area")).toBe(true);
  });

  // ------------------------------------------------------------------------------------------------ 26, 9 permissions
  it("§17.26 user correction keeps the original extraction; confirm / associate / clarify; permissions limit automation", async () => {
    const c = await capture(`Met Pooja ${Cap(letters(6))}. Around 9,000 sq ft needed. I think they might relocate.`, "corr");
    await processAndAnalyse(admin, ws, c.id);
    const area = (await obsOf(c.id)).find((o) => o.field === "area_target")!;
    const fixed = await correctObservation(colleague, ws, USERS.colleague.id, area.id, { value: 9500, area_basis: "carpet", note: "it was 9,500 carpet" });
    expect(fixed).toMatchObject({ value_json: 9500, area_basis: "carpet", raw_text: area.raw_text, status: "corrected", verification: "user_confirmed" });
    const h = await correctionsFor(colleague, ws, c.id);
    expect(h[0]).toMatchObject({ target: "value", before: { value_json: 9000, area_basis: "unknown" }, after: { value_json: 9500, area_basis: "carpet" } });
    // re-processing keeps the correction
    await runInputEngine(admin, ws, c.id);
    expect((await obsOf(c.id)).find((o) => o.id === area.id)).toMatchObject({ value_json: 9500, status: "corrected" });
    const hyp = (await obsOf(c.id)).find((o) => o.fact_class === "hypothesis")!;
    expect(hyp.verification).toBe("unverified");
    const org = await ins("organisation", { display_name: `${Cap(letters(6))} Assoc` });
    expect(await associateObservation(colleague, ws, USERS.colleague.id, area.id, { type: "organisation", id: org.id })).toMatchObject({ subject_id: org.id, match_confidence: "high" });
    const task = await requestClarification(colleague, ws, USERS.colleague.id, hyp.id, "Are they really relocating?");
    expect(task.title).toMatch(/^Clarify:/);
    await expect(confirmObservation(colleague, ws, USERS.colleague.id, hyp.id)).resolves.toMatchObject({ status: "confirmed" });
    // permissions: an admin turns task automation off => tasks wait for confirmation
    const owner = await userClient("owner");
    await savePermissions(owner, ws, { auto_create_tasks: false });
    expect((await loadPermissions(colleague, ws)).auto_create_tasks).toBe(false);
    await expect(savePermissions(colleague, ws, { auto_create_tasks: true })).rejects.toThrow();
    const c2 = await capture(`Spoke to Arun ${Cap(letters(6))}. Send floor plans Monday.`, "perm");
    const { engine } = await processAndAnalyse(admin, ws, c2.id);
    expect(engine!.receipt.lines.find((l) => l.kind === "scheduled")!.text).toMatch(/awaiting confirmation/);
    const { count } = await admin.from("task").select("id", { count: "exact", head: true }).eq("idempotency_key", `capture:${c2.id}:task:0`);
    expect(count).toBe(0);
    await savePermissions(owner, ws, { auto_create_tasks: true });
  });

  // ------------------------------------------------------------------------------------------------ 30 / 12, history
  it("§17.30 integration: history, assistant search_captures, signals for business observations", async () => {
    const sur = Cap(letters(7));
    const org = await ins("organisation", { display_name: `${sur} Analytics` });
    const p = await ins("person", { full_name: `Vikram ${sur}` });
    await ins("employment", { person_id: p.id, org_id: org.id, title: "COO", is_current: true });
    const c = await capture(`Met Vikram ${sur}. ${sur} Analytics is hiring 400 engineers and expanding to a new office in Pune next year.`, "sig");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    expect(engine!.intents).toContain("business_signal");
    expect((await obsOf(c.id)).find((o) => o.field === "signal")).toMatchObject({ fact_class: "hypothesis" });
    const hist = await captureHistory(colleague, ws);
    expect(hist.find((h) => h.id === c.id)).toMatchObject({ type: "Note", status: "needs_review", records: expect.any(Number) });
    const s = await searchCaptures(colleague, ws, "hiring engineers");
    expect(s.captures.map((x) => x.id)).toContain(c.id);
    const tool = getTool("search_captures")!;
    expect(tool.category).toBe("A");
  });

  // ------------------------------------------------------------------------------------------------ remaining PARTIALs (Nov 2026)
  it("buildings in notes are suggestions only; same-name companies tie-broken by HQ city / parent; outliers flagged; legacy .doc note; entity provenance", async () => {
    const camp = Cap(letters(7));
    const park = await ins("asset", { name: `${camp} Business Bay`, asset_kind: "campus", locality_id: f.kharadi.id });
    const tower = await ins("asset", { name: "Tower B", asset_kind: "tower", parent_asset_id: park.id, locality_id: f.kharadi.id });
    const co = `${Cap(letters(8))} Systems`;
    const pune = await ins("organisation", { display_name: co, hq_city: "Pune" });
    await ins("organisation", { display_name: co, hq_city: "Chennai" });
    const c = await capture(`${co} Pune team likes ${camp} Kharadi, especially ${camp} Business Bay Tower B. Quoted rent ₹950 per sq ft per month, CAM extra.`, "bld");
    const { engine } = await processAndAnalyse(admin, ws, c.id);
    const b = engine!.buildings ?? [];
    expect(b.find((x) => x.asset_id === tower.id)).toMatchObject({ tier: "high" });
    expect(b.find((x) => x.asset_id === park.id)).toBeTruthy();
    expect(engine!.receipt.lines.some((l) => /suggestion only, not linked/.test(l.text))).toBe(true);
    const org = engine!.matches.find((m) => m.kind === "organisation");
    expect(org).toMatchObject({ tier: "medium", id: pune.id });
    expect(org!.reason).toMatch(/Pune/);
    const obs = await obsOf(c.id);
    expect(obs.some((o) => (o.links ?? []).some((l: any) => l.id === park.id || l.id === tower.id))).toBe(false);   // never linked automatically
    const rent = obs.find((o) => o.field === "rent_psf")!;
    expect(rent.value_json).toBe(950);
    expect(rent.source_ref.questionable).toMatch(/15–400/);
    expect(engine!.receipt.lines.some((l) => /Questionable value/.test(l.text))).toBe(true);

    const ole = new Uint8Array(4096); ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const leg = await intakeDocument(ctx, { name: `old-${t}.doc`, mime: "application/msword", bytes: ole }, {}, noAi);
    expect(leg.doc.result.format_note).toMatch(/^Old format — save as \.docx\/\.pptx\/\.xlsx for full extraction/);
    expect(leg.doc.storage_path).toBeTruthy();

    const { provenanceLinks } = await import("@/modules/imports/trace");
    const pl = await provenanceLinks(colleague, ws, pune.id);
    expect(pl.importRows).toBe(0);
    await associateObservation(colleague, ws, USERS.colleague.id, rent.id, { type: "organisation", id: pune.id });
    const pl2 = await provenanceLinks(colleague, ws, pune.id);
    expect(pl2.capture.count).toBeGreaterThan(0);
    expect(pl2.capture.href).toBe(`/capture/${c.id}`);
  });
  // ------------------------------------------------------------------------------------------------ round-3 regressions
  it("business card: card fields are written as extracted information (fact class + uncertain flags), not only proposals", async () => {
    const sur = Cap(letters(7));
    const card = `Kavya ${sur}\nLeasing Manager\nOrbit ${sur} Realty LLP\nkavya@orbit${sur.toLowerCase()}.in\n+91 98220 45678\nwww.orbitspaces.in`;
    const r = await intakeDocument(ctx, { name: `card-${t}-obs.jpg`, mime: "image/jpeg", bytes: enc(`jpeg-${t}-obs`) }, { userType: "business_card" }, { ...noAi, ocr: async () => ({ text: card, mocked: true }) });
    const obs = await observationsFor(colleague, ws, { documentId: r.doc.id });
    const fields = obs.map((o: any) => o.field);
    for (const f of ["contact_name", "contact_title", "company_name", "contact_email", "contact_phone", "company_website"]) expect(fields).toContain(f);
    expect(obs.find((o: any) => o.field === "contact_name")!.value_json).toBe(`Kavya ${sur}`);
    for (const o of obs as any[]) { expect(o.fact_class).toBeTruthy(); expect(typeof o.source_ref.uncertain).toBe("boolean"); }
    expect(obs.find((o: any) => o.field === "contact_email")!.source_ref.uncertain).toBe(true);   // domain differs from the website
  });

  it("Devanagari note in a workspace where the member's access excludes corporate-confidential saves (no RLS failure)", async () => {
    const t2 = tag("ie-ws");
    const { data: w } = await admin.from("workspace").insert({ name: `Plain ${t2}`, slug: t2 }).select().single();
    try {
      await admin.from("membership").insert({ workspace_id: w!.id, user_id: USERS.colleague.id, role: "editor" });   // default access: public + permitted_personal
      const { capture: c } = await createCapture(colleague, w!.id, USERS.colleague.id, { kind: "text", text: "अनिल से बात हुई। उनको खराडी में 20000 स्क्वेयर फीट चाहिए।" }, `${t2}-hi`);
      expect((c as any).classification).toBe("permitted_personal");
      const { processed } = await processAndAnalyse(admin, w!.id, c.id);
      expect((processed as any).status).not.toBe("failed");
      const o = await observationsFor(colleague, w!.id, { captureId: c.id });
      const loc = o.find((x: any) => x.field === "preferred_location");
      expect(loc?.value_json).toBe("Kharadi");
    } finally { await admin.from("workspace").delete().eq("id", w!.id); }
  });
});

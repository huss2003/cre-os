/**
 * Capture drop zone against the real local Supabase (AI gateway in mock mode).
 * colleague = editor who uploads; owner = admin (failed-jobs queue + retry).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { userClient, adminClient, USERS, WS1, tag } from "../../../../tests/helpers";
import { intakeDocument, processDocument, updateAndReprocess, NO_TRANSCRIPTION, type DocCtx, type DocDeps } from "./service";
import { attentionQueues, listFailedJobs, requestMoreInfo, retryJob } from "./review";

type Db = Awaited<ReturnType<typeof userClient>>;
let colleague: Db, owner: Db, admin: Db;
let ctx: DocCtx;
const noAi: DocDeps = { processCaptures: false, transcribe: async () => null };
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  colleague = await userClient("colleague");
  owner = await userClient("owner");
  admin = adminClient();
  ctx = { db: colleague, workspaceId: WS1, userId: USERS.colleague.id, role: "editor" };
});

describe("capture drop zone", () => {
  it("routes a business card to proposals only (nothing applied) and is idempotent on file hash", async () => {
    const t = tag("card");
    const own = { workspace_id: WS1, owner_user_id: USERS.colleague.id };
    const { data: person } = await admin.from("person").insert({ ...own, full_name: `Raj ${t}` }).select().single();
    const cardText = `Raj Mehta\nDirector\nZeta${t} Realty Pvt. Ltd.\nT: +91 20 6700 1000\nM: +91 98220 ${String(Math.floor(Math.random() * 90000) + 10000)}\nraj.${t}@zeta.in`;
    const deps: DocDeps = { ...noAi, ocr: async () => ({ text: cardText, mocked: true }) };
    const file = { name: `card-${t}.jpg`, mime: "image/jpeg", bytes: enc(`fake-jpeg-${t}`) };
    const r1 = await intakeDocument(ctx, file, { links: { person_id: person!.id } }, deps);
    expect(r1.duplicate).toBe(false);
    expect(r1.doc.detected_type).toBe("business_card");
    expect(r1.doc.status).toBe("needs_review");
    const ids: string[] = r1.doc.result.proposal_ids;
    expect(ids.length).toBeGreaterThanOrEqual(3); // email + 2 phones (+ org)
    const { data: props } = await admin.from("change_proposal").select("state, target_type, patch").in("id", ids);
    expect(props!.every((p) => p.state === "proposed")).toBe(true);
    const phone = props!.find((p) => p.target_type === "contact_method" && JSON.stringify(p.patch).includes("switchboard"));
    expect(phone).toBeTruthy();
    // no proposal applied without approval: nothing written to contact_method
    const { count } = await admin.from("contact_method").select("id", { count: "exact", head: true }).eq("person_id", person!.id);
    expect(count).toBe(0);
    // same bytes again => same document, no new proposals
    const r2 = await intakeDocument(ctx, file, { links: { person_id: person!.id } }, deps);
    expect(r2.duplicate).toBe(true);
    expect(r2.doc.id).toBe(r1.doc.id);
    // re-processing reuses idempotency keys
    const again = await processDocument(ctx, r1.doc.id, { bytes: file.bytes }, deps);
    expect([...again.result.proposal_ids].sort()).toEqual([...ids].sort());
    const { count: n } = await admin.from("change_proposal").select("id", { count: "exact", head: true }).like("idempotency_key", `capture_doc:${r1.doc.id}:%`);
    expect(n).toBe(ids.length);
  });

  it("routes a lease to a page-referenced lease proposal and a quotation waits for its requirement", async () => {
    const t = tag("lease");
    const lease = `Leave and Licence Agreement ${t}\nThe Licensor grants the Licensee the premises. The chargeable area is 12,000 sq ft (carpet area).\nThe lock-in period is 36 months. Security deposit of 6 months. Escalation of 5% every 12 months.`;
    const r = await intakeDocument(ctx, { name: `lease-${t}.txt`, mime: "text/plain", bytes: enc(lease) }, {}, noAi);
    expect(["lease", "loi"]).toContain(r.doc.detected_type);
    const terms = r.doc.result.lease_terms as { field: string; page: number | null; verified: boolean }[];
    expect(terms.some((x) => x.verified && x.page === 1)).toBe(true);
    const { data: p } = await admin.from("change_proposal").select("state, target_type, reason").eq("id", r.doc.result.proposal_ids[0]).single();
    expect(p).toMatchObject({ state: "proposed", target_type: "lease" });
    expect(p!.reason).toMatch(/p\.1/);
    const quote = `Commercial proposal ${t}\nRate per seat Rs 9,500 per month. Validity of this offer: 30 days. Fit-out cost extra. Lock-in 12 months.`;
    const q = await intakeDocument(ctx, { name: `quote-${t}.txt`, mime: "text/plain", bytes: enc(quote) }, {}, noAi);
    expect(q.doc.detected_type).toBe("quotation");
    expect(q.doc.status).toBe("needs_input");
    expect(q.doc.error).toMatch(/requirement/);
  });

  it("recording without an API key keeps the audio and says so; typed notes continue", async () => {
    const t = tag("rec");
    const r = await intakeDocument(ctx, { name: `visit-${t}.m4a`, mime: "audio/mp4", bytes: enc(`audio-${t}`) }, { languageHint: "hinglish" }, noAi);
    expect(r.doc.detected_type).toBe("audio");
    expect(r.doc.status).toBe("needs_input");
    expect(r.doc.error).toBe(NO_TRANSCRIPTION);
    expect(r.doc.storage_path).toBeTruthy();
    const after = await updateAndReprocess(ctx, r.doc.id, { typedText: `Spoke to Raj ${t}; send options Friday` }, noAi);
    expect(after.status).toBe("needs_review");
    expect(after.result.capture_id).toBeTruthy();
    const { data: tr } = await admin.from("capture_transcript").select("has_timestamps, diarised, model").eq("capture_document_id", r.doc.id).single();
    expect(tr).toMatchObject({ has_timestamps: false, diarised: false, model: "manual" });
  });

  it("transcript segments with timestamps feed the capture with [mm:ss] references; speakers stay uncertain", async () => {
    const t = tag("ts");
    const deps: DocDeps = { processCaptures: false, transcribe: async () => ({ text: "a b", model: "test", mocked: true,
      segments: [{ start: 3, end: 6, text: `Raj ${t} ne bola 20k chahiye`, speaker: "A", speaker_certain: true }, { start: 65, end: 70, text: "Friday ko options bhejna hai", speaker: null, speaker_certain: false }] }) };
    const r = await intakeDocument(ctx, { name: `rec-${t}.webm`, mime: "audio/webm", bytes: enc(`webm-${t}`) }, {}, deps);
    const { data: tr } = await admin.from("capture_transcript").select("segments, has_timestamps").eq("capture_document_id", r.doc.id).single();
    expect(tr!.has_timestamps).toBe(true);
    expect((tr!.segments as { speaker_certain: boolean; speaker: string | null }[]).every((s) => !s.speaker_certain && s.speaker === null)).toBe(true);
    const { data: cap } = await admin.from("capture").select("raw_text").eq("id", r.doc.result.capture_id).single();
    expect(cap!.raw_text).toContain("[00:03]");
    expect(cap!.raw_text).toContain("[01:05]");
  });
});

describe("review queues", () => {
  it("lists failed jobs for admins only and retries through retry_job", async () => {
    const { data: job } = await admin.from("job").insert({ workspace_id: WS1, job_type: "capture.document", payload: { documentId: crypto.randomUUID() }, state: "dead",
      attempts: 5, max_attempts: 5, last_error: "boom", dedupe_key: tag("dead") }).select().single();
    const ownerQ = await attentionQueues(owner, WS1, "owner");
    expect(ownerQ.failedJobs!.some((j) => j.id === job!.id)).toBe(true);
    expect((await listFailedJobs(owner, WS1)).some((j) => j.id === job!.id)).toBe(true);
    const colQ = await attentionQueues(colleague, WS1, "editor");
    expect(colQ.failedJobs).toBeNull();
    await expect(retryJob(colleague, WS1, "editor", job!.id)).rejects.toThrow(/admin/);
    await retryJob(owner, WS1, "owner", job!.id);
    const { data: after } = await admin.from("job").select("state").eq("id", job!.id).single();
    expect(after!.state).toBe("queued");
    await admin.from("job").update({ state: "cancelled" }).eq("id", job!.id);
  });

  it("Request more info moves a proposal to clarify and creates one linked task", async () => {
    const t = tag("info");
    const { data: org } = await admin.from("organisation").insert({ workspace_id: WS1, owner_user_id: USERS.colleague.id, display_name: `Info ${t}` }).select().single();
    const { proposeChange } = await import("@/lib/services/changes");
    const cp = await proposeChange(colleague, WS1, { targetType: "organisation", targetId: org!.id, patch: [{ op: "replace", path: "/legal_name", value: `Info ${t} Pvt Ltd` }], reason: "test", ownerUserId: USERS.colleague.id });
    const r1 = await requestMoreInfo(owner, WS1, USERS.owner.id, cp.id, "Need the CIN to confirm the legal name");
    const r2 = await requestMoreInfo(owner, WS1, USERS.owner.id, cp.id, "Need the CIN to confirm the legal name");
    expect(r2.taskId).toBe(r1.taskId);
    const { data: p } = await admin.from("change_proposal").select("state").eq("id", cp.id).single();
    expect(p!.state).toBe("clarify");
    const { data: task } = await admin.from("task").select("linked_entity_type, linked_entity_id").eq("id", r1.taskId).single();
    expect(task).toMatchObject({ linked_entity_type: "change_proposal", linked_entity_id: cp.id });
    const q = await attentionQueues(owner, WS1, "owner");
    expect(q.needsInfo.some((x) => x.id === cp.id)).toBe(true);
  });
});

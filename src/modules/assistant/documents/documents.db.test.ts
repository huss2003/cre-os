// Documents (round 2): lease-term extraction tool on a real attachment row, save_lease_terms plan() diff + proposeChange,
// doc_chunk indexing (content_hash dedupe) and hybrid retrieval with a fake embedding provider. Local Supabase, RLS as owner (WS1).
import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { userClient, adminClient, WS1, WS2, USERS, tag } from "../../../../tests/helpers";
import type { ToolContext, ToolResult } from "../types";
import { documents2Tools } from "../tools/documents2";
import { semanticSearch } from "../tools/documents";
import { indexWorkspace } from "./embed";
import { hybridChunkSearch, type EmbeddingProvider } from "./retrieval";

type Row = Record<string, any>;
const T = tag("docs");
let t: ToolContext;
const tool = (id: string) => documents2Tools.find((x) => x.id === id)!;
const run = (id: string, input: unknown): Promise<ToolResult> => tool(id).run(tool(id).input.parse(input) as never, t);

/** Deterministic bag-of-words "embedding" (1024 dims) — no network. */
const fake: EmbeddingProvider = {
  name: "fake",
  async embed(texts) {
    return texts.map((s) => {
      const v = new Array(1024).fill(0);
      for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) v[parseInt(createHash("md5").update(w).digest("hex").slice(0, 6), 16) % 1024] += 1;
      const n = Math.hypot(...v) || 1; return v.map((x) => x / n);
    });
  },
};

const PAGES = [
  `LEAVE AND LICENSE AGREEMENT ${T}. This agreement is made between Acme Realty Pvt Ltd (Lessor) and Globex India Pvt Ltd (Lessee).`,
  "The chargeable area of the premises is 12,500 sq. ft. The monthly rent shall be Rs. 85 per sq ft per month. Parking: 10 car parking slots are included.",
  "The lock-in period is 36 months. The term of the lease is five (5) years. The commencement date is 1st April 2025. The lease shall expire on 31/03/2030.",
];
let attId = ""; let leaseId = ""; let extractionId = "";

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.VOYAGE_API_KEY;
  const db = await userClient("owner");
  t = { ctx: { db: db as never, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] }, runId: randomUUID(), conversationId: null, focus: null };
  const { data: a, error } = await db.from("assistant_attachment").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, file_name: `${T}.pdf`, mime: "application/pdf", size_bytes: 1, extracted_text: PAGES.join("\n\f\n"), pages: 3, page_texts: PAGES }).select("id").single();
  if (error) throw error;
  attId = a!.id;
  const { data: l, error: e2 } = await adminClient().from("lease").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, tenant_name_raw: `Globex ${T}`, area_sf: 12000, lockin_months_raw: 36 }).select("id").single();
  if (e2) throw e2;
  leaseId = l!.id;
});

describe("extract_lease_terms (mock mode)", () => {
  it("returns page-verified terms, unknowns, and a table block; stores the extraction", async () => {
    const r = await run("extract_lease_terms", { attachmentId: attId, docKind: "lease" });
    expect(r.ok).toBe(true);
    const d = r.data as Row;
    extractionId = d.extractionId;
    const by = Object.fromEntries((d.terms as Row[]).map((x) => [x.field, x]));
    expect(by.area).toMatchObject({ page: 2 });
    expect(by.start_date.value).toBe("2025-04-01");
    expect(by.parking.value).toBe("10");
    for (const x of d.terms as Row[]) expect(PAGES[x.page - 1]).toContain(x.snippet);
    expect(d.unknown).toContain("cam");
    expect(r.blocks?.[0]).toMatchObject({ kind: "table" });
    const { data: saved } = await adminClient().from("assistant_lease_extraction").select("attachment_id, workspace_id").eq("id", extractionId).single();
    expect(saved).toMatchObject({ attachment_id: attId, workspace_id: WS1 });
  });
  it("a WS2 attachment is not visible → not_found_or_no_access", async () => {
    const { data: a } = await adminClient().from("assistant_attachment").insert({ workspace_id: WS2, owner_user_id: USERS.other.id, file_name: `${T}-ws2.txt`, extracted_text: PAGES.join(" ") }).select("id").single();
    const r = await run("extract_lease_terms", { attachmentId: a!.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_found_or_no_access");
  });
});

describe("save_lease_terms", () => {
  it("plan() shows the diff against the lease record without writing", async () => {
    const p = await tool("save_lease_terms").plan!({ extractionId, leaseId } as never, t);
    const fields = p.diff.map((x) => x.field.split(" (page")[0]);
    expect(fields).toContain("Area (sq ft)");
    expect(fields).not.toContain("Lock-in (months)");             // unchanged (36 = 36)
    expect(p.diff.find((x) => x.field.startsWith("Area (sq ft)"))).toMatchObject({ after: "12500" });
    expect(Number(p.diff.find((x) => x.field.startsWith("Area (sq ft)"))!.before)).toBe(12000);
    expect(p.explanation).toContain("Parking");                    // no lease column → listed, not written
    const { data: l } = await adminClient().from("lease").select("area_sf, row_version").eq("id", leaseId).single();
    expect(Number(l!.area_sf)).toBe(12000);
  });
  it("run() files a change proposal (never a direct write)", async () => {
    const r = await run("save_lease_terms", { extractionId, leaseId });
    expect(r.ok).toBe(true);
    const { data: cps } = await adminClient().from("change_proposal").select("target_type, patch, state").eq("workspace_id", WS1).eq("target_id", leaseId);
    expect(cps?.length).toBe(1);
    expect(JSON.stringify(cps![0].patch)).toContain("/area_sf");
    const { data: l } = await adminClient().from("lease").select("area_sf").eq("id", leaseId).single();
    if (cps![0].state !== "applied") expect(Number(l!.area_sf)).toBe(12000);
  });
  it("plan() on an invisible lease is refused", async () => {
    await expect(tool("save_lease_terms").plan!({ extractionId, leaseId: randomUUID() } as never, t)).rejects.toThrow("not_found_or_no_access");
  });
});

describe("doc_chunk indexing + hybrid retrieval", () => {
  it("indexes page-aware chunks; re-running writes nothing (content_hash dedupe)", async () => {
    const admin = adminClient();
    const s1 = await indexWorkspace(admin, WS1, { types: ["attachment"], sourceIds: [attId], provider: null });
    expect(s1.chunksWritten).toBe(3);
    expect(s1.skippedNoProvider).toBe(true);
    const s2 = await indexWorkspace(admin, WS1, { types: ["attachment"], sourceIds: [attId], provider: null });
    expect(s2.chunksWritten).toBe(0);
    const { data: ch } = await admin.from("doc_chunk").select("page, embedding, owner_user_id").eq("source_id", attId).order("chunk_index");
    expect(ch!.map((c: Row) => c.page)).toEqual([1, 2, 3]);
    expect(ch!.every((c: Row) => c.embedding === null && c.owner_user_id === USERS.owner.id)).toBe(true);
  });
  it("without a key: full-text only (semanticSearch → null, chunk FTS works)", async () => {
    expect(await semanticSearch(t, "lock-in", 5)).toBeNull();
    const r = await hybridChunkSearch(t.ctx.db, WS1, `"${T}"`, 5, null);
    expect(r.mode).toBe("fts");
    expect(r.hits[0]).toMatchObject({ source_id: attId, page: 1, via: ["fts"] });
  });
  it("with a provider: embeds, then vector ∪ FTS fused by RRF (RLS + workspace filter)", async () => {
    const st = await indexWorkspace(adminClient(), WS1, { types: ["attachment"], sourceIds: [attId], provider: fake });
    expect(st.embedded).toBe(3);
    const r = await hybridChunkSearch(t.ctx.db, WS1, "monthly rent per sq ft chargeable area", 5, fake);
    expect(r.mode).toBe("hybrid");
    const top = r.hits.find((h) => h.source_id === attId)!;
    expect(top.page).toBe(2);
    expect(top.via).toContain("vector");
    const other = await userClient("other");
    const r2 = await hybridChunkSearch(other, WS1, "monthly rent", 5, fake);
    expect(r2.hits.some((h) => h.source_id === attId)).toBe(false);
  });
});

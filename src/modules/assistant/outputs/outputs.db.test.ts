// Outputs DB tests (local Supabase, RLS as seeded users): export -> storage + document_version + hash-checked download,
// show_on_map from ids with missing coords, style profile build is owner-only and turn-off clears it.
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { userClient, adminClient, WS1, USERS, tag } from "../../../../tests/helpers";
import type { ToolContext } from "../types";
import { downloadExport, exportMessage, latestExportableMessage } from "./export";
import { getStyleProfile, rebuildStyleProfile, setStyleEnabled, styleHintFor } from "./style";
import { outputsTools } from "../tools/outputs";

const T = tag("outp");
let t: ToolContext; let db: any;
const run = (id: string, input: unknown) => { const tool = outputsTools.find((x) => x.id === id)!; return tool.run(tool.input.parse(input) as never, t); };

beforeAll(async () => {
  db = await userClient("owner");
  t = { ctx: { db, userId: USERS.owner.id, email: USERS.owner.email, workspaceId: WS1, workspaceName: "WS1", timezone: "Asia/Kolkata", role: "owner", allowedClassifications: ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"], isPlatformAdmin: false, workspaces: [] } as never, runId: randomUUID(), conversationId: null, focus: null };
});

describe("export", () => {
  it("builds, stores, registers and downloads each format", async () => {
    const conv = (await db.from("assistant_conversation").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, title: `Export ${T}` }).select("id").single()).data;
    const blocks = [{ kind: "table", title: "Options", columns: ["A", "B"], rows: [["x", null]] }, { kind: "missing", items: ["B unknown"] }];
    const msg = (await db.from("assistant_message").insert({ workspace_id: WS1, owner_user_id: USERS.owner.id, conversation_id: conv.id, seq: 2, role: "assistant", content: "Summary", blocks }).select("id").single());
    expect(msg.error).toBeNull();
    expect(await latestExportableMessage(t.ctx, conv.id)).toBe(msg.data.id);
    for (const format of ["pptx", "docx", "pdf"] as const) {
      const r = await exportMessage(t.ctx, { messageId: msg.data.id, format });
      expect(r.fileName).toMatch(new RegExp(`^export-${T}-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
      const dv = (await db.from("document_version").select("purpose, kind, linked_entity_id, sha256").eq("id", r.documentId).single()).data;
      expect(dv).toMatchObject({ purpose: "assistant_export", kind: format, linked_entity_id: conv.id });
      const f = await downloadExport(t.ctx, r.documentId);
      expect(f.buffer.length).toBe(r.bytes);
    }
    t.conversationId = conv.id;
    const tool = await run("export_deliverable", { format: "pdf" });
    expect(tool.ok).toBe(true);
    expect(tool.blocks?.[0]).toMatchObject({ kind: "download" });
    t.conversationId = null;
    // another user cannot export someone else's message by id
    const other = await userClient("other");
    await expect(exportMessage({ db: other, workspaceId: WS1, userId: USERS.other.id }, { messageId: msg.data.id, format: "pdf" })).rejects.toThrow(/not found/i);
  });
});

describe("show_on_map", () => {
  it("maps assets with coordinates and lists those without", async () => {
    const a = (await db.from("asset").insert({ workspace_id: WS1, name: `Map A ${T}`, lat: 18.55, lon: 73.94 }).select("id").single());
    expect(a.error).toBeNull();
    const b = (await db.from("asset").insert({ workspace_id: WS1, name: `Map B ${T}` }).select("id").single()).data;
    const r = await run("show_on_map", { items: [{ type: "asset", id: a.data.id }, { type: "asset", id: b.id }], centerId: a.data.id, radiiKm: [1, 3] });
    expect(r.ok).toBe(true);
    const map = r.blocks!.find((x) => x.kind === "map") as any;
    expect(map.points.map((p: any) => p.id)).toEqual([a.data.id]);
    expect(map.rings).toEqual([{ centerId: a.data.id, radiiKm: [1, 3] }]);
    expect(r.missing).toContain(`No coordinates recorded for Map B ${T}`);
    const none = await run("show_on_map", { items: [{ type: "asset", id: randomUUID() }] });
    expect(none.error).toBe("not_found_or_no_access");
  });
});

describe("style profile", () => {
  it("builds from approved drafts, is owner-only, turn off clears and blocks the hint", async () => {
    const admin = adminClient();
    for (let i = 0; i < 3; i++) {
      const ins = await admin.from("draft").insert({ workspace_id: WS1, owner_user_id: USERS.colleague.id, channel: "email", body: `Hi Rahul,\nSharing the shortlist ${T} as discussed, option ${i}. Please let me know.\nRegards,\nC`, content_hash: `${T}-${i}`, state: "approved", approved_by: USERS.colleague.id, approved_at: new Date().toISOString() });
      expect(ins.error).toBeNull();
    }
    const col = await userClient("colleague");
    const r: any = await rebuildStyleProfile(col, WS1, USERS.colleague.id);
    expect(r.profile.sample_count).toBeGreaterThanOrEqual(3);
    expect(r.profile.stats.greetings[0].text).toBe("Hi");
    expect(r.profile.summary).toBeTruthy();
    expect(await styleHintFor(col, WS1, USERS.colleague.id)).toMatch(/Usual greeting/);
    expect(await getStyleProfile(db, WS1, USERS.colleague.id)).toBeNull(); // owner of the workspace still can't read it
    await setStyleEnabled(col, WS1, USERS.colleague.id, false);
    expect(await styleHintFor(col, WS1, USERS.colleague.id)).toBeUndefined();
    expect(await rebuildStyleProfile(col, WS1, USERS.colleague.id)).toEqual({ skipped: "turned off" });
    await setStyleEnabled(col, WS1, USERS.colleague.id, true);
  });
});

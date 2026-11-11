/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped */
/**
 * Export an assistant message as a branded deck / Word doc / PDF. User-scoped (ctx.db, RLS) — never the admin client.
 * Stored in mudar-workspace-files at <ws>/assistant/exports/<id>.<fmt> and registered as a document_version
 * (purpose "assistant_export", linked to the conversation) so it is tracked like every other generated deliverable.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AppContext } from "@/lib/auth/context";
import { brandFrom } from "@/modules/deals/documents/model";
import type { Block } from "../types";
import { MIME, buildModel, exportFileName, hasStructured, render, type ExportFormat } from "./render";

export const EXPORT_BUCKET = "mudar-workspace-files";
export const EXPORT_PURPOSE = "assistant_export";
export class ExportError extends Error { constructor(public status: number, msg: string) { super(msg); } }

type Ctx = Pick<AppContext, "db" | "workspaceId" | "userId">;

/** Workspace branding: approved deck/proposal template brand_json > workspace_setting "branding" > neutral defaults. */
export async function loadBrand(ctx: Ctx) {
  const db = ctx.db as any;
  const tpl = (await db.from("template_asset").select("brand_json, purpose").eq("workspace_id", ctx.workspaceId).in("purpose", ["shortlist_deck", "proposal", "market_note"]).is("archived_at", null)
    .order("approved", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle()).data as { brand_json: Record<string, unknown> } | null;
  const setting = (await db.from("workspace_setting").select("value").eq("workspace_id", ctx.workspaceId).eq("key", "branding").maybeSingle()).data as { value: Record<string, unknown> } | null;
  const wsRow = (await db.from("workspace").select("name").eq("id", ctx.workspaceId).maybeSingle()).data as { name: string } | null;
  const json = { ...(setting?.value ?? {}), ...(tpl?.brand_json ?? {}) };
  return brandFrom(json, wsRow?.name ?? "CRE OS");
}

/** Latest assistant message in a conversation that has structured blocks (for "make this a deck"). */
export async function latestExportableMessage(ctx: Ctx, conversationId: string): Promise<string | null> {
  const { data } = await (ctx.db as any).from("assistant_message").select("id, blocks").eq("workspace_id", ctx.workspaceId).eq("conversation_id", conversationId)
    .eq("role", "assistant").order("seq", { ascending: false }).limit(10);
  const hit = ((data ?? []) as any[]).find((m) => Array.isArray(m.blocks) && hasStructured(m.blocks as Block[]));
  return hit?.id ?? null;
}

export async function exportMessage(ctx: Ctx, input: { messageId: string; format: ExportFormat }, now = new Date()) {
  const db = ctx.db as any;
  const { data: msg } = await db.from("assistant_message").select("id, conversation_id, role, content, blocks, classification").eq("workspace_id", ctx.workspaceId).eq("id", input.messageId).maybeSingle();
  if (!msg || msg.role !== "assistant") throw new ExportError(404, "Message not found.");
  const blocks = (Array.isArray(msg.blocks) ? msg.blocks : []) as Block[];
  if (!blocks.length && !String(msg.content ?? "").trim()) throw new ExportError(422, "This message has nothing to export.");
  const { data: conv } = await db.from("assistant_conversation").select("id, title").eq("workspace_id", ctx.workspaceId).eq("id", msg.conversation_id).maybeSingle();
  const title = conv?.title && conv.title !== "New conversation" ? conv.title : "Assistant answer";
  const date = now.toISOString().slice(0, 10);
  const fileName = exportFileName(title, date, input.format);
  const model = buildModel(blocks, { title, leadText: msg.content, brand: await loadBrand(ctx), generatedAt: now.toISOString() });
  const buffer = await render(input.format, model);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const id = randomUUID();
  const path = `${ctx.workspaceId}/assistant/exports/${id}.${input.format}`;
  const ins = await db.from("document_version").insert({
    id, workspace_id: ctx.workspaceId, owner_user_id: ctx.userId, classification: msg.classification ?? "corporate_confidential",
    kind: input.format, purpose: EXPORT_PURPOSE, uri: null, sha256: null, status: "draft",
    linked_entity_type: "assistant_conversation", linked_entity_id: msg.conversation_id,
    input_versions: { message_id: msg.id, conversation_id: msg.conversation_id, file_name: fileName, title, block_kinds: blocks.map((b) => b.kind), sources: model.sources.length, missing: model.missing },
  }).select("id").single();
  if (ins.error) throw new ExportError(500, `Could not register document: ${ins.error.message}`);
  const up = await db.storage.from(EXPORT_BUCKET).upload(path, buffer, { contentType: MIME[input.format], upsert: false });
  if (up.error) { await db.from("document_version").update({ archived_at: now.toISOString() }).eq("id", id); throw new ExportError(500, `Storage upload failed: ${up.error.message}`); }
  const done = await db.from("document_version").update({ uri: `${EXPORT_BUCKET}/${path}`, sha256 }).eq("id", id).eq("workspace_id", ctx.workspaceId);
  if (done.error) { await db.storage.from(EXPORT_BUCKET).remove([path]); throw new ExportError(500, done.error.message); }
  return { documentId: id, fileName, format: input.format, bytes: buffer.length, href: `/api/v1/assistant/exports/${id}`, sections: model.sections.length, sources: model.sources.length, missing: model.missing.length };
}

/** Download a stored export (workspace path prefix + hash checked). */
export async function downloadExport(ctx: Ctx, id: string) {
  const db = ctx.db as any;
  const { data: doc } = await db.from("document_version").select("id, kind, uri, sha256, purpose, input_versions").eq("workspace_id", ctx.workspaceId).eq("id", id).is("archived_at", null).maybeSingle();
  if (!doc || doc.purpose !== EXPORT_PURPOSE || !doc.uri) throw new ExportError(404, "Export not found.");
  const path = String(doc.uri).replace(`${EXPORT_BUCKET}/`, "");
  if (!path.startsWith(`${ctx.workspaceId}/assistant/exports/`)) throw new ExportError(404, "Export not found.");
  const dl = await db.storage.from(EXPORT_BUCKET).download(path);
  if (dl.error || !dl.data) throw new ExportError(404, "File missing from storage.");
  const buffer = Buffer.from(await dl.data.arrayBuffer());
  if (createHash("sha256").update(buffer).digest("hex") !== doc.sha256) throw new ExportError(409, "Stored file does not match its recorded hash.");
  const format = doc.kind as ExportFormat;
  return { buffer, mime: MIME[format] ?? "application/octet-stream", fileName: String(doc.input_versions?.file_name ?? `assistant-export.${format}`) };
}

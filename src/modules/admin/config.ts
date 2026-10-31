/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { badRequest, conflict } from "./errors";

/**
 * Tenant configuration records managed from /settings: partners, Office templates, licensed sources and data lanes.
 * All are business tables (RLS via make_business_table); writes go through the caller's RLS client and are archived,
 * never deleted. Tenant-specific names (e.g. a fit-out finance partner, a licensed data vendor) live here as data,
 * never in code.
 */
type Client = SupabaseClient<any, any, any>;
type Row = Record<string, any>;

const CLASSES = ["public", "permitted_personal", "corporate_confidential", "licensed_restricted"] as const;
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const list = z.preprocess((v) => (Array.isArray(v) ? v : String(v ?? "").split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean), z.array(z.string().max(200)));
const optText = (max = 2000) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const optInt = z.preprocess(blankToNull, z.coerce.number().int().positive().nullable().optional());
const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
const jsonObject = z.preprocess((v) => {
  if (v === null || v === undefined || v === "") return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return Symbol.for("invalid-json"); }
}, z.record(z.string(), z.unknown(), { message: "must be a JSON object" }));

export const partnerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  partner_type: z.enum(["fitout_finance", "referral", "landlord", "operator", "vendor", "other"]),
  terms_json: jsonObject,
  conflicts_note: optText(),
  reliability_preference: optText(500),
  active: checkbox,
});

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["pptx", "docx", "xlsx"]),
  purpose: z.string().trim().min(1).max(80),
  brand_json: jsonObject,
  approved: checkbox,
});

export const licensedSourceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  licence_identifier: optText(200),
  allowed_purposes: list,
  user_count: optInt,
  redistribution_limits: optText(),
  retention_days: optInt,
  permits_ai_processing: checkbox,
  permits_colleague_sharing: checkbox,
  expires_on: z.preprocess(blankToNull, z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()),
});

export const dataLaneSchema = z.object({
  name: z.string().trim().min(1).max(200),
  allowed_classifications: z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.enum(CLASSES)).min(1, "pick at least one classification")),
  approved_processors: list,
  approved_regions: list,
  approval_evidence: optText(),
  approved: checkbox,
});

export const CONFIG = {
  partner: { table: "partner", schema: partnerSchema, order: "name" },
  template_asset: { table: "template_asset", schema: templateSchema, order: "purpose" },
  licensed_source: { table: "licensed_source", schema: licensedSourceSchema, order: "name" },
  data_lane: { table: "data_lane", schema: dataLaneSchema, order: "name" },
} as const;
export type ConfigKind = keyof typeof CONFIG;

function toRow(kind: ConfigKind, input: unknown): Row {
  const v = CONFIG[kind].schema.parse(input) as Row;
  if (kind === "data_lane") {
    const { approved, ...rest } = v;
    return { ...rest, approved_at: approved ? new Date().toISOString() : null };
  }
  return v;
}

export async function listConfig(db: Client, workspaceId: string, kind: ConfigKind, opts: { archived?: boolean } = {}) {
  const c = CONFIG[kind];
  let q = db.from(c.table).select("*").eq("workspace_id", workspaceId);
  q = opts.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  const { data, error } = await q.order(c.order);
  if (error) throw badRequest(error.message);
  return (data ?? []) as Row[];
}

export async function createConfig(db: Client, workspaceId: string, userId: string, kind: ConfigKind, input: unknown, extra: Row = {}) {
  const row = toRow(kind, input);
  const { data, error } = await db.from(CONFIG[kind].table)
    .insert({ ...row, ...extra, workspace_id: workspaceId, owner_user_id: userId, classification: "corporate_confidential" })
    .select().single();
  if (error) throw badRequest(error.message);
  return data as Row;
}

export async function updateConfig(db: Client, workspaceId: string, kind: ConfigKind, id: string, expectedVersion: number, input: unknown, extra: Row = {}) {
  const row = toRow(kind, input);
  if (kind === "data_lane") {
    // keep the original approval time when it stays approved
    const { data: cur } = await db.from("data_lane").select("approved_at").eq("workspace_id", workspaceId).eq("id", id).maybeSingle();
    if (row.approved_at && cur?.approved_at) row.approved_at = cur.approved_at;
  }
  const { data, error } = await db.from(CONFIG[kind].table).update({ ...row, ...extra })
    .eq("workspace_id", workspaceId).eq("id", id).eq("row_version", expectedVersion).select("id, row_version");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw conflict();
  return data[0] as Row;
}

export async function archiveConfig(db: Client, workspaceId: string, kind: ConfigKind, id: string, archived: boolean) {
  const { data, error } = await db.from(CONFIG[kind].table).update({ archived_at: archived ? new Date().toISOString() : null })
    .eq("workspace_id", workspaceId).eq("id", id).select("id");
  if (error) throw badRequest(error.message);
  if (!data?.length) throw conflict("record not visible or already changed");
}

/** Template files live at <ws>/templates/<uuid>-<file>; only Office formats are accepted. */
export const TEMPLATE_MIME: Record<string, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const TEMPLATE_MAX_BYTES = 25 * 1024 * 1024;

export function templatePath(workspaceId: string, fileName: string, id = crypto.randomUUID()) {
  const safe = fileName.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "template";
  return `${workspaceId}/templates/${id}-${safe}`;
}

export function templateKindFromName(fileName: string): "pptx" | "docx" | "xlsx" | null {
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "pptx" || ext === "docx" || ext === "xlsx" ? ext : null;
}

/**
 * Validate a template path uploaded by the browser: must sit under this workspace's templates/ prefix, have an
 * Office extension matching the template kind, and exist in storage (visible to the caller).
 */
export async function verifyTemplatePath(db: Client, workspaceId: string, path: string, kind: string) {
  const prefix = `${workspaceId}/templates/`;
  if (!path.startsWith(prefix) || path.includes("..") || path.slice(prefix.length).includes("/")) throw badRequest("invalid template path");
  const ext = templateKindFromName(path);
  if (!ext) throw badRequest("template must be a .pptx, .docx or .xlsx file");
  if (ext !== kind) throw badRequest(`file is .${ext} but the template format is ${kind}`);
  const name = path.slice(prefix.length);
  const { data, error } = await db.storage.from("mudar-workspace-files").list(prefix.slice(0, -1), { search: name, limit: 5 });
  if (error || !(data ?? []).some((f) => f.name === name)) throw badRequest("uploaded template file not found; upload again");
  return path;
}

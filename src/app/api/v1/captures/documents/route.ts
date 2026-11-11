import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext, HttpError } from "@/lib/auth/context";
import { route, parseJson } from "@/lib/util/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { asHttp } from "@/modules/changes/http";
import { DOC_TYPES } from "@/modules/capture/docs/detect";
import { intakeDocument, intakeFromStorage, listDocuments, MAX_DOC_BYTES, type IntakeOptions } from "@/modules/capture/docs/service";

export const dynamic = "force-dynamic";

const Links = z.object({ organisation_id: z.string().uuid(), person_id: z.string().uuid(), asset_id: z.string().uuid(), requirement_id: z.string().uuid(), meeting_prep_id: z.string().uuid() }).partial();
const Opts = z.object({
  links: Links.optional(), type: z.enum(DOC_TYPES).nullish(), caption: z.string().max(500).nullish(), typedText: z.string().max(20_000).nullish(),
  languageHint: z.enum(["en", "hi", "hinglish"]).nullish(), consentReference: z.string().max(500).nullish(),
  partyKind: z.enum(["landlord", "managed_operator", "fitout_partner", "other"]).nullish(),
});
const Body = Opts.extend({ storagePath: z.string().min(1).max(500), fileName: z.string().min(1).max(200), mime: z.string().max(200).default("") });
const toOpts = (o: z.infer<typeof Opts>): IntakeOptions => ({ links: o.links, userType: o.type ?? null, caption: o.caption, typedText: o.typedText, languageHint: o.languageHint, consentReference: o.consentReference, partyKind: o.partyKind ?? undefined });

/** GET /api/v1/captures/documents — recent files with detected type, status and proposals. */
export const GET = route(async () => {
  const ctx = await requireContext();
  return { documents: await listDocuments(ctx.db, ctx.workspaceId, 50) };
});

/**
 * POST /api/v1/captures/documents — JSON {storagePath (already uploaded under <ws>/captures/), fileName, mime, links?, type?, …}
 * or multipart (file + `options` JSON). Idempotent twice over: Idempotency-Key header, and the file's sha256 (same file => same document).
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireContext("editor");
  const deps = { admin: createAdminClient() };
  try {
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") throw new HttpError(400, "file required");
      if (file.size > MAX_DOC_BYTES) throw new HttpError(413, "file too large (max 25 MB)");
      const raw = form.get("options");
      const o = Opts.parse(typeof raw === "string" && raw ? JSON.parse(raw) : {});
      const r = await intakeDocument(ctx, { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, toOpts(o), deps);
      return { document: r.doc, duplicate: r.duplicate };
    }
    const b = await parseJson(req, Body);
    const r = await intakeFromStorage(ctx, { path: b.storagePath, name: b.fileName, mime: b.mime }, toOpts(b), deps);
    return { document: r.doc, duplicate: r.duplicate };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    asHttp(e);
  }
}, { requireIdempotency: true });

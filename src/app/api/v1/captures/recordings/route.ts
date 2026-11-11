import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireContext, HttpError } from "@/lib/auth/context";
import { route } from "@/lib/util/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { asHttp } from "@/modules/changes/http";
import { MAX_DOC_BYTES } from "@/modules/capture/docs/service";
import { intakeRecording } from "@/modules/capture/input-engine/recording";

export const dynamic = "force-dynamic";

const Opts = z.object({ consent: z.literal(true), consentReference: z.string().max(300).nullish(), meetingPrepId: z.string().uuid().nullish(),
  languageHint: z.enum(["en", "hi", "hinglish"]).nullish(), typedText: z.string().max(20_000).nullish() });

/** POST /api/v1/captures/recordings — multipart (file + options JSON). Consent is required; the recording goes to Module 7. */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireContext("editor");
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") throw new HttpError(400, "file required");
    if (file.size > MAX_DOC_BYTES) throw new HttpError(413, "file too large (max 25 MB)");
    const raw = form.get("options");
    const parsed = Opts.safeParse(typeof raw === "string" && raw ? JSON.parse(raw) : {});
    if (!parsed.success) throw new HttpError(400, "Confirm consent (consent: true) to upload a recording.");
    const r = await intakeRecording(ctx, { name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }, parsed.data, { admin: createAdminClient() });
    return { document: r.doc, duplicate: r.duplicate };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    asHttp(e);
  }
}, { requireIdempotency: true });

"use client";
import { useActionState, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { Result, type ActionState } from "@/modules/changes/ui/client";
import { captureAction } from "../actions";

function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Mobile quick capture: type/paste a debrief, or attach a voice note / photo. Files go straight to storage
 * (<ws>/captures/<uuid>/…) with the user's session, so large audio never passes through the server-action body.
 * A per-form idempotency key makes double-taps create one capture.
 */
export function QuickCapture({ workspaceId }: { workspaceId: string }) {
  const idem = useMemo(() => crypto.randomUUID(), []);
  const [kind, setKind] = useState<"text" | "audio" | "image">("text");

  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData): Promise<ActionState> => {

    const file = fd.get("file");
    fd.delete("file");
    if (file && typeof file !== "string" && file.size > 0) {
      if (file.size > 25 * 1024 * 1024) return { error: "File too large (max 25 MB)." };
      const path = `${workspaceId}/captures/${crypto.randomUUID()}/${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "upload"}`;
      const { error } = await createBrowserSupabase().storage.from("workspace-files").upload(path, file, { contentType: file.type || undefined });
      if (error) { return { error: `Upload failed: ${error.message}` }; }
      fd.set("storage_path", path);
    }
    return captureAction(prev, fd);
  }, null);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="idem" value={idem} />
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Capture type">
        {(["text", "audio", "image"] as const).map((k) => (
          <label key={k} className={`flex min-h-10 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm ${kind === k ? "border-brand bg-brand-soft text-brand" : "border-line"}`}>
            <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
            {k === "text" ? "Note" : k === "audio" ? "Voice" : "Photo"}
          </label>
        ))}
      </div>
      <Field label={kind === "text" ? "What happened?" : kind === "audio" ? "Notes (optional; used as the transcript when speech-to-text is off)" : "Caption / what the photo shows"}
        hint={kind === "text" ? 'e.g. "spoke to Raj at Acme; 20k by March; maybe Baner; send options Friday"' : undefined}>
        <Textarea name="text" rows={kind === "text" ? 5 : 3} required={kind === "text"} placeholder="Hindi, English or Hinglish is fine" />
      </Field>
      {kind !== "text" ? (
        <Field label={kind === "audio" ? "Voice note" : "Photo"} hint={kind === "image" ? "Photos add context; they are never treated as proof of legal terms." : undefined}>
          <Input type="file" name="file" accept={kind === "audio" ? "audio/*" : "image/*"} capture={kind === "audio" ? undefined : "environment"} required />
        </Field>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="When"><Input type="datetime-local" name="source_at" defaultValue={localNow()} /></Field>
        <Field label="Language">
          <Select name="language_hint" defaultValue="">
            <option value="">Auto</option><option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option><option value="mr">Marathi</option>
          </Select>
        </Field>
        {kind === "audio" ? <Field label="Recording consent ref." hint="Notice/permission reference for call recordings"><Input name="consent_reference" /></Field> : null}
      </div>
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">{pending ? "Capturing…" : "Capture"}</Button>
      <Result state={state} />
    </form>
  );
}

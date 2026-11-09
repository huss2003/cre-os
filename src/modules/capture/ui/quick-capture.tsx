"use client";
import { useActionState, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Button, Field, Input, MoreFields, Select, Textarea } from "@/components/ui";
import { Result, type ActionState } from "@/modules/changes/ui/client";
import { captureAction } from "../actions";
import { LiveDictation } from "./live-dictation";

function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type Mode = "type" | "speak" | "photo";
const MODES: { key: Mode; label: string; hint: string; icon: React.ReactNode }[] = [
  { key: "speak", label: "Speak", hint: "Words appear as you talk",
    icon: <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg> },
  { key: "type", label: "Type", hint: "Write or paste a note",
    icon: <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" /></svg> },
  { key: "photo", label: "Photo", hint: "Visiting card, whiteboard",
    icon: <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg> },
];

/**
 * Quick capture for beginners: pick Speak / Type / Photo, fill one box, press Save.
 * Speak = live dictation in the browser; the final text is saved as a note (no audio leaves the device via CRE OS).
 * Photos go straight to storage with the user's session. A per-form idempotency key makes double-taps create one capture.
 */
export function QuickCapture({ workspaceId }: { workspaceId: string }) {
  const idem = useMemo(() => crypto.randomUUID(), []);
  const [mode, setMode] = useState<Mode>("speak");
  const [text, setText] = useState("");

  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData): Promise<ActionState> => {
    fd.set("text", text);
    fd.set("kind", mode === "photo" ? "image" : "text");
    let file = fd.get("file");
    fd.delete("file");
    if (mode !== "photo" && !text.trim()) return { error: mode === "speak" ? "Nothing heard yet. Tap the microphone and speak." : "Write what happened first." };
    if (mode === "photo") {
      if (!file || typeof file === "string" || file.size === 0) return { error: "Choose or take a photo first." };
      if (file.size > 25 * 1024 * 1024) return { error: "Photo too large (max 25 MB)." };
      const path = `${workspaceId}/captures/${crypto.randomUUID()}/${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "upload"}`;
      const { error } = await createBrowserSupabase().storage.from("mudar-workspace-files").upload(path, file, { contentType: file.type || undefined });
      if (error) return { error: `Upload failed: ${error.message}` };
      fd.set("storage_path", path);
      file = null;
    }
    return captureAction(prev, fd);
  }, null);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="idem" value={idem} />
      <div className="grid grid-cols-3 gap-2 sm:gap-3" role="radiogroup" aria-label="How do you want to capture?">
        {MODES.map((m) => (
          <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)}
            className={`flex flex-col items-center gap-1 rounded-2xl border-2 px-2 py-3 text-center transition sm:py-4 ${mode === m.key ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-ink hover:border-brand/40"}`}>
            {m.icon}
            <span className="text-sm font-semibold">{m.label}</span>
            <span className="hidden text-xs text-ink-soft sm:block">{m.hint}</span>
          </button>
        ))}
      </div>

      {mode === "speak" ? (
        <>
          <LiveDictation value={text} onChange={setText} />
          {text ? (
            <Field label="Check the text" hint="Fix any word the microphone got wrong before saving.">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
            </Field>
          ) : null}
        </>
      ) : null}

      {mode === "type" ? (
        <Field label="What happened?" hint='Example: "Met Raj at Acme. Needs 20,000 sq ft in Baner by March. Send 3 options Friday."'>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="English, Hindi or Hinglish is fine" className="text-base" />
        </Field>
      ) : null}

      {mode === "photo" ? (
        <div className="space-y-3">
          <Field label="Photo" hint="Text in the photo is read as context only — never as proof of terms.">
            <Input type="file" name="file" accept="image/*" capture="environment" />
          </Field>
          <Field label="What is this?">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Visiting card of the landlord's leasing head" />
          </Field>
        </div>
      ) : null}

      <MoreFields label="More options">
          <Field label="When?"><Input type="datetime-local" name="source_at" defaultValue={localNow()} /></Field>
          <Field label="Language">
            <Select name="language_hint" defaultValue="">
              <option value="">Detect automatically</option><option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option><option value="mr">Marathi</option>
            </Select>
          </Field>
      </MoreFields>

      <Button type="submit" disabled={pending} className="w-full py-3 text-base sm:w-auto sm:px-8">{pending ? "Saving…" : "Save capture"}</Button>
      <Result state={state} />
    </form>
  );
}

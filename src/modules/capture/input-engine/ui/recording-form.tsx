"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Permitted recording upload (§2.6): consent must be confirmed before the file is sent. Mobile-first. */
export function RecordingForm({ meetings }: { meetings: { id: string; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get("file");
    if (!(file instanceof File) || !file.size) { setMsg("Choose a recording."); return; }
    if (f.get("consent") !== "on") { setMsg("Confirm that everyone agreed to the recording."); return; }
    setBusy(true); setMsg(null);
    const body = new FormData();
    body.set("file", file);
    body.set("options", JSON.stringify({ consent: true, consentReference: String(f.get("consent_reference") ?? "") || null,
      meetingPrepId: String(f.get("meeting") ?? "") || null, languageHint: String(f.get("language") ?? "") || null }));
    const res = await fetch("/api/v1/captures/recordings", { method: "POST", body, headers: { "Idempotency-Key": crypto.randomUUID() } });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg(j?.error?.message ?? j?.error ?? "Upload failed. The file was not processed."); return; }
    router.push(`/capture/documents/${j.document.id}`);
  }
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <input type="file" name="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.webm" className="block w-full text-sm" aria-label="Recording file" />
      <div className="grid gap-2 sm:grid-cols-2">
        <select name="meeting" defaultValue="" className="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Meeting">
          <option value="">Meeting (optional)</option>{meetings.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select name="language" defaultValue="" className="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Language">
          <option value="">Language: detect</option><option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option>
        </select>
      </div>
      <input name="consent_reference" placeholder="How consent was given (e.g. verbal at start)" className="w-full rounded-lg border border-line bg-surface px-2 py-1.5" />
      <label className="flex items-start gap-2"><input type="checkbox" name="consent" className="mt-1" /> <span>Everyone in this recording agreed to it being recorded and processed.</span></label>
      <button disabled={busy} className="rounded-lg bg-brand px-3 py-2 text-white disabled:opacity-50">{busy ? "Uploading…" : "Upload recording"}</button>
      {msg ? <p className="text-bad">{msg}</p> : null}
    </form>
  );
}

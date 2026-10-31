"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";

/**
 * In-browser voice note (MediaRecorder). Mobile-friendly: large tap targets, works on iOS Safari (audio/mp4) and
 * Android/desktop (audio/webm). The recording stays on the device until the form is submitted; nothing is streamed.
 */
export function VoiceRecorder({ onChange }: { onChange: (file: File | null) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "done" | "unsupported" | "denied">("idle");
  const [secs, setSecs] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")) setState("unsupported");
    return () => { if (timer.current) clearInterval(timer.current); rec.current?.stream.getTracks().forEach((t) => t.stop()); };
  }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { if (secs >= 600) stop(); }, [secs]); // 10-minute cap

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = r.mimeType || type || "audio/webm";
        const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(chunks.current, { type: mime });
        const file = new File([blob], `voice-note-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`, { type: mime });
        setUrl(URL.createObjectURL(blob));
        setState("done");
        onChange(file);
      };
      rec.current = r;
      r.start(1000);
      setSecs(0);
      setState("recording");
      timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch {
      setState("denied");
    }
  }
  function stop() {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    if (rec.current?.state === "recording") rec.current.stop();
  }
  function discard() {
    setUrl(null); setState("idle"); setSecs(0); onChange(null);
  }

  if (state === "unsupported") return <p className="text-xs text-ink-soft">This browser cannot record audio — attach a voice note file instead.</p>;
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        {state === "recording"
          ? <Button type="button" variant="danger" onClick={stop} className="min-h-12 flex-1 sm:flex-none" aria-live="polite">■ Stop ({mmss})</Button>
          : <Button type="button" variant={state === "done" ? "secondary" : "primary"} onClick={start} className="min-h-12 flex-1 sm:flex-none">● {state === "done" ? "Re-record" : "Record voice note"}</Button>}
        {state === "done" ? <Button type="button" variant="ghost" onClick={discard}>Discard</Button> : null}
      </div>
      {state === "recording" ? <p className="text-xs text-bad" role="status">Recording… Hindi, English or Hinglish is fine. Max 10 minutes.</p> : null}
      {state === "denied" ? <p className="text-xs text-bad">Microphone permission was denied. Allow it in the browser settings, or attach a file.</p> : null}
      {url ? <audio controls src={url} className="w-full" /> : null}
    </div>
  );
}

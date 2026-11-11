"use client";
import { useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui";

type Speech = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void };

/** Notes textarea with optional dictation (Web Speech API, in the browser only — nothing is sent by CRE OS). */
export function NotesInput({ name = "notes", defaultValue = "" }: { name?: string; defaultValue?: string }) {
  const [text, setText] = useState(defaultValue);
  const [ok, setOk] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Speech | null>(null);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    setOk(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  const mic = () => {
    if (listening) { rec.current?.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition; if (!C) return;
    const r = new C(); r.lang = "en-IN"; r.interimResults = false; r.continuous = true;
    const base = text;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0].transcript).join(" "); setText((base ? base + " " : "") + t); };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };
  return (
    <div className="space-y-2">
      <Textarea name={name} rows={8} required minLength={3} maxLength={20000} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Met Priya (finance) at Acme. They now need 220 seats, decision by 15 Dec. I'll send the shortlist by Friday. Concern: parking at Tower B." />
      {ok ? (
        <button type="button" onClick={mic} className="inline-flex min-h-11 items-center rounded-lg border border-line px-3 text-sm font-medium hover:bg-canvas" aria-pressed={listening}>
          {listening ? "Stop dictation" : "Speak notes"}
        </button>
      ) : <p className="text-xs text-ink-soft">Dictation isn&apos;t available in this browser — type or paste instead.</p>}
    </div>
  );
}

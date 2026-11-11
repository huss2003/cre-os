"use client";
import { useEffect, useRef, useState } from "react";

/* Minimal typing for the Web Speech API (Chrome / Edge / Android; Safari 14.1+ partial). */
type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
function getSR(): (new () => SR) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const LANGS: [string, string][] = [["en-IN", "English (India)"], ["hi-IN", "Hindi / Hinglish"], ["mr-IN", "Marathi"]];

/**
 * Live dictation: words appear on screen while you speak (grey = still listening, black = final).
 * Audio is processed by the browser's speech service; CRE OS only receives the final text you choose to save.
 */
export function LiveDictation({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [lang, setLang] = useState("en-IN");
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const rec = useRef<SR | null>(null);
  const wantOn = useRef(false);
  const base = useRef(value);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setSupported(!!getSR()); return () => { wantOn.current = false; rec.current?.abort(); if (timer.current) clearInterval(timer.current); }; }, []);

  function start() {
    const Ctor = getSR();
    if (!Ctor) { setSupported(false); return; }
    setError(null); setInterim(""); setSecs(0);
    base.current = value ? value.trimEnd() + " " : "";
    const r = new Ctor();
    r.lang = lang; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      let finalText = "", live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else live += res[0].transcript;
      }
      if (finalText) { base.current = (base.current + finalText.trim() + " ").replace(/\s+/g, " "); onChange(base.current.trimStart()); }
      setInterim(live);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { setError("Microphone blocked. Click the lock icon in the address bar and allow the microphone."); wantOn.current = false; }
      else if (e.error === "no-speech") { /* keep listening */ }
      else if (e.error === "network") { setError("Speech service unreachable. Check your internet connection."); wantOn.current = false; }
    };
    // Browsers stop after a pause; restart automatically until the user presses Stop.
    r.onend = () => { if (wantOn.current) { try { r.start(); } catch { /* already started */ } } else { setListening(false); setInterim(""); if (timer.current) clearInterval(timer.current); } };
    rec.current = r; wantOn.current = true;
    try { r.start(); setListening(true); timer.current = setInterval(() => setSecs((s) => s + 1), 1000); } catch { setError("Could not start the microphone."); }
  }
  function stop() { wantOn.current = false; rec.current?.stop(); }

  if (!supported) {
    return <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Live voice typing works in Google Chrome or Microsoft Edge. Open this page there, or type your note instead.</p>;
  }

  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-canvas px-4 py-6">
        <button type="button" onClick={listening ? stop : start} aria-pressed={listening}
          aria-label={listening ? "Stop listening" : "Start speaking"}
          className={`relative flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition ${listening ? "bg-bad" : "bg-brand hover:bg-brand-strong"}`}>
          {listening ? <span className="absolute inset-0 animate-ping rounded-full bg-bad/40" /> : null}
          {listening
            ? <svg viewBox="0 0 24 24" className="relative h-8 w-8" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            : <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>}
        </button>
        <p className="text-sm font-medium">{listening ? <>Listening… <span className="tabular-nums text-ink-soft">{mm}</span> — tap to stop</> : value ? "Tap to continue speaking" : "Tap the microphone and start speaking"}</p>
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          Language
          <select aria-label="Dictation language" value={lang} onChange={(e) => setLang(e.target.value)} disabled={listening} className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <div aria-live="polite" className="min-h-28 rounded-2xl border border-line bg-surface p-4 text-base leading-relaxed">
        {value || interim ? (<><span>{value}</span>{interim ? <span className="text-ink-soft"> {interim}</span> : null}</>)
          : <span className="text-ink-soft">Your words will appear here as you speak.</span>}
      </div>
      {error ? <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-bad">{error}</p> : null}
    </div>
  );
}

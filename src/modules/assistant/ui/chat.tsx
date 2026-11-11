"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { Block, EntityRef, RunStatus, StreamEvent } from "../types";
import { api, streamChat, type StoredMessage } from "./api";
import { BlockList, Markdown, blocksToMarkdown, ExportBar } from "./blocks";
import { markdownToPlain } from "./markdown";

/* Shared chat engine + thread + composer (used by the full page and the side panel). */

export interface Step { step: number; label: string; status: Extract<StreamEvent, { type: "step" }>["status"]; summary?: string }
export interface UiMessage {
  key: string; messageId?: string; role: "user" | "assistant";
  text: string; blocks: Block[]; steps: Step[];
  status?: RunStatus | "streaming"; error?: string; route?: "fast" | "deep";
  /** Set when the answer came from the answer cache: re-asks with `fresh: true`. */
  onRefresh?: () => void;
}

/** Status-block label written by the engine's answer cache. */
const REUSED = "Reused answer from";
const isReused = (blocks: Block[]) => blocks.some((b) => b.kind === "status" && b.done.some((d) => d.startsWith(REUSED)));
/** Markdown re-parse throttle while streaming. */
const FLUSH_MS = 60;

const toUi = (m: StoredMessage): UiMessage => ({
  key: m.id, messageId: m.id, role: m.role === "user" ? "user" : "assistant",
  text: m.content ?? "", blocks: Array.isArray(m.blocks) ? m.blocks : [], steps: [],
  status: (m.status as RunStatus | null) ?? "completed",
});

export function useAssistantChat(opts: { conversationId?: string | null; focus?: EntityRef | null; onConversation?: (id: string) => void }) {
  const [conversationId, setConversationId] = useState<string | null>(opts.conversationId ?? null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const onConv = useRef(opts.onConversation); onConv.current = opts.onConversation;

  const load = useCallback(async (id: string | null) => {
    abort.current?.abort();
    setConversationId(id); setLoadError(null);
    if (!id) { setMessages([]); return; }
    try { const r = await api.get(id); setMessages(r.messages.sort((a, b) => a.seq - b.seq).map(toUi)); }
    catch (e) { setMessages([]); setLoadError(e instanceof Error ? e.message : "Could not open this conversation"); }
  }, []);

  useEffect(() => { void load(opts.conversationId ?? null); }, [opts.conversationId, load]);

  const sendRef = useRef<(m: string, e?: { attachmentIds?: string[]; commandId?: string; fresh?: boolean }) => Promise<void>>(async () => undefined);
  const send = useCallback(async (message: string, extra: { attachmentIds?: string[]; commandId?: string; fresh?: boolean } = {}) => {
    const text = message.trim();
    if (!text || busy) return;
    const aKey = `a-${Date.now()}`;
    setMessages((m) => [...m, { key: `u-${Date.now()}`, role: "user", text, blocks: [], steps: [] },
      { key: aKey, role: "assistant", text: "", blocks: [], steps: [], status: "streaming" }]);
    setBusy(true);
    const patch = (fn: (m: UiMessage) => UiMessage) => setMessages((all) => all.map((m) => (m.key === aKey ? fn(m) : m)));
    const ctrl = new AbortController(); abort.current = ctrl;
    // Text deltas are buffered and flushed at most every FLUSH_MS, so markdown is re-parsed ~16×/s, not per token.
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { if (timer) { clearTimeout(timer); timer = null; } if (!pending) return; const d = pending; pending = ""; patch((m) => ({ ...m, text: m.text + d })); };
    try {
      await streamChat({ conversationId, message: text, focus: opts.focus ?? null, attachmentIds: extra.attachmentIds, commandId: extra.commandId, fresh: extra.fresh }, (e) => {
        if (e.type !== "text") flush();
        switch (e.type) {
          case "run":
            if (e.conversationId !== conversationId) { setConversationId(e.conversationId); onConv.current?.(e.conversationId); }
            patch((m) => ({ ...m, route: e.route })); break;
          case "step": patch((m) => {
            const others = m.steps.filter((s) => s.step !== e.step);
            return { ...m, steps: [...others, { step: e.step, label: e.label, status: e.status, summary: e.summary }].sort((a, b) => a.step - b.step) };
          }); break;
          case "text": pending += e.delta; if (!timer) timer = setTimeout(flush, FLUSH_MS); break;
          case "blocks": patch((m) => {
            const blocks = [...m.blocks, ...e.blocks];
            return { ...m, blocks, onRefresh: isReused(blocks) ? () => void sendRef.current(text, { fresh: true }) : m.onRefresh };
          }); break;
          case "done": patch((m) => ({ ...m, status: e.status, messageId: e.messageId })); break;
          case "error": patch((m) => ({ ...m, status: "failed", error: e.message })); break;
        }
      }, ctrl.signal);
      flush();
      patch((m) => (m.status === "streaming" ? { ...m, status: "partial", error: m.error ?? "The connection ended before the answer finished." } : m));
    } catch (e) {
      flush();
      if ((e as Error).name === "AbortError") patch((m) => ({ ...m, status: "cancelled" }));
      else patch((m) => ({ ...m, status: "failed", error: e instanceof Error ? e.message : "Something went wrong" }));
    } finally { setBusy(false); abort.current = null; }
  }, [busy, conversationId, opts.focus]);
  sendRef.current = send;

  const stop = useCallback(() => abort.current?.abort(), []);
  return { conversationId, messages, busy, send, stop, load, loadError };
}

/* ---------- step trail ---------- */
const STEP_ICON: Record<Step["status"], [string, string, string]> = {
  running: ["…", "text-brand", "running"], ok: ["✓", "text-ok", "done"], error: ["✗", "text-bad", "failed"],
  denied: ["⊘", "text-bad", "not allowed"], needs_approval: ["!", "text-warn", "needs your approval"],
};
function StepTrail({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (!live) setOpen(false); }, [live]);
  if (!steps.length) return null;
  const failed = steps.filter((s) => s.status === "error" || s.status === "denied").length;
  return (
    <div className="mb-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md text-xs font-medium text-ink-soft hover:text-ink">
        <span aria-hidden className={clsx("inline-block transition-transform motion-reduce:transition-none", open && "rotate-90")}>›</span>
        {live ? "Working" : "Worked through"} {steps.length} step{steps.length === 1 ? "" : "s"}{failed ? `, ${failed} failed` : ""}
      </button>
      {open ? (
        <ol className="ml-1.5 mt-1 space-y-1 border-l-2 border-line pl-3" aria-live="polite">
          {steps.map((s) => {
            const [icon, cls, sr] = STEP_ICON[s.status];
            return (
              <li key={s.step} className="text-xs">
                <span className={clsx("mr-1.5 inline-block w-3 font-bold", cls, s.status === "running" && "motion-safe:animate-pulse")} aria-hidden>{icon}</span>
                <span className="text-ink">{s.label}</span><span className="sr-only"> ({sr})</span>
                {s.summary ? <span className="text-ink-soft"> — {s.summary}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

const RUN_LABEL: Partial<Record<NonNullable<UiMessage["status"]>, [string, string]>> = {
  streaming: ["Working…", "text-brand"], running: ["Working…", "text-brand"], waiting_approval: ["Waiting for your approval", "text-warn"],
  waiting_info: ["Needs more information", "text-warn"], partial: ["Partly done", "text-warn"], failed: ["Failed", "text-bad"], cancelled: ["Stopped", "text-ink-soft"],
};

function messageText(m: UiMessage) { return [markdownToPlain(m.text), m.blocks.length ? blocksToMarkdown(m.blocks) : ""].filter(Boolean).join("\n\n"); }

function MessageActions({ m }: { m: UiMessage }) {
  const [copied, setCopied] = useState(false);
  const [rated, setRated] = useState<"up" | "down" | null>(null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const copy = async () => { try { await navigator.clipboard.writeText(messageText(m)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };
  const rate = async (r: "up" | "down", text?: string) => {
    if (!m.messageId) return;
    setRated(r); setAsking(false);
    try {
      const res = (await api.feedback(m.messageId, r, text?.trim() || undefined)) as { memoryId?: string | null };
      if (res?.memoryId) setNote("Thanks — I'll remember that preference (see Memory to review or remove it).");
    } catch { setRated(null); }
  };
  const cls = "inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-xs text-ink-soft hover:bg-canvas hover:text-ink";
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1">
      <button type="button" onClick={copy} className={cls}>{copied ? "Copied" : "Copy"}</button>
      {m.messageId ? <>
        <button type="button" onClick={() => rate("up")} aria-pressed={rated === "up"} className={clsx(cls, rated === "up" && "text-ok")} aria-label="Helpful">👍</button>
        <button type="button" onClick={() => (rated ? undefined : setAsking((a) => !a))} aria-pressed={rated === "down"} aria-expanded={asking} className={clsx(cls, rated === "down" && "text-bad")} aria-label="Not helpful">👎</button>
      </> : null}
      {m.onRefresh ? <button type="button" onClick={m.onRefresh} className={cls} title="Run again with the latest data">Refresh</button> : null}
      </div>
      {asking ? (
        <form className="mt-1 flex max-w-xl gap-1.5" onSubmit={(e) => { e.preventDefault(); void rate("down", comment); }}>
          <label htmlFor={`fb-${m.key}`} className="sr-only">What should I do differently?</label>
          <input id={`fb-${m.key}`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} autoFocus placeholder="What should I do differently? (optional)"
            className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-sm outline-none focus:border-brand" />
          <button type="submit" className="min-h-9 rounded-md bg-brand px-3 text-xs font-semibold text-white">Send</button>
        </form>
      ) : null}
      {note ? <p className="mt-1 text-xs text-ink-soft" role="status">{note}</p> : null}
    </div>
  );
}

export function Thread({ messages, compact }: { messages: UiMessage[]; compact?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];
  const pinned = useRef(true);
  // Follow the stream only while the reader is at the bottom; instant (not smooth) scroll per flush avoids jitter.
  useEffect(() => {
    const onScroll = () => { pinned.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120 || !end.current || end.current.getBoundingClientRect().top <= window.innerHeight + 120; };
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
  }, []);
  useEffect(() => { pinned.current = true; end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [messages.length]);
  useEffect(() => { if (pinned.current) end.current?.scrollIntoView({ block: "end", behavior: "auto" }); }, [last?.text.length, last?.blocks.length, last?.steps.length]);
  return (
    <div className={clsx("space-y-5", compact && "space-y-4")}>
      {messages.map((m) => m.role === "user" ? (
        <div key={m.key} className="flex justify-end">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-brand px-4 py-2.5 text-[15px] text-white">{m.text}</p>
        </div>
      ) : (
        <article key={m.key} className="min-w-0" aria-busy={m.status === "streaming"}>
          <StepTrail steps={m.steps} live={m.status === "streaming"} />
          {m.text ? (
            <div className={clsx(m.status === "streaming" && "assistant-streaming")}>
              <Markdown text={m.text} />
              {m.status === "streaming" ? <span aria-hidden className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-ink motion-safe:animate-pulse" /> : null}
            </div>
          ) : null}
          {m.blocks.length ? <div className={clsx(m.text && "mt-3")}><BlockList blocks={m.blocks} />{m.messageId ? <ExportBar messageId={m.messageId} blocks={m.blocks} /> : null}</div> : null}
          {m.status && RUN_LABEL[m.status] ? (
            <p className={clsx("mt-2 text-xs font-medium", RUN_LABEL[m.status]![1])} role={m.status === "failed" ? "alert" : undefined}>
              {m.status === "streaming" && !m.text && !m.steps.length ? <span className="motion-safe:animate-pulse">Thinking…</span> : RUN_LABEL[m.status]![0]}
              {m.error ? <span className="font-normal text-ink-soft"> — {m.error}</span> : null}
            </p>
          ) : null}
          {m.status !== "streaming" && (m.text || m.blocks.length) ? <MessageActions m={m} /> : null}
        </article>
      ))}
      <div ref={end} />
    </div>
  );
}

/** Markdown export of a whole conversation. */
export function exportMarkdown(title: string, messages: UiMessage[]) {
  const md = `# ${title}\n\n` + messages.map((m) => `## ${m.role === "user" ? "You" : "Assistant"}\n\n${m.role === "user" ? m.text : [m.text, blocksToMarkdown(m.blocks)].filter(Boolean).join("\n\n")}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  const a = document.createElement("a"); a.href = url; a.download = `${title.replace(/[^\w-]+/g, "-").slice(0, 60) || "conversation"}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- composer ---------- */
const ACCEPT = ".pdf,.docx,.txt,.csv,.md";
const MAX = 15 * 1024 * 1024;
type Speech = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

export function Composer({ onSend, busy, onStop, initial = "", conversationId, compact, autoFocus }: {
  onSend: (text: string, attachmentIds: string[]) => void; busy: boolean; onStop?: () => void; initial?: string;
  conversationId?: string | null; compact?: boolean; autoFocus?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [files, setFiles] = useState<{ id?: string; name: string; error?: string; uploading?: boolean }[]>([]);
  const [listening, setListening] = useState(false);
  const [speechOk, setSpeechOk] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rec = useRef<Speech | null>(null);

  useEffect(() => { setText(initial); }, [initial]);
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    setSpeechOk(!!(w.SpeechRecognition ?? w.webkitSpeechRecognition));
  }, []);
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, compact ? 160 : 260)}px`; }, [text, compact]);

  const ready = files.every((f) => !f.uploading);
  const submit = () => {
    if (busy || !text.trim() || !ready) return;
    onSend(text, files.filter((f) => f.id).map((f) => f.id!));
    setText(""); setFiles([]);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };
  const mic = () => {
    if (listening) { rec.current?.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition; if (!C) return;
    const r = new C(); r.lang = "en-IN"; r.interimResults = false; r.continuous = false;
    const base = text;
    r.onresult = (e) => { const t = Array.from(e.results).map((x) => x[0].transcript).join(" "); setText((base ? base + " " : "") + t); };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  };
  const pick = async (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) {
      const ok = /\.(pdf|docx|txt|csv|md)$/i.test(f.name);
      if (!ok || f.size > MAX) { setFiles((fs) => [...fs, { name: f.name, error: ok ? "Over 15 MB" : "Unsupported type" }]); continue; }
      setFiles((fs) => [...fs, { name: f.name, uploading: true }]);
      try { const r = await api.upload(f, conversationId); setFiles((fs) => fs.map((x) => (x.name === f.name && x.uploading ? { name: r.name ?? f.name, id: r.id } : x))); }
      catch (e) { setFiles((fs) => fs.map((x) => (x.name === f.name && x.uploading ? { name: f.name, error: e instanceof Error ? e.message : "Upload failed" } : x))); }
    }
    if (fileRef.current) fileRef.current.value = "";
  };
  const iconBtn = "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-canvas hover:text-ink";

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="rounded-2xl border border-line bg-surface shadow-[0_2px_12px_rgba(15,23,42,0.06)] focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/10">
      {files.length ? (
        <ul className="flex flex-wrap gap-1.5 px-3 pt-3" aria-label="Attachments">
          {files.map((f, i) => (
            <li key={i} className={clsx("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs", f.error ? "border-bad/30 bg-bad/5 text-bad" : "border-line bg-canvas")}>
              <span className="max-w-[12rem] truncate">{f.name}</span>{f.uploading ? <span className="text-ink-soft">uploading…</span> : null}{f.error ? <span>— {f.error}</span> : null}
              <button type="button" onClick={() => setFiles((fs) => fs.filter((_, k) => k !== i))} className="ml-0.5 rounded-full px-1 text-ink-soft hover:text-ink" aria-label={`Remove ${f.name}`}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={compact ? "assistant-input-panel" : "assistant-input"} className="sr-only">Ask the assistant</label>
      <textarea id={compact ? "assistant-input-panel" : "assistant-input"} ref={ta} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={compact ? 2 : 3}
        autoFocus={autoFocus} placeholder={listening ? "Listening…" : "Ask about your accounts, buildings, deals or meetings"}
        className="block w-full resize-none bg-transparent px-4 pt-3 text-[15px] text-ink outline-none placeholder:text-ink-soft" />
      <div className="flex items-center gap-1 px-2 pb-2">
        <input ref={fileRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => pick(e.target.files)} />
        <button type="button" onClick={() => fileRef.current?.click()} className={iconBtn} aria-label="Attach a file (PDF, DOCX, TXT, CSV, MD up to 15 MB)" title="Attach a file">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden><path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1" /></svg>
        </button>
        {speechOk ? (
          <button type="button" onClick={mic} aria-pressed={listening} className={clsx(iconBtn, listening && "bg-bad/10 text-bad")} aria-label={listening ? "Stop listening" : "Speak your question"} title="Voice input">
            <svg viewBox="0 0 24 24" className={clsx("h-5 w-5", listening && "motion-safe:animate-pulse")} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        ) : null}
        <span className="ml-auto hidden text-[11px] text-ink-soft sm:inline">Enter to send · Shift+Enter for a new line</span>
        {busy && onStop ? (
          <button type="button" onClick={onStop} className="ml-auto sm:ml-2 inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-canvas">Stop</button>
        ) : (
          <button type="submit" disabled={busy || !text.trim() || !ready} className="ml-auto sm:ml-2 inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:opacity-40">Ask</button>
        )}
      </div>
    </form>
  );
}

"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EntityRef } from "../types";
import { Composer, Thread, useAssistantChat } from "./chat";
import { GENERAL_PROMPTS, QUICK_PROMPTS, TYPE_LABEL, type PageFocus } from "./focus";

/** Contextual "Ask AI" sheet: right side on desktop, full screen on mobile. Knows the record on screen. */
export default function AssistantPanel({ focus, onClose }: { focus: PageFocus | null; onClose: () => void }) {
  const [label, setLabel] = useState<string | null>(null);
  const [prefill, setPrefill] = useState("");
  const sheet = useRef<HTMLDivElement>(null);

  // The record's name is the page heading; no extra request needed. Falls back to the type only.
  useEffect(() => {
    if (!focus) { setLabel(null); return; }
    const h = document.querySelector("main h1")?.textContent?.trim();
    setLabel(h && h.length < 120 ? h : null);
  }, [focus]);

  const ref: EntityRef | null = useMemo(() => focus ? { type: focus.type, id: focus.id, href: focus.href, label: label ?? TYPE_LABEL[focus.type] } : null, [focus, label]);
  const chat = useAssistantChat({ conversationId: null, focus: ref });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);

  const prompts = (focus && QUICK_PROMPTS[focus.type]) || GENERAL_PROMPTS.slice(0, 4);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="ask-ai-title">
      <button type="button" aria-label="Close assistant" tabIndex={-1} className="absolute inset-0 hidden bg-ink/30 sm:block" onClick={onClose} />
      <div ref={sheet} className="absolute inset-0 flex flex-col bg-canvas shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[440px] sm:border-l sm:border-line">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <h2 id="ask-ai-title" className="flex-1 text-base font-semibold">Ask AI</h2>
          {chat.conversationId ? (
            <Link href={`/assistant/${chat.conversationId}`} onClick={onClose} className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-brand hover:bg-brand-soft">Open full chat</Link>
          ) : (
            <Link href="/assistant" onClick={onClose} className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-ink-soft hover:bg-canvas">Full page</Link>
          )}
          <button type="button" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-soft hover:bg-canvas hover:text-ink" aria-label="Close assistant">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>

        {ref ? (
          <div className="border-b border-line bg-surface px-4 py-2 text-sm">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand/20 bg-brand-soft px-3 py-1 text-brand">
              <span className="text-xs">Viewing:</span><span className="truncate font-semibold">{label ? `${TYPE_LABEL[ref.type]} · ${label}` : TYPE_LABEL[ref.type]}</span>
            </span>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {chat.messages.length ? <Thread messages={chat.messages} compact /> : (
            <div>
              <p className="text-sm text-ink-soft">{ref ? "Ask about this record. The assistant already knows which one you are looking at." : "Ask about your accounts, buildings, deals or meetings."}</p>
              <ul className="mt-3 space-y-2">
                {prompts.map((p) => (
                  <li key={p}><button type="button" onClick={() => setPrefill(p)}
                    className="min-h-11 w-full rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm font-medium hover:border-brand/40 hover:bg-brand-soft/40">{p}</button></li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="border-t border-line bg-canvas px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <Composer compact initial={prefill} busy={chat.busy} onStop={chat.stop} conversationId={chat.conversationId}
            onSend={(t, ids) => { setPrefill(""); void chat.send(t, { attachmentIds: ids }); }} />
        </div>
      </div>
    </div>
  );
}

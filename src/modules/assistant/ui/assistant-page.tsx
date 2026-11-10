"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api, type ConversationItem, type SavedCommand } from "./api";
import { Composer, Thread, exportMarkdown, useAssistantChat } from "./chat";
import { GENERAL_PROMPTS } from "./focus";

/** Full-page assistant: conversation rail (drawer on mobile) + chat. */
export function AssistantPage({ conversationId, initialQuery = "", commandId }: { conversationId: string | null; initialQuery?: string; commandId?: string }) {
  const router = useRouter();
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [prefill, setPrefill] = useState(initialQuery);
  const [activeCommand, setActiveCommand] = useState<string | undefined>(commandId);

  const refresh = useCallback(async (query: string) => {
    try { const r = await api.list(query); setItems(r.items); setListErr(null); }
    catch (e) { setItems([]); setListErr(e instanceof Error ? e.message : "Could not load conversations"); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void refresh(q), 250); return () => clearTimeout(t); }, [q, refresh]);
  useEffect(() => {
    void api.commands().then((c) => {
      setCommands(c);
      if (commandId) { const hit = c.find((x) => x.id === commandId); if (hit) setPrefill(hit.prompt); }
    });
  }, [commandId]);

  const chat = useAssistantChat({
    conversationId,
    onConversation: (id) => { window.history.replaceState(null, "", `/assistant/${id}`); void refresh(q); },
  });
  const current = items?.find((c) => c.id === chat.conversationId);
  const title = current?.title ?? (chat.messages[0]?.text.slice(0, 60) || "New conversation");

  const send = (text: string, attachmentIds: string[]) => { void chat.send(text, { attachmentIds, commandId: activeCommand }); setActiveCommand(undefined); setPrefill(""); };
  const go = (id: string | null) => { setDrawer(false); if (!id) void chat.load(null); router.push(id ? `/assistant/${id}` : "/assistant"); };

  const rail = (
    <ConversationRail items={items} error={listErr} q={q} setQ={setQ} activeId={chat.conversationId} onOpen={go}
      onChanged={() => refresh(q)} onArchived={(id) => { void refresh(q); if (id === chat.conversationId) go(null); }} />
  );

  return (
    <div className="-mx-4 flex min-h-[calc(100dvh-14rem)] border-y border-line bg-canvas sm:mx-0 sm:rounded-2xl sm:border">
      <aside className="hidden w-72 shrink-0 border-r border-line bg-surface lg:block sm:rounded-l-2xl" aria-label="Conversations">{rail}</aside>

      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Conversations">
          <button type="button" aria-label="Close conversations" tabIndex={-1} className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-[min(320px,88vw)] overflow-y-auto bg-surface shadow-2xl">{rail}</div>
        </div>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-surface/80 px-4 py-2 sm:px-6">
          <button type="button" onClick={() => setDrawer(true)} className="inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-ink-soft hover:bg-canvas lg:hidden">Conversations</button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{chat.conversationId ? title : "Ask AI"}</h1>
          {chat.messages.length ? (
            <button type="button" onClick={() => exportMarkdown(title, chat.messages)} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-soft hover:bg-canvas hover:text-ink">Export</button>
          ) : null}
          <button type="button" onClick={() => go(null)} className="inline-flex min-h-11 items-center rounded-lg bg-brand-soft px-3 text-sm font-semibold text-brand hover:bg-brand hover:text-white">New</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-3xl">
            {chat.loadError ? <p role="alert" className="mb-4 rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{chat.loadError}. Start a new conversation or pick another one.</p> : null}
            {chat.messages.length ? <Thread messages={chat.messages} /> : (
              <EmptyIntro commands={commands} onPick={(p, id) => { setPrefill(p); setActiveCommand(id); }} />
            )}
          </div>
        </div>

        <div className="sticky bottom-16 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:px-6 lg:bottom-0">
          <div className="mx-auto max-w-3xl">
            {chat.messages.length && commands.length ? <CommandChips commands={commands} onPick={(p, id) => { setPrefill(p); setActiveCommand(id); }} /> : null}
            <Composer onSend={send} busy={chat.busy} onStop={chat.stop} initial={prefill} conversationId={chat.conversationId} autoFocus />
            <p className="mt-1.5 text-center text-[11px] text-ink-soft">The assistant reads your records and drafts. It never sends messages, and changes to client data wait for your approval.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function CommandChips({ commands, onPick }: { commands: SavedCommand[]; onPick: (prompt: string, id: string) => void }) {
  return (
    <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-1" aria-label="Saved commands">
      {commands.slice(0, 8).map((c) => (
        <button key={c.id} type="button" onClick={() => onPick(c.prompt, c.id)} title={c.prompt}
          className="min-h-9 shrink-0 rounded-full border border-line bg-surface px-3 text-xs font-medium hover:border-brand/40 hover:text-brand">{c.name}</button>
      ))}
      <Link href="/assistant/commands" className="flex min-h-9 shrink-0 items-center px-2 text-xs font-medium text-brand hover:underline">Manage</Link>
    </div>
  );
}

function EmptyIntro({ commands, onPick }: { commands: SavedCommand[]; onPick: (prompt: string, id?: string) => void }) {
  return (
    <div className="pt-4 sm:pt-10">
      <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">What do you need to get done?</h2>
      <p className="mt-2 max-w-xl text-ink-soft">Ask in plain words. The assistant looks through your companies, leases, meetings and deals, shows each step it takes, and tells you what it could not find.</p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {GENERAL_PROMPTS.map((p) => (
          <li key={p}>
            <button type="button" onClick={() => onPick(p)}
              className="flex min-h-12 w-full items-center rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm font-medium hover:border-brand/40 hover:bg-brand-soft/40">{p}</button>
          </li>
        ))}
      </ul>
      {commands.length ? (
        <div className="mt-6"><p className="mb-2 text-sm font-semibold">Your saved commands</p><CommandChips commands={commands} onPick={onPick} /></div>
      ) : null}
    </div>
  );
}

function ConversationRail({ items, error, q, setQ, activeId, onOpen, onChanged, onArchived }: {
  items: ConversationItem[] | null; error: string | null; q: string; setQ: (s: string) => void; activeId: string | null;
  onOpen: (id: string | null) => void; onChanged: () => void; onArchived: (id: string) => void;
}) {
  const sorted = [...(items ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.last_message_at ?? "").localeCompare(String(a.last_message_at ?? "")));
  return (
    <div className="flex h-full flex-col p-3">
      <button type="button" onClick={() => onOpen(null)} className="mb-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-brand text-sm font-semibold text-white hover:bg-brand-strong">New conversation</button>
      <label htmlFor="conv-search" className="sr-only">Search conversations</label>
      <input id="conv-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations"
        className="mb-3 min-h-11 w-full rounded-lg border border-line bg-canvas px-3 text-sm focus:border-brand focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand/20" />
      {error ? <p role="alert" className="px-1 text-sm text-bad">{error}</p> : null}
      {items === null ? <p className="px-1 text-sm text-ink-soft">Loading…</p> : !sorted.length && !error ? (
        <p className="px-1 text-sm text-ink-soft">{q ? "No conversations match." : "No conversations yet. Ask a question to start one."}</p>
      ) : null}
      <ul className="-mx-1 flex-1 space-y-0.5 overflow-y-auto">
        {sorted.map((c) => <RailItem key={c.id} c={c} active={c.id === activeId} onOpen={onOpen} onChanged={onChanged} onArchived={onArchived} />)}
      </ul>
      <div className="mt-3 border-t border-line pt-3 text-sm">
        <Link href="/assistant/memory" className="flex min-h-11 items-center rounded-lg px-2 text-ink-soft hover:bg-canvas hover:text-ink">What the assistant remembers</Link>
        <Link href="/assistant/commands" className="flex min-h-11 items-center rounded-lg px-2 text-ink-soft hover:bg-canvas hover:text-ink">Saved & scheduled commands</Link>
      </div>
    </div>
  );
}

function RailItem({ c, active, onOpen, onChanged, onArchived }: { c: ConversationItem; active: boolean; onOpen: (id: string) => void; onChanged: () => void; onArchived: (id: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(c.title ?? "");
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menu]);
  const act = async (fn: () => Promise<unknown>, after: () => void) => { setMenu(false); try { await fn(); after(); } catch { /* list refresh shows truth */ onChanged(); } };
  if (editing) return (
    <li className="px-1">
      <form onSubmit={(e) => { e.preventDefault(); setEditing(false); void act(() => api.patch(c.id, { title: name.trim() || "Untitled" }), onChanged); }}>
        <label className="sr-only" htmlFor={`rn-${c.id}`}>Rename conversation</label>
        <input id={`rn-${c.id}`} autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setEditing(false)}
          className="min-h-10 w-full rounded-lg border border-brand px-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/20" />
      </form>
    </li>
  );
  return (
    <li ref={ref} className="relative px-1">
      <div className={clsx("group flex items-center rounded-lg", active ? "bg-brand-soft" : "hover:bg-canvas")}>
        <button type="button" onClick={() => onOpen(c.id)} aria-current={active ? "page" : undefined}
          className={clsx("min-h-11 min-w-0 flex-1 truncate px-2 text-left text-sm", active ? "font-semibold text-brand" : "text-ink")}>
          {c.pinned ? <span className="mr-1 text-accent" aria-label="Pinned">●</span> : null}{c.title || "Untitled"}
        </button>
        <button type="button" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label={`Options for ${c.title || "conversation"}`}
          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:text-ink">⋯</button>
      </div>
      {menu ? (
        <ul role="menu" className="absolute right-1 z-20 mt-1 w-40 rounded-xl border border-line bg-surface p-1 shadow-xl">
          <li role="none"><button role="menuitem" type="button" className="flex min-h-10 w-full items-center rounded-lg px-3 text-sm hover:bg-canvas" onClick={() => act(() => api.patch(c.id, { pinned: !c.pinned }), onChanged)}>{c.pinned ? "Unpin" : "Pin"}</button></li>
          <li role="none"><button role="menuitem" type="button" className="flex min-h-10 w-full items-center rounded-lg px-3 text-sm hover:bg-canvas" onClick={() => { setMenu(false); setEditing(true); }}>Rename</button></li>
          <li role="none"><button role="menuitem" type="button" className="flex min-h-10 w-full items-center rounded-lg px-3 text-sm text-bad hover:bg-bad/5" onClick={() => act(() => api.archive(c.id), () => onArchived(c.id))}>Archive</button></li>
        </ul>
      ) : null}
    </li>
  );
}

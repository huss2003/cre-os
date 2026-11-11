"use client";
import { useEffect, useId, useRef, useState } from "react";

export type PickerKind = "company" | "requirement" | "meeting" | "person";
export interface PickerItem { id: string; label: string; context?: string; orgId?: string | null }

/**
 * Searchable entity picker (ARIA combobox). Type 2+ characters → matching records with a short context line.
 * Submits the chosen id in a hidden input `name`. Keyboard: ↑/↓ move, Enter selects, Esc closes.
 * `orgId` scopes requirement results to one company and lists its open requirements on focus (no typing needed).
 */
export function EntityPicker({ name, kind, label, defaultValue, orgId, onSelect, placeholder, endpoint = "/api/v1/assistant/notes/lookup", minChars = 2 }: {
  name: string; kind: PickerKind; label: string; defaultValue?: PickerItem | null; orgId?: string | null;
  onSelect?: (item: PickerItem | null) => void; placeholder?: string; endpoint?: string; minChars?: number;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [selected, setSelected] = useState<PickerItem | null>(defaultValue ?? null);
  const [text, setText] = useState(defaultValue?.label ?? "");
  const [items, setItems] = useState<PickerItem[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const seq = useRef(0);
  const scoped = kind === "requirement" && !!orgId;

  async function search(q: string) {
    const term = q.trim();
    if (term.length < minChars && !scoped) { setItems([]); setState("idle"); return; }
    const my = ++seq.current;
    setState("loading");
    try {
      const u = new URLSearchParams({ kind, q: term.length >= minChars ? term : "" });
      if (orgId) u.set("orgId", orgId);
      const r = await fetch(`${endpoint}?${u}`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { items: PickerItem[] };
      if (my !== seq.current) return;
      setItems(j.items ?? []); setActive(j.items?.length ? 0 : -1); setState("idle");
    } catch { if (my === seq.current) { setItems([]); setState("error"); } }
  }

  // debounce typing
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void search(text === selected?.label ? "" : text), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open, orgId]);

  const choose = (it: PickerItem | null) => {
    setSelected(it); setText(it?.label ?? ""); setOpen(false); setActive(-1); onSelect?.(it);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && open && active >= 0 && items[active]) { e.preventDefault(); choose(items[active]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  const hint = state === "error" ? "Search failed — try again." : state === "loading" ? "Searching…"
    : (text.trim().length < minChars && !scoped) ? `Type ${minChars}+ characters to search.` : items.length ? null : scoped ? "No open requirements for this company." : "No matches.";

  return (
    <div className="relative">
      <label htmlFor={`${uid}-in`} className="mb-1 block text-sm font-medium">{label}</label>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      <div className="flex gap-2">
        <input id={`${uid}-in`} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${uid}-o${active}` : undefined}
          className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm"
          placeholder={placeholder ?? (scoped ? "Pick or search…" : "Type to search…")} value={text} autoComplete="off"
          onChange={(e) => { setText(e.target.value); setOpen(true); if (selected) { setSelected(null); onSelect?.(null); } }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey} />
        {selected ? <button type="button" onClick={() => choose(null)} className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-sm" aria-label={`Clear ${label}`}>Clear</button> : null}
      </div>
      {selected?.context ? <p className="mt-1 text-xs text-ink-soft">{selected.context}</p> : null}
      {open ? (
        <ul id={listId} role="listbox" aria-label={label} className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lg">
          {items.map((it, i) => (
            <li key={it.id} id={`${uid}-o${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(it); }} onMouseEnter={() => setActive(i)}
              className={`min-h-11 cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-canvas" : ""}`}>
              <span className="block truncate font-medium">{it.label}</span>
              {it.context ? <span className="block truncate text-xs text-ink-soft">{it.context}</span> : null}
            </li>
          ))}
          {hint ? <li className="px-3 py-2 text-xs text-ink-soft" role="presentation" aria-live="polite">{hint}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

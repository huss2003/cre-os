"use client";
import { useState, type ReactNode } from "react";
import { btn } from "../kit";

/** Readable long table: sticky header, first `initial` rows shown, the rest behind a toggle. */
export function CollapsibleTable({ caption, head, rows, foot, initial = 12, rowNoun = "rows" }: { caption: string; head: string[]; rows: ReactNode[]; foot?: ReactNode; initial?: number; rowNoun?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, initial);
  const hidden = rows.length - initial;
  return (
    <div className="space-y-3">
      <div className={`overflow-auto rounded-xl border border-line ${all ? "max-h-[36rem]" : ""}`}>
        <table className="w-full min-w-[620px] text-left text-sm tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-[1] bg-canvas text-xs uppercase tracking-wide text-ink-soft shadow-[0_1px_0_var(--color-line)]">
            <tr>{head.map((h, i) => <th key={i} scope="col" className={`px-3 py-2.5 font-semibold ${i ? "text-right" : ""}`}>{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line [&_tr:nth-child(even)]:bg-canvas/40">{shown}</tbody>
          {foot && (all || hidden <= 0) ? <tfoot className="border-t-2 border-line font-semibold">{foot}</tfoot> : null}
        </table>
      </div>
      {hidden > 0 ? (
        <button type="button" aria-expanded={all} className={btn.secondary} onClick={() => setAll((x) => !x)}>
          {all ? `Show first ${initial} ${rowNoun} only` : `Show all ${rows.length} ${rowNoun} (+${hidden} more)`}
        </button>
      ) : null}
    </div>
  );
}

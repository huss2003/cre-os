"use client";
import { useState } from "react";
import { Button, Select, Textarea } from "@/components/ui";

export interface EditorColumn {
  column: number; letter: string; header: string; field: string | null; confidence: number; ambiguous: boolean;
  alternatives: { field: string; label: string; confidence: number }[];
}

/**
 * Review / correct the suggested column mapping of a contact/requirement sheet (spec §3.2). Each column can go to a
 * field, be kept as a custom value under its own header name, or be ignored. Approving re-processes the file and
 * remembers the header -> field pattern for future uploads with a different layout.
 */
export function ColumnMappingEditor({ batchId, sheet, headerRow, columns, fields, action }: {
  batchId: string; sheet: string; headerRow: number; columns: EditorColumn[]; fields: { key: string; label: string; multi?: boolean }[];
  action: (form: FormData) => Promise<void>;
}) {
  const [sel, setSel] = useState<Record<number, string>>(() => Object.fromEntries(columns.map((c) => [c.column, c.field ? c.field.split("#")[0] : c.header.trim() ? "custom" : ""])));
  const counts: Record<string, number> = {};
  const map: Record<string, number> = {};
  for (const c of columns) {
    const v = sel[c.column];
    if (!v) continue;
    if (v === "custom") { map[`custom:${c.header.trim().slice(0, 60)}`] = c.column; continue; }
    counts[v] = (counts[v] ?? 0) + 1;
    map[counts[v] === 1 ? v : `${v}#${counts[v]}`] = c.column;
  }
  const dupSingle = fields.filter((f) => !f.multi && (counts[f.key] ?? 0) > 1);
  const noCompany = !counts.company;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="sheet" value={sheet} />
      <input type="hidden" name="positional" value="false" />
      <input type="hidden" name="header_row" value={headerRow} />
      <input type="hidden" name="adapter_role" value="contacts_requirements_v1:contacts" />
      <input type="hidden" name="column_map" value={JSON.stringify(map)} />
      <ul className="divide-y divide-line rounded-xl border border-line">
        {columns.filter((c) => c.header.trim()).map((c) => (
          <li key={c.column} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium"><span className="text-ink-soft">{c.letter}</span> {c.header}</div>
              <div className="text-xs text-ink-soft">
                {c.field ? `Suggested ${Math.round(c.confidence * 100)}%` : "No confident match"}
                {c.ambiguous ? <span className="ml-1 text-warn">· ambiguous: {c.alternatives.map((a) => `${a.label} ${Math.round(a.confidence * 100)}%`).join(" / ")}</span> : null}
              </div>
            </div>
            <Select aria-label={`Field for column ${c.letter}`} value={sel[c.column] ?? ""} onChange={(e) => setSel({ ...sel, [c.column]: e.target.value })}>
              <option value="">— ignore —</option>
              <option value="custom">Keep as custom: “{c.header.slice(0, 24)}”</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </Select>
          </li>
        ))}
      </ul>
      <Textarea name="note" placeholder="Note (optional), e.g. 'Desk Count is seats'" />
      {dupSingle.length ? <p className="text-sm text-bad">{dupSingle.map((f) => f.label).join(", ")} is chosen for more than one column.</p> : null}
      {noCompany ? <p className="text-sm text-warn">No company column: rows can create contacts but not companies or requirements.</p> : null}
      <Button type="submit" disabled={dupSingle.length > 0} className="w-full sm:w-auto">Approve mapping and re-process</Button>
      <p className="text-xs text-ink-soft">The approved mapping is reused for this exact layout, and each header you confirm is remembered for future files with a different layout.</p>
    </form>
  );
}

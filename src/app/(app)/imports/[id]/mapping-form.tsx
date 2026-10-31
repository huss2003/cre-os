"use client";
import { useMemo, useState } from "react";
import { Button, Field, Select, Textarea } from "@/components/ui";

interface RoleOpt {
  adapter: string;
  role: string;
  label: string;
  headerless: boolean;
  positionalDefault: string[] | null;
  fields: { key: string; label: string; required: boolean }[];
}
interface Suggestion { adapter: string; role: string; label: string; positional: boolean; columnMap: Record<string, number> }

const letter = (i: number) => {
  let s = "", n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** Mapping review for one unknown sheet: choose an adapter role and assign each field to a source column, then approve. */
export function MappingForm({ batchId, sheet, headers, headerRow, suggestions, roles, action }: {
  batchId: string; sheet: string; headers: string[]; headerRow: number; suggestions: Suggestion[]; roles: RoleOpt[];
  action: (form: FormData) => Promise<void>;
}) {
  const headerless = headerRow === 0;
  const first = suggestions[0];
  const [roleKey, setRoleKey] = useState(first ? `${first.adapter}:${first.role}` : roles[0] ? `${roles[0].adapter}:${roles[0].role}` : "");
  const role = roles.find((r) => `${r.adapter}:${r.role}` === roleKey);
  const initial = useMemo(() => {
    const s = suggestions.find((x) => `${x.adapter}:${x.role}` === roleKey);
    if (s) return s.columnMap;
    if (role?.positionalDefault && headerless) return Object.fromEntries(role.positionalDefault.map((k, i) => [k, i]));
    return {} as Record<string, number>;
  }, [roleKey, suggestions, role, headerless]);
  const [map, setMap] = useState<Record<string, number | "">>(initial);
  const [lastRole, setLastRole] = useState(roleKey);
  if (lastRole !== roleKey) { setLastRole(roleKey); setMap(initial); }

  const cols = Math.max(headers.length, ...Object.values(map).filter((v): v is number => typeof v === "number").map((v) => v + 1), 1);
  const missing = role?.fields.filter((f) => f.required && (map[f.key] === undefined || map[f.key] === "")) ?? [];
  const used = Object.values(map).filter((v) => v !== "");
  const clash = new Set(used).size !== used.length;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="batch_id" value={batchId} />
      <input type="hidden" name="sheet" value={sheet} />
      <input type="hidden" name="positional" value={String(headerless)} />
      <input type="hidden" name="header_row" value={headerRow} />
      <input type="hidden" name="adapter_role" value={roleKey} />
      <input type="hidden" name="column_map" value={JSON.stringify(map)} />
      <p className="text-sm text-ink-soft">
        {headerless
          ? "This tab has no header row: its first row is data. Approving a positional map tells the importer which column holds what; it is reused only for tabs with exactly this shape."
          : `Header row ${headerRow} was not recognised. Map its columns once; the approved map is reused only for this exact header signature.`}
      </p>
      <Field label="What is this sheet?">
        <Select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
          {suggestions.length ? <optgroup label="Suggested">{suggestions.map((s) => <option key={`s-${s.adapter}:${s.role}`} value={`${s.adapter}:${s.role}`}>{s.label}</option>)}</optgroup> : null}
          <optgroup label="All adapters">{roles.map((r) => <option key={`${r.adapter}:${r.role}`} value={`${r.adapter}:${r.role}`}>{r.label}</option>)}</optgroup>
        </Select>
      </Field>
      {role ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {role.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`}>
              <Select value={map[f.key] ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value === "" ? "" : Number(e.target.value) })}>
                <option value="">— not in this sheet —</option>
                {Array.from({ length: cols }, (_, i) => (
                  <option key={i} value={i}>{letter(i)}{headers[i] ? `: ${String(headers[i]).slice(0, 40)}` : ""}</option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      ) : null}
      <Field label="Note (optional)"><Textarea name="note" placeholder="Why this mapping is right, e.g. 'upcoming tab, same 7 columns as existing assets'" /></Field>
      {missing.length ? <p className="text-sm text-warn">Required: {missing.map((m) => m.label).join(", ")}</p> : null}
      {clash ? <p className="text-sm text-bad">One column is assigned to two fields.</p> : null}
      <Button type="submit" disabled={!role || missing.length > 0 || clash}>Approve mapping and re-process</Button>
    </form>
  );
}

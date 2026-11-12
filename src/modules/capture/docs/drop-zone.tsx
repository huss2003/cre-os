"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Badge, Button, Field, Input, MoreFields, Select } from "@/components/ui";
import { EntityPicker } from "@/components/ui/entity-picker";
import { intakeAction, type IntakeState } from "./actions";
import { DOC_TYPES, TYPE_LABEL } from "./detect";

type Opt = { id: string; label: string };
export interface LinkOptions { organisation: Opt[]; person: Opt[]; asset: Opt[]; requirement: Opt[]; meeting: Opt[] }
type Item = { key: string; name: string; phase: "uploading" | "processing" | "done" | "failed"; result?: IntakeState; error?: string };

const MAX = 25 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.xlsx,image/*,audio/*,.m4a,.mp3,.wav,.webm,.ogg";
const LINKS: [keyof LinkOptions, string, string][] = [
  ["organisation", "organisation_id", "Company"], ["person", "person_id", "Person"], ["asset", "asset_id", "Building"],
  ["requirement", "requirement_id", "Requirement"], ["meeting", "meeting_prep_id", "Meeting / visit"],
];

/**
 * One drop zone for any file. Each file is uploaded straight to storage with the user's session (no request-size limit),
 * then the server hashes it (same file twice = same result), detects the type and routes it. Nothing changes a record:
 * results become proposals in Review.
 */
export function DropZone({ workspaceId, options }: { workspaceId: string; options: LinkOptions }) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const busy = items.some((i) => i.phase === "uploading" || i.phase === "processing");
  const set = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function run(files: File[]) {
    const base = new FormData(form.current ?? undefined);
    for (const f of files) {
      const key = crypto.randomUUID();
      setItems((xs) => [{ key, name: f.name, phase: "uploading" }, ...xs]);
      if (f.size > MAX) { set(key, { phase: "failed", error: "Larger than 25 MB." }); continue; }
      if (!f.size) { set(key, { phase: "failed", error: "The file is empty." }); continue; }
      const path = `${workspaceId}/captures/uploads/${key}/${f.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-100) || "upload"}`;
      const { error } = await createBrowserSupabase().storage.from("mudar-workspace-files").upload(path, f, { contentType: f.type || undefined });
      if (error) { set(key, { phase: "failed", error: `Upload failed: ${error.message}. Check your connection and try again.` }); continue; }
      set(key, { phase: "processing" });
      const fd = new FormData();
      for (const [k, v] of base.entries()) if (typeof v === "string") fd.set(k, v);
      fd.set("storage_path", path); fd.set("file_name", f.name); fd.set("mime", f.type);
      try {
        const r = await intakeAction(null, fd);
        set(key, { phase: r?.error && !r.id ? "failed" : r?.status === "failed" ? "failed" : "done", result: r ?? undefined, error: r?.error });
      } catch (e) { set(key, { phase: "failed", error: e instanceof Error ? e.message : "Processing failed." }); }
    }
  }

  return (
    <form ref={form} className="space-y-4" onSubmit={(e) => e.preventDefault()}>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); run([...e.dataTransfer.files]); }}
        className={`flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center ${over ? "border-brand bg-brand-soft" : "border-line bg-surface"}`}>
        <p className="text-sm font-semibold">Drop files here</p>
        <p className="text-xs text-ink-soft">Quotations, leases/LOIs, meeting notes (PDF, Word), business cards, building photos, layouts, spreadsheets, voice notes — up to 25 MB each.</p>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { run([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <Button type="button" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Working…" : "Choose files"}</Button>
      </div>

      <MoreFields label="Link to a record (optional)">
        {LINKS.map(([k, name, label]) => (
          <Field key={name} label={label}>
            <Select name={name} defaultValue="">
              <option value="">—</option>
              {options[k].map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
        ))}
        {/* Lease-family documents linked to a lease go to Leases (dates stay unconfirmed); linked to a transaction they go to its intake for review. */}
        <EntityPicker name="lease_id" kind="lease" label="Lease" placeholder="Search tenant, company or building…" />
        <EntityPicker name="transaction_id" kind="transaction" label="Transaction" placeholder="Search code or name…" />
        <Field label="What is it?" hint="Leave on Detect unless the guess is wrong.">
          <Select name="doc_type" defaultValue="">
            <option value="">Detect automatically</option>
            {DOC_TYPES.filter((t) => t !== "unknown").map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select>
        </Field>
        <Field label="Quotation from"><Select name="party_kind" defaultValue="other"><option value="other">Not sure</option><option value="landlord">Landlord</option><option value="managed_operator">Managed-office operator</option><option value="fitout_partner">Fit-out partner</option></Select></Field>
        <Field label="Recording language"><Select name="language_hint" defaultValue=""><option value="">Detect</option><option value="en">English</option><option value="hi">Hindi</option><option value="hinglish">Hinglish</option></Select></Field>
        <Field label="Recording consent" hint="Who agreed to the recording (required by your policy for meetings)."><Input name="consent_reference" placeholder="e.g. Raj agreed at start of call" /></Field>
        <Field label="Note"><Input name="caption" placeholder="e.g. Landlord's leasing head's card" /></Field>
      </MoreFields>

      {items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-live="polite">
          {items.map((i) => (
            <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{i.name}</span>
              <span className="flex flex-wrap items-center gap-2">
                {i.phase === "uploading" ? <Badge tone="brand">Uploading…</Badge> : null}
                {i.phase === "processing" ? <Badge tone="brand">Reading…</Badge> : null}
                {i.result?.type ? <Badge>{TYPE_LABEL[i.result.type as keyof typeof TYPE_LABEL] ?? i.result.type}</Badge> : null}
                {i.phase === "done" ? <Badge tone={i.result?.status === "needs_input" ? "warn" : "ok"}>{i.result?.status === "needs_input" ? "Needs your input" : i.result?.duplicate ? "Already uploaded" : "Done"}</Badge> : null}
                {i.phase === "failed" ? <Badge tone="bad">Failed</Badge> : null}
                {i.result?.id ? <Link className="text-brand underline" href={`/capture/documents/${i.result.id}`}>Open</Link> : null}
              </span>
              {i.error || i.result?.message ? <p className={`w-full text-xs ${i.phase === "failed" ? "text-bad" : "text-ink-soft"}`}>{i.error ?? i.result?.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}

"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, Input, MoreFields, Select } from "@/components/ui";

/** Upload an .xlsx/.csv to POST /api/v1/imports (Idempotency-Key per attempt), then open the batch report. */
export interface SourceOption { id: string; name: string; kind: string; approved: boolean; is_default: boolean }

export function UploadForm({ sources = [] }: { sources?: SourceOption[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [sourceId, setSourceId] = useState<string>(sources.find((s) => s.is_default && s.approved)?.id ?? sources.find((s) => s.approved)?.id ?? "new");
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) {
      setMsg("Choose a spreadsheet first.");
      return;
    }
    // several files, or any document/image => one background batch (the page stays usable; progress on the batch page)
    if (files.length > 1 || !/\.(xlsx|csv|txt)$/i.test(files[0].name)) {
      setBusy(true);
      setMsg(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`);
      try {
        const batch = new FormData();
        for (const f of files) batch.append("files", f);
        for (const k of ["as_of", "period_year", "classification", "source_id"]) { const v = form.get(k); if (typeof v === "string" && v) batch.append(k, v); }
        const res = await fetch("/api/v1/imports/runs", { method: "POST", body: batch, headers: { "Idempotency-Key": crypto.randomUUID() } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { setMsg(body.error ?? `Upload failed (${res.status})`); return; }
        router.push(`/imports/runs/${body.run_id}`);
        router.refresh();
      } catch {
        setMsg("Network error — try again; files already received are not duplicated.");
      } finally {
        setBusy(false);
      }
      return;
    }
    const file = files[0];
    form.set("file", file);
    setBusy(true);
    setMsg("Uploading and reconciling…");
    try {
      const res = await fetch("/api/v1/imports", { method: "POST", body: form, headers: { "Idempotency-Key": crypto.randomUUID() } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(body.error ?? `Upload failed (${res.status})`);
        return;
      }
      if (body.duplicate) setMsg("This exact file (same SHA-256) was already imported — opening the existing batch. Nothing was duplicated.");
      if (body.status === "awaiting_source") setMsg("Stored and quarantined: this source is not approved yet. An admin must approve it before the file is read.");
      router.push(`/imports/${body.batch_id}`);
      router.refresh();
    } catch {
      setMsg("Network error — the upload may not have reached the server. Try again; re-uploading the same file is safe.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4">
      <Field label="Files" hint=".xlsx or .csv (up to 25 MB each). Pick several files — spreadsheets, PDFs, Word or images — to process them together in the background. Macros, formulas and external links are never executed.">
        <Input type="file" name="file" multiple accept=".xlsx,.csv,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.doc,.docx,image/*" required />
      </Field>
      <Field label="As-of date" hint="Needed to keep rents in snapshots">
        <Input type="date" name="as_of" />
      </Field>
      <Field label="Source" hint="Where the file came from. Files from a source an admin has not approved are stored but quarantined.">
        <Select name="source_id" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}{s.approved ? "" : " (not approved)"}</option>)}
          <option value="new">New source…</option>
        </Select>
      </Field>
      {sourceId === "new" ? (
        <div className="space-y-4">
          <Field label="Source name"><Input name="source_name" placeholder="e.g. Research team export" required /></Field>
          <Field label="Kind">
            <Select name="source_kind" defaultValue="export">
              <option value="folder">Shared folder</option><option value="export">System export</option><option value="email">Email attachment</option>
              <option value="connector">Connector</option><option value="other">Other</option>
            </Select>
          </Field>
        </div>
      ) : null}
      <MoreFields>
        <Field label="Period year" hint="For trackers without dates">
          <Input type="number" name="period_year" min={1990} max={2100} placeholder="e.g. 2023" />
        </Field>
        <Field label="Classification">
          <Select name="classification" defaultValue="corporate_confidential">
            <option value="corporate_confidential">Corporate confidential</option>
            <option value="licensed_restricted">Licensed / restricted</option>
            <option value="public">Public</option>
          </Select>
        </Field>
      </MoreFields>
      <Button type="submit" disabled={busy} className="w-full">{busy ? "Working…" : "Upload and reconcile"}</Button>
      {msg ? <p className="text-sm text-ink-soft" role="status">{msg}</p> : null}
    </form>
  );
}

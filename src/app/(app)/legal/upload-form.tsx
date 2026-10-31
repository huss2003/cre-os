"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { LinkFields, type LinkOptions } from "./link-fields";

/** Upload a PDF / DOCX to POST /api/v1/legal/documents/upload (Idempotency-Key per attempt), then open the stored version. */
export function LegalUploadForm({ options }: { options: LinkOptions }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) { setMsg("Choose a PDF or Word file first."); return; }
    setBusy(true);
    setMsg("Uploading, extracting text and clauses…");
    try {
      const res = await fetch("/api/v1/legal/documents/upload", { method: "POST", body: form, headers: { "Idempotency-Key": crypto.randomUUID() } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(body.error ?? `Upload failed (${res.status})`); return; }
      const id = body.document?.id;
      const note = body.duplicate ? "Identical content already stored — showing the existing version." : body.ocrNeeded ? "Stored. No text layer found — OCR is needed before clauses can be extracted." : `Version ${body.document?.version} stored; ${body.clauseCount ?? 0} clause(s) extracted. Check each against the original.`;
      router.push(`/legal/${id}?notice=${encodeURIComponent(note)}`);
      router.refresh();
    } catch {
      setMsg("Network error — the upload may not have reached the server. Re-uploading the same file is safe.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Field label="File" hint="PDF with a text layer, Word .docx or .txt — up to 20 MB. The original is kept read-only.">
        <Input type="file" name="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Title"><Input name="title" required minLength={2} maxLength={200} placeholder="Acme Baner LOI" /></Field>
        <Field label="Kind"><Select name="doc_kind" defaultValue="loi"><option value="loi">LOI</option><option value="term_sheet">Term sheet</option><option value="lease">Lease</option><option value="amendment">Amendment</option><option value="other">Other</option></Select></Field>
      </div>
      <Field label="Family key" hint="Same key = new version of the same document. Blank = derived from the title."><Input name="family_key" maxLength={120} /></Field>
      <LinkFields options={options} />
      <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy ? "Working…" : "Upload & extract clauses"}</Button>
      {msg ? <p className="text-sm text-ink-soft" role="status">{msg}</p> : null}
    </form>
  );
}

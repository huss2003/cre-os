"use client";
import { useId, useState, type ReactNode } from "react";
import { Input, Select } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { updateBriefFieldAction } from "@/modules/toolkit/actions-core";
import type { BriefField } from "@/modules/toolkit/brief";

export interface EditCtx { requirementId: string; rowVersion: number; canEdit: boolean }

const placeholderFor = (key: string) => (key === "area" || key === "seats" ? "min, target, max" : key === "budget" ? "min, max" : "");

/** Compact edit form for one brief field (same fields/behaviour as before: value, how sure, evidence). */
export function FieldForm({ f, ctx, onDone }: { f: BriefField; ctx: EditCtx; onDone?: () => void }) {
  return (
    <ActionForm action={updateBriefFieldAction} className="mt-2 grid gap-2 rounded-lg border border-line bg-canvas p-3 sm:grid-cols-[1fr_13rem]">
      <input type="hidden" name="requirement_id" value={ctx.requirementId} />
      <input type="hidden" name="row_version" value={ctx.rowVersion} />
      <input type="hidden" name="key" value={f.key} />
      <Input name="value" defaultValue={f.value ?? ""} placeholder={placeholderFor(f.key)} aria-label={f.label} autoFocus />
      <Select name="status" defaultValue={f.status === "Assumption" ? "reported" : "estimated"} aria-label="How sure">
        <option value="estimated">Estimated (our estimate)</option>
        <option value="reported">Assumption (heard second-hand)</option>
        <option value="client_confirmed">Confirmed by client — needs approval</option>
      </Select>
      <Input name="evidence" placeholder="If confirmed: how (meeting date, email reference)" className="sm:col-span-2" />
      <div className="flex gap-2">
        <Submit variant="secondary">Save</Submit>
        {onDone && <button type="button" onClick={onDone} className="rounded px-2 text-xs text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>}
      </div>
    </ActionForm>
  );
}

/** Click the value to edit it inline. Viewers just see the value. */
export function EditableValue({ f, ctx, children, className = "" }: { f: BriefField; ctx: EditCtx; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!ctx.canEdit || !f.editable) return <div className={className}>{children}</div>;
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        title={`Edit ${f.label}`}
        className="group -mx-1 block w-[calc(100%+0.5rem)] rounded px-1 text-left hover:bg-brand-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        {children}
        <span className="sr-only"> — edit {f.label}</span>
      </button>
      {open && <div id={id}><FieldForm f={f} ctx={ctx} onDone={() => setOpen(false)} /></div>}
    </div>
  );
}

/** One quiet line: "Missing (n): a, b, c — Add" that expands to inline editors. */
export function MissingLine({ fields, ctx }: { fields: BriefField[]; ctx: EditCtx }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (fields.length === 0) return null;
  return (
    <div className="mt-5 border-t border-dashed border-line pt-3 text-sm">
      <p className="flex flex-wrap items-baseline gap-x-2 text-ink-soft">
        <span className="inline-block size-2 shrink-0 rounded-full border border-ink-soft/60" aria-hidden />
        <span className="font-medium text-ink">Missing ({fields.length}):</span>
        <span className="min-w-0 flex-1">{fields.map((f) => f.label).join(", ")}</span>
        {ctx.canEdit && (
          <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
            className="font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            {open ? "Close" : "Add"}
          </button>
        )}
      </p>
      {open && (
        <div id={id} className="mt-3 space-y-4">
          {fields.map((f) => (
            <div key={f.key}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">{f.label}</p>
              <FieldForm f={f} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";
import { useId, useState, type ReactNode } from "react";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { updateBriefFieldAction } from "@/modules/toolkit/actions-core";
import type { BriefField } from "@/modules/toolkit/brief";
import { Field, btn, inputCls } from "@/modules/toolkit/ui/kit";

export interface EditCtx { requirementId: string; rowVersion: number; canEdit: boolean }

const placeholderFor = (key: string) => (key === "area" || key === "seats" ? "min, target, max" : key === "budget" ? "min, max" : "");

/** Compact edit form for one brief field (same fields/behaviour as before: value, how sure, evidence). */
export function FieldForm({ f, ctx, onDone }: { f: BriefField; ctx: EditCtx; onDone?: () => void }) {
  const uid = useId();
  return (
    <ActionForm action={updateBriefFieldAction} className="mt-2 grid gap-3 rounded-lg border border-line bg-canvas p-3 sm:grid-cols-[1fr_15rem]">
      <input type="hidden" name="requirement_id" value={ctx.requirementId} />
      <input type="hidden" name="row_version" value={ctx.rowVersion} />
      <input type="hidden" name="key" value={f.key} />
      <Field label={f.label} htmlFor={`${uid}-v`} required hint={placeholderFor(f.key) ? `Enter as: ${placeholderFor(f.key)}` : undefined}>
        <input id={`${uid}-v`} name="value" defaultValue={f.value ?? ""} placeholder={placeholderFor(f.key)} className={inputCls} autoFocus />
      </Field>
      <Field label="How sure are you?" htmlFor={`${uid}-s`} required>
        <select id={`${uid}-s`} name="status" defaultValue={f.status === "Assumption" ? "reported" : "estimated"} className={inputCls}>
          <option value="estimated">Estimated (our estimate)</option>
          <option value="reported">Assumption (heard second-hand)</option>
          <option value="client_confirmed">Confirmed by client — needs approval</option>
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Evidence" htmlFor={`${uid}-e`} hint="If confirmed: how — meeting date or email reference.">
          <input id={`${uid}-e`} name="evidence" placeholder="e.g. Call with CFO, 3 Nov" className={inputCls} />
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Submit>Save</Submit>
        {onDone && <button type="button" onClick={onDone} className={btn.secondary}>Cancel</button>}
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
        className="group -mx-1 block min-h-11 w-[calc(100%+0.5rem)] rounded px-1 text-left hover:bg-brand-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
        <span className="flex items-start justify-between gap-2"><span className="min-w-0 flex-1">{children}</span><span aria-hidden className="shrink-0 pt-0.5 text-xs font-medium text-brand opacity-70 group-hover:opacity-100">✎ Edit</span></span>
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
            className={open ? btn.secondary : btn.primary}>
            {open ? "Close" : "✎ Fill these in"}
          </button>
        )}
      </p>
      {open && (
        <div id={id} className="mt-3 space-y-4">
          {fields.map((f) => (
            <div key={f.key}>
              <FieldForm f={f} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

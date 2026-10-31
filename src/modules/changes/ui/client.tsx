"use client";
import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui";

export type ActionState = { ok?: boolean; error?: string; message?: string; details?: string[] } | null;
export type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** Form bound to a server action with inline result (used by /capture and /approvals). */
export function ActionForm({ action, children, className, id }: { action: FormAction; children: ReactNode; className?: string; id?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form id={id} action={formAction} className={className}>
      {children}
      <Result state={state} />
    </form>
  );
}

export function Result({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div className="mt-2 space-y-1 text-sm" role="status" aria-live="polite">
      {state.error ? <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-bad">{state.error}</p> : null}
      {state.message ? <p className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-ok">{state.message}</p> : null}
      {state.details?.length ? <ul className="list-disc pl-5 text-ink-soft">{state.details.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
    </div>
  );
}

export function Submit({ children, variant = "primary", confirm, name, value, className }: {
  children: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; confirm?: string; name?: string; value?: string; className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} name={name} value={value} className={className}
      onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}>
      {pending ? "Working…" : children}
    </Button>
  );
}

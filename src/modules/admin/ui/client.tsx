"use client";
import { createContext, startTransition, useActionState, useContext, useState, type ReactNode } from "react";

const PendingCtx = createContext<boolean | null>(null);
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui";

export type ActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Shown once (temp password / invite link). CRE OS never emails it (rule S3). */
  secret?: { label: string; value: string };
} | null;

export type FormAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** Form bound to a server action; shows the result inline (errors, confirmations, one-time secrets). */
export function ActionForm({ action, children, className }: { action: FormAction; children: ReactNode; className?: string }) {
  const [state, formAction, isPending] = useActionState(action, null);
  // Submit manually so React does not reset the form: a failed save keeps everything the user typed.
  return (
    <form className={className} onSubmit={(e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const sub = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      if (sub?.name) fd.set(sub.name, sub.value);
      startTransition(() => formAction(fd));
    }}>
      <PendingCtx.Provider value={isPending}>{children}</PendingCtx.Provider>
      <ActionResult state={state} />
    </form>
  );
}

export function ActionResult({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <div className="mt-3 space-y-2 text-sm" role="status" aria-live="polite">
      {state.error ? <p className="rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-bad">{state.error}</p> : null}
      {state.message ? <p className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-ok">{state.message}</p> : null}
      {state.secret ? (
        <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
          <p className="font-medium text-warn">{state.secret.label} — shown once; hand it over yourself (CRE OS sends nothing).</p>
          <code className="mt-1 block break-all rounded bg-surface px-2 py-1 text-xs text-ink">{state.secret.value}</code>
        </div>
      ) : null}
    </div>
  );
}

export function Submit({ children, variant = "primary", confirm, className, name, value }: {
  children: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; confirm?: string; className?: string; name?: string; value?: string;
}) {
  const ctxPending = useContext(PendingCtx);
  const { pending: formPending } = useFormStatus();
  const pending = ctxPending ?? formPending;
  return (
    <Button type="submit" variant={variant} disabled={pending} className={className} name={name} value={value}
      onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}>
      {pending ? "Working…" : children}
    </Button>
  );
}

/**
 * Template file picker: uploads straight to storage (<ws>/templates/...) with the signed-in user's session
 * (storage policy: editors may write under their workspace) and puts the path in a hidden field, so large
 * Office files never pass through the 1 MB server-action body limit. The server action re-validates the path.
 */
export function TemplateFileInput({ workspaceId }: { workspaceId: string }) {
  return <TemplateUploader workspaceId={workspaceId} />;
}


function TemplateUploader({ workspaceId }: { workspaceId: string }) {
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  return (
    <span className="block">
      <input type="file" accept=".pptx,.docx,.xlsx" className="block w-full text-sm" onChange={async (e) => {
        const file = e.target.files?.[0];
        setPath("");
        if (!file) return;
        const ext = file.name.toLowerCase().split(".").pop();
        if (!ext || !["pptx", "docx", "xlsx"].includes(ext)) { setStatus("Choose a .pptx, .docx or .xlsx file."); return; }
        if (file.size > 25 * 1024 * 1024) { setStatus("File is larger than 25 MB."); return; }
        setStatus("Uploading…");
        const safe = file.name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
        const p = `${workspaceId}/templates/${crypto.randomUUID()}-${safe}`;
        const { error } = await createBrowserSupabase().storage.from("mudar-workspace-files").upload(p, file, { upsert: false, contentType: file.type || undefined });
        if (error) { setStatus(`Upload failed: ${error.message}`); return; }
        setPath(p);
        setStatus("Uploaded — save to attach it.");
      }} />
      <input type="hidden" name="storage_path" value={path} />
      {status ? <span className="mt-1 block text-xs text-ink-soft">{status}</span> : null}
    </span>
  );
}

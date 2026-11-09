"use client";
import { useActionState, useState } from "react";
import type { ActionState } from "@/modules/admin/ui/client";

/** Hand-off: confirm exact recipient + text, then open the user's own app. CRE OS never sends. */
export function SendPanel({ action, sent, hash, to, text }: { action: (p: ActionState, f: FormData) => Promise<ActionState>; sent: (p: ActionState) => Promise<ActionState>; hash: string; to: string; text: string }) {
  const [st, run, pending] = useActionState(action, null);
  const [st2, mark, pending2] = useActionState(sent, null);
  const [copied, setCopied] = useState(false);
  const href = st?.message?.startsWith("OPEN:") ? st.message.slice(5) : null;
  return (
    <div className="space-y-3">
      <form action={run} className="space-y-2 text-sm">
        <input type="hidden" name="hash" value={hash} />
        <label className="flex items-start gap-2"><input type="checkbox" name="ok_to" value="1" className="mt-1" /> <span>Recipient is correct: <b>{to || "no address saved — you'll add it in your app"}</b></span></label>
        <label className="flex items-start gap-2"><input type="checkbox" name="ok_text" value="1" className="mt-1" /> <span>The text is exactly what I want to send</span></label>
        <button disabled={pending} className="min-h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Checking…" : "Check & open"}</button>
      </form>
      {st?.error ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{st.error}</p> : null}
      {st?.ok ? (
        <div className="space-y-2 rounded-xl bg-canvas p-3 text-sm">
          <p>Checked: not suppressed and unchanged since approval.</p>
          <div className="flex flex-wrap gap-2">
            {href ? <a href={href} target="_blank" rel="noreferrer noopener" className="min-h-10 rounded-xl bg-ink px-4 py-2 font-semibold text-white">Open in your app</a> : null}
            <button type="button" onClick={() => { navigator.clipboard?.writeText(text); setCopied(true); }} className="min-h-10 rounded-xl border border-line px-4">{copied ? "Copied" : "Copy text"}</button>
          </div>
          <p className="text-ink-soft">Send it yourself, then come back and press <b>I sent it</b>.</p>
        </div>
      ) : null}
      <form action={mark}><button disabled={pending2} className="min-h-10 rounded-xl border border-line bg-surface px-4 text-sm font-semibold">{pending2 ? "Saving…" : "I sent it"}</button></form>
      {st2?.error ? <p className="text-sm text-bad">{st2.error}</p> : st2?.message ? <p className="text-sm text-ok">{st2.message}</p> : null}
    </div>
  );
}

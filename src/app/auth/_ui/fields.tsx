"use client";
import { useState } from "react";
import { useFormStatus } from "react-dom";

const input =
  "mt-1.5 block h-11 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-soft/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

export function PasswordField({ name, label, autoComplete, minLength, hint }: { name: string; label: string; autoComplete: string; minLength?: number; hint?: string }) {
  const [show, setShow] = useState(false);
  const id = `f-${name}`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">{label}</label>
      <div className="relative">
        <input id={id} name={name} type={show ? "text" : "password"} required autoComplete={autoComplete} minLength={minLength}
          aria-describedby={hint ? `${id}-hint` : undefined} className={`${input} pr-20`} />
        <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-controls={id}
          className="absolute right-1 top-1/2 h-9 -translate-y-1/2 rounded-md px-3 text-sm font-medium text-brand hover:bg-brand-soft focus-visible:outline-2 focus-visible:outline-brand">
          {show ? "Hide" : "Show"}<span className="sr-only"> password</span>
        </button>
      </div>
      {hint ? <p id={`${id}-hint`} className="mt-1 text-xs text-ink-soft">{hint}</p> : null}
    </div>
  );
}

export function TextField({ name, label, type = "text", autoComplete, defaultValue }: { name: string; label: string; type?: string; autoComplete?: string; defaultValue?: string }) {
  return (
    <div>
      <label htmlFor={`f-${name}`} className="block text-sm font-medium text-ink">{label}</label>
      <input id={`f-${name}`} name={name} type={type} required autoComplete={autoComplete} defaultValue={defaultValue} className={input} />
    </div>
  );
}

export function SubmitButton({ children, pending }: { children: React.ReactNode; pending: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button type="submit" disabled={busy} aria-disabled={busy}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand font-medium text-white transition-colors hover:bg-brand-strong disabled:cursor-wait disabled:opacity-80 motion-reduce:transition-none">
      {busy ? <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" /> : null}
      {busy ? pending : children}
    </button>
  );
}

/** Live-checks new password strength + match (server re-validates). */
export function NewPasswordFields() {
  const [pw, setPw] = useState("");
  const [cf, setCf] = useState("");
  const [show, setShow] = useState(false);
  const score = [pw.length >= 8, pw.length >= 12, /[A-Z]/.test(pw) && /[a-z]/.test(pw), /\d/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length;
  const label = pw.length === 0 ? "At least 8 characters. Longer is stronger." : pw.length < 8 ? "Too short: use at least 8 characters." : score <= 2 ? "Weak: add length, numbers or symbols." : score <= 3 ? "Okay." : "Strong.";
  const mismatch = cf.length > 0 && cf !== pw;
  const t = show ? "text" : "password";
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="f-password" className="block text-sm font-medium text-ink">New password</label>
        <div className="relative">
          <input id="f-password" name="password" type={t} required minLength={8} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)}
            aria-describedby="pw-hint" className={`${input} pr-20`} />
          <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
            className="absolute right-1 top-1/2 h-9 -translate-y-1/2 rounded-md px-3 text-sm font-medium text-brand hover:bg-brand-soft">
            {show ? "Hide" : "Show"}<span className="sr-only"> passwords</span>
          </button>
        </div>
        <div className="mt-2 flex gap-1" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1 flex-1 rounded-full ${i < score ? (score <= 2 ? "bg-bad" : score <= 3 ? "bg-warn" : "bg-ok") : "bg-line"}`} />
          ))}
        </div>
        <p id="pw-hint" aria-live="polite" className="mt-1 text-xs text-ink-soft">{label}</p>
      </div>
      <div>
        <label htmlFor="f-confirm" className="block text-sm font-medium text-ink">Confirm new password</label>
        <input id="f-confirm" name="confirm" type={t} required minLength={8} autoComplete="new-password" value={cf} onChange={(e) => setCf(e.target.value)}
          aria-invalid={mismatch} aria-describedby="cf-hint" className={input} />
        <p id="cf-hint" aria-live="polite" className={`mt-1 text-xs ${mismatch ? "text-bad" : "text-ink-soft"}`}>{mismatch ? "Passwords don't match yet." : " "}</p>
      </div>
    </div>
  );
}

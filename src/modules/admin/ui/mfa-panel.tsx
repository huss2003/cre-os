"use client";
import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { Badge, Button, Field, Input } from "@/components/ui";

type Factor = { id: string; friendly_name?: string | null; factor_type: string; status: string; created_at: string };

/**
 * TOTP enrolment / step-up / removal (spec §14 MFA). Uses Supabase Auth MFA from the browser so the session
 * cookie is upgraded to AAL2; admin pages and APIs then accept the session (guard.ts).
 */
export function MfaPanel({ next, mode, privileged }: { next?: string | null; mode?: "verify" | "enrol" | null; privileged: boolean }) {
  const [sb] = useState(() => createBrowserSupabase());
  const [factors, setFactors] = useState<Factor[]>([]);
  const [aal, setAal] = useState<{ current: string | null; next: string | null }>({ current: null, next: null });
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [{ data: f }, { data: a }] = await Promise.all([sb.auth.mfa.listFactors(), sb.auth.mfa.getAuthenticatorAssuranceLevel()]);
    setFactors(((f?.all ?? []) as Factor[]).filter((x) => x.factor_type === "totp"));
    setAal({ current: a?.currentLevel ?? null, next: a?.nextLevel ?? null });
  }, [sb]);
  useEffect(() => {
    let live = true;
    Promise.all([sb.auth.mfa.listFactors(), sb.auth.mfa.getAuthenticatorAssuranceLevel()]).then(([{ data: f }, { data: a }]) => {
      if (!live) return;
      setFactors(((f?.all ?? []) as Factor[]).filter((x) => x.factor_type === "totp"));
      setAal({ current: a?.currentLevel ?? null, next: a?.nextLevel ?? null });
    });
    return () => { live = false; };
  }, [sb]);

  const verified = factors.filter((f) => f.status === "verified");
  const goNext = () => { if (next && next.startsWith("/") && !next.startsWith("//")) window.location.assign(next); else window.location.reload(); };

  async function startEnrol() {
    setBusy(true); setMsg(null);
    // clear abandoned unverified factors first so enrolment never gets stuck
    for (const f of factors.filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (error || !data) { setMsg({ tone: "bad", text: error?.message ?? "could not start enrolment" }); return; }
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function verify(factorId: string) {
    setBusy(true); setMsg(null);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, "") });
    setBusy(false);
    if (error) { setMsg({ tone: "bad", text: `Code not accepted: ${error.message}` }); return; }
    setEnrolling(null); setCode("");
    setMsg({ tone: "ok", text: "Verified. This session is now at the higher assurance level (AAL2)." });
    await refresh();
    if (next) goNext();
  }

  async function remove(factorId: string) {
    if (!window.confirm(privileged ? "Owners must keep MFA. Remove this authenticator anyway?" : "Remove this authenticator?")) return;
    setBusy(true); setMsg(null);
    const { error } = await sb.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (error) { setMsg({ tone: "bad", text: `${error.message}${aal.current !== "aal2" ? " — verify with a code first." : ""}` }); return; }
    await sb.auth.refreshSession();
    setMsg({ tone: "ok", text: "Authenticator removed." });
    await refresh();
  }

  return (
    <div className="space-y-4 text-sm">
      {mode === "verify" ? <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-warn">Enter a code from your authenticator app to continue to the admin page.</p> : null}
      {mode === "enrol" ? <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-warn">Owners must set up an authenticator app before using admin pages.</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <span>Session assurance:</span>
        <Badge tone={aal.current === "aal2" ? "ok" : "warn"}>{aal.current === "aal2" ? "AAL2 (MFA verified)" : "AAL1 (password only)"}</Badge>
        {verified.length ? <Badge tone="ok">{verified.length} authenticator{verified.length > 1 ? "s" : ""}</Badge> : <Badge tone={privileged ? "bad" : "neutral"}>no authenticator</Badge>}
      </div>

      {verified.length > 0 && aal.current !== "aal2" ? (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <Field label="6-digit code"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} /></Field>
          <Button disabled={busy || code.length < 6} onClick={() => verify(verified[0].id)}>Verify</Button>
        </div>
      ) : null}

      {verified.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {verified.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 p-3">
              <span>{f.friendly_name ?? "Authenticator"} <span className="text-xs text-ink-soft">added {new Date(f.created_at).toLocaleDateString("en-IN")}</span></span>
              <Button variant="ghost" disabled={busy} onClick={() => remove(f.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : null}

      {enrolling ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <p>Scan this QR code with Google Authenticator, Microsoft Authenticator, 1Password or similar, then enter the code it shows.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrolling.qr} alt="TOTP QR code" className="h-48 w-48 rounded bg-white p-2" />
          <p className="text-xs text-ink-soft">Can&apos;t scan? Enter this key: <code className="break-all">{enrolling.secret}</code></p>
          <Field label="6-digit code"><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} /></Field>
          <div className="flex gap-2">
            <Button disabled={busy || code.length < 6} onClick={() => verify(enrolling.id)}>Confirm</Button>
            <Button variant="secondary" disabled={busy} onClick={async () => { await sb.auth.mfa.unenroll({ factorId: enrolling.id }); setEnrolling(null); await refresh(); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant={verified.length ? "secondary" : "primary"} disabled={busy} onClick={startEnrol}>{verified.length ? "Add another authenticator" : "Set up authenticator app"}</Button>
      )}

      {msg ? <p className={msg.tone === "ok" ? "text-ok" : "text-bad"} role="status">{msg.text}</p> : null}
      {next && aal.current === "aal2" ? <Button variant="secondary" onClick={goNext}>Continue</Button> : null}
    </div>
  );
}

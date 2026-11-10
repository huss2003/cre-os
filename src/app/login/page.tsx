import Link from "next/link";
import { signIn } from "./actions";
import { AuthShell, Notice } from "@/app/auth/_ui/shell";
import { PasswordField, SubmitButton, TextField } from "@/app/auth/_ui/fields";
import { safeNext } from "@/lib/util/safe-redirect";

export const metadata = { title: "Sign in" };

function friendly(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return "That email and password don't match. Check for typos or reset your password.";
  if (/email not confirmed/i.test(msg)) return "Your email address hasn't been confirmed yet. Open the confirmation link we emailed you, or ask your administrator to resend the invite.";
  if (/rate limit|too many/i.test(msg)) return "Too many attempts. Wait a minute and try again.";
  return msg;
}

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next, "/");
  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-ink">Sign in</h1>
      <p className="mb-5 mt-1 text-sm text-ink-soft">Welcome back. Sign in to your workspace.</p>
      {sp.error ? <Notice tone="error">{friendly(sp.error)}</Notice> : null}
      {sp.notice ? <Notice tone="ok">{sp.notice}</Notice> : null}
      <form action={signIn} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        <TextField name="email" label="Email" type="email" autoComplete="email" />
        <PasswordField name="password" label="Password" autoComplete="current-password" />
        <div className="flex justify-end">
          <Link href="/auth/forgot" className="rounded text-sm font-medium text-brand hover:underline">Forgot password?</Link>
        </div>
        <SubmitButton pending="Signing in…">Sign in</SubmitButton>
      </form>
      <p className="mt-4 text-xs text-ink-soft"></p>
    </AuthShell>
  );
}

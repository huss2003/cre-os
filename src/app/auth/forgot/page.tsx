import Link from "next/link";
import { requestReset } from "./actions";
import { AuthShell, Notice } from "../_ui/shell";
import { SubmitButton, TextField } from "../_ui/fields";

export const metadata = { title: "Reset password" };

export default async function Forgot({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const sp = await searchParams;
  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-ink">Reset your password</h1>
      {sp.sent ? (
        <>
          <Notice tone="ok">If an account exists for that email, we&apos;ve sent a reset link. It can take a few minutes; check spam too.</Notice>
          <p className="text-sm text-ink-soft">The link works once and expires after a short time.</p>
        </>
      ) : (
        <>
          <p className="mb-5 mt-1 text-sm text-ink-soft">Enter your work email and we&apos;ll send you a link to choose a new password.</p>
          <form action={requestReset} className="space-y-4">
            <TextField name="email" label="Email" type="email" autoComplete="email" />
            <SubmitButton pending="Sending…">Send reset link</SubmitButton>
          </form>
        </>
      )}
      <p className="mt-5 text-sm"><Link href="/login" className="rounded font-medium text-brand hover:underline">Back to sign in</Link></p>
    </AuthShell>
  );
}

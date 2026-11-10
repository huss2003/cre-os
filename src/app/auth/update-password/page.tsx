import Link from "next/link";
import { createUserClient } from "@/lib/supabase/server";
import { updatePassword } from "./actions";
import { AuthShell, Notice } from "../_ui/shell";
import { NewPasswordFields, SubmitButton } from "../_ui/fields";

export const metadata = { title: "Choose a new password" };

export default async function UpdatePassword({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-ink">Choose a new password</h1>
      {!data.user ? (
        <>
          <Notice tone="error">This page needs a valid reset link. Your link may have expired or already been used.</Notice>
          <Link href="/auth/forgot" className="flex h-11 w-full items-center justify-center rounded-lg bg-brand font-medium text-white hover:bg-brand-strong">Send a new reset link</Link>
        </>
      ) : (
        <>
          <p className="mb-5 mt-1 text-sm text-ink-soft">For {data.user.email}</p>
          {sp.error ? <Notice tone="error">{sp.error}</Notice> : null}
          <form action={updatePassword} className="space-y-5">
            <NewPasswordFields />
            <SubmitButton pending="Saving…">Save new password</SubmitButton>
          </form>
        </>
      )}
    </AuthShell>
  );
}

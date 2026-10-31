import { signIn } from "./actions";

export const metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <form action={signIn} className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl">
        <h1 className="text-xl font-semibold">CRE OS</h1>
        <p className="mb-5 text-sm text-ink-soft">Sign in to your workspace</p>
        <input type="hidden" name="next" value={sp.next ?? "/today"} />
        <label className="mb-3 block text-sm">Email
          <input name="email" type="email" required autoComplete="email" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="mb-4 block text-sm">Password
          <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded-lg border border-line px-3 py-2" />
        </label>
        {sp.error ? <p className="mb-3 text-sm text-bad">{sp.error}</p> : null}
        <button className="w-full rounded-lg bg-brand py-2.5 font-medium text-white">Sign in</button>
        <p className="mt-4 text-xs text-ink-soft">Accounts are created by your administrator. Multi-factor sign-in is required for owners.</p>
      </form>
    </div>
  );
}

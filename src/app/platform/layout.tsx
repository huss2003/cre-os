import Link from "next/link";

/** Platform (agency) console. Outside the tenant shell: platform admins may have no workspace membership. */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-ink px-4 py-3 text-white">
        <Link href="/platform" className="font-semibold">CRE OS · Platform</Link>
        <nav className="flex gap-3 text-sm text-white/80">
          <Link href="/platform/security">MFA</Link>
          <Link href="/today">Workbench</Link>
          <form action="/auth/signout" method="post"><button className="hover:text-white">Sign out</button></form>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">{children}</main>
    </div>
  );
}

import Link from "next/link";

const LINKS: [string, string][] = [
  ["/settings", "General"], ["/settings/members", "Members"], ["/settings/partners", "Partners"], ["/settings/templates", "Templates"],
  ["/settings/sources", "Licensed sources"], ["/settings/lanes", "Data lanes"], ["/settings/retention", "Retention"],
  ["/settings/ai", "AI use"], ["/settings/security", "Security & MFA"], ["/settings/connections", "Connections"],
];

export function SettingsNav({ current }: { current: string }) {
  return (
    <nav className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1 text-sm" aria-label="Settings">
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined}
          className={`shrink-0 rounded-full border px-3 py-1.5 ${href === current ? "border-brand bg-brand text-white" : "border-line bg-surface text-ink"}`}>{label}</Link>
      ))}
    </nav>
  );
}

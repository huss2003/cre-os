import { Badge } from "@/components/ui";

/** Flash message from server-action redirects (?msg= / ?err=). */
export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const msg = typeof sp.msg === "string" ? sp.msg : null;
  const err = typeof sp.err === "string" ? sp.err : null;
  if (!msg && !err) return null;
  return (
    <div role="status" className={`mb-4 rounded-lg border px-3 py-2 text-sm ${err ? "border-bad/30 bg-bad/10 text-bad" : "border-ok/30 bg-ok/10 text-ok"}`}>
      {err ?? msg}
    </div>
  );
}

export function FieldStatusBadge({ status }: { status: string }) {
  if (status === "client_confirmed") return <Badge tone="ok" title="Confirmed client instruction">Client-confirmed</Badge>;
  if (status === "reported") return <Badge tone="brand" title="Stated second-hand — not a client instruction">Reported</Badge>;
  if (status === "estimated") return <Badge tone="warn" title="Our estimate — not a client instruction">Estimated</Badge>;
  if (status === "config") return <Badge title="Adviser matching configuration">Config</Badge>;
  return <Badge>Unknown</Badge>;
}

export function RequirementStatusBadge({ status }: { status: string }) {
  const map: Record<string, ["ok" | "warn" | "neutral" | "brand", string]> = {
    client_confirmed: ["ok", "Client confirmed"], estimated: ["warn", "Estimated"], draft: ["neutral", "Draft"], closed: ["brand", "Closed"],
  };
  const [t, l] = map[status] ?? ["neutral", status];
  return <Badge tone={t}>{l}</Badge>;
}

export function EligibilityBadge({ e }: { e: string }) {
  if (e === "eligible") return <Badge tone="ok">Eligible</Badge>;
  if (e === "needs_verification") return <Badge tone="warn">Needs verification</Badge>;
  return <Badge tone="bad">Ineligible</Badge>;
}

export function DocStatusBadge({ s }: { s: string }) {
  const map: Record<string, "ok" | "warn" | "bad" | "neutral" | "brand"> = { draft: "neutral", in_review: "brand", approved: "ok", released: "ok", stale: "bad" };
  return <Badge tone={map[s] ?? "neutral"}>{s === "stale" ? "Stale — regenerate" : s.replace("_", " ")}</Badge>;
}

/** Small label/value grid that stacks on mobile. */
export function KV({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-line/60 pb-1 sm:block">
          <dt className="text-ink-soft">{k}</dt>
          <dd className="text-right font-medium sm:text-left">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export const nonce = () => Math.random().toString(36).slice(2);

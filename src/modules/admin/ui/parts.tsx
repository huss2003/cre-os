import { Help } from "@/components/ui";
import { helpFor } from "@/components/ui/help-text";
import type { ReactNode } from "react";
import { Badge, FactBadge } from "@/components/ui";
import type { TrailItem } from "../entities";

/* Server-renderable display helpers shared by admin pages. */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="animate-pulse rounded-xl border border-line bg-surface p-6 text-sm text-ink-soft">{label}</div>;
}

const CLASS_LABEL: Record<string, [string, "neutral" | "brand" | "warn" | "bad"]> = {
  public: ["Public", "neutral"],
  permitted_personal: ["Permitted personal", "brand"],
  corporate_confidential: ["Corporate confidential", "warn"],
  licensed_restricted: ["Licensed restricted", "bad"],
};
export function ClassBadge({ value }: { value?: string | null }) {
  const [label, tone] = CLASS_LABEL[value ?? ""] ?? [value ?? "—", "neutral"];
  return <Badge tone={tone} title="Classification">{label}</Badge>;
}

export function TierBadge({ tier }: { tier?: string | null }) {
  if (!tier) return null;
  return <Badge tone="brand" title="Evidence tier">Tier {tier}</Badge>;
}

export function fmtDate(v?: string | null, withTime = false) {
  if (!v) return "—";
  const d = new Date(v.length === 10 ? `${v}T00:00:00+05:30` : v);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(d);
}

export function Unknown({ children }: { children?: ReactNode }) {
  return <span className="text-ink-soft italic">{children ?? "unknown"}</span>;
}

/** Definition list that keeps unknown visibly unknown (rule S6). */
export function Facts({ items }: { items: [string, ReactNode | null | undefined][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-ink-soft">{k}</dt>
          <dd className="break-words">{v === null || v === undefined || v === "" ? <Unknown /> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EvidenceTrail({ items, asOf }: { items: TrailItem[]; asOf?: string | null }) {
  if (!items.length) {
    return <p className="text-sm text-ink-soft">No evidence recorded{asOf ? ` on or before ${fmtDate(asOf)}` : ""} yet. Captures, imports, interactions and approved changes will appear here.</p>;
  }
  return (
    <ol className="space-y-3">
      {items.slice(0, 100).map((t, i) => (
        <li key={i} className="border-l-2 border-line pl-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
            <span>{fmtDate(t.at, t.kind === "audit" || t.kind === "interaction")}</span>
            <Badge>{t.kind}</Badge>
            {t.factStatus ? <FactBadge status={t.factStatus} /> : null}
            <TierBadge tier={t.evidenceTier} />
          </div>
          <div className="text-sm font-medium">{t.href ? <a className="text-brand underline" href={t.href}>{t.title}</a> : t.title}</div>
          {t.detail ? <p className="text-sm text-ink-soft">{t.detail}</p> : null}
          {t.source ? <p className="truncate text-xs text-ink-soft">Source: {/^https?:\/\//.test(t.source) ? <a className="underline" href={t.source} rel="noreferrer noopener" target="_blank">{t.source}</a> : t.source}</p> : null}
        </li>
      ))}
    </ol>
  );
}

/** GET form that sets ?as_of= on the current page. */
export function AsOfForm({ asOf, action }: { asOf?: string | null; action: string }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 text-sm">
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wide text-ink-soft">As of</span>
        <input type="date" name="as_of" defaultValue={asOf ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2" />
      </label>
      <button className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm">Apply</button>
      {asOf ? <a href={action} className="min-h-10 px-2 py-2 text-brand">Today</a> : null}
    </form>
  );
}

export function Section({ title, children, empty, actions, footer }: { title: string; children?: ReactNode; empty?: ReactNode; actions?: ReactNode; footer?: ReactNode }) {
  const hasContent = Array.isArray(children) ? children.some(Boolean) : !!children;
  return (
    <section className="rounded-2xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center text-base font-semibold">{title}{helpFor(title) ? <Help>{helpFor(title)}</Help> : null}</h2>
        {actions}
      </div>
      {hasContent ? children : <p className="text-sm text-ink-soft">{empty ?? "Nothing recorded yet."}</p>}
      {footer}
    </section>
  );
}

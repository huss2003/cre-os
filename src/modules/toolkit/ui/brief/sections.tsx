/**
 * Requirement brief presentation: one distinct layout per section (A–G). Pure display over the Brief built by
 * brief.ts — regroups contract fields by what a broker reads them for; no values are invented (S6) and money is only
 * reformatted, never computed (S5).
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { inr } from "@/components/ui";
import type { Brief, BriefField, BriefLabel } from "@/modules/toolkit/brief";
import { EditableValue, MissingLine, type EditCtx } from "./editor";

/* ---------- status language ---------- */
export const DOT: Record<BriefLabel, string> = {
  Confirmed: "bg-ok", Estimated: "bg-amber-500", Assumption: "bg-violet-500", Missing: "border border-ink-soft/60 bg-transparent", "Not applicable": "bg-line",
};
export const BAR: Record<BriefLabel, string> = { Confirmed: "bg-ok", Estimated: "bg-amber-400", Assumption: "bg-violet-400", Missing: "bg-transparent", "Not applicable": "bg-line" };
export function Status({ s, quiet = false }: { s: BriefLabel; quiet?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-soft">
      <span className={`inline-block size-2 rounded-full ${DOT[s]}`} aria-hidden />
      <span className={quiet ? "sr-only" : ""}>{s}</span>
    </span>
  );
}

/* ---------- section model ---------- */
export type SectionId = "A" | "B" | "C" | "D" | "E" | "F" | "G";
export const SECTION_META: { id: SectionId; title: string; short: string; blurb: string; keys: string[]; icon: ReactNode }[] = [
  { id: "A", title: "Client", short: "Client", blurb: "Who the client is, why they are moving and on what footing we act for them.", keys: ["objective", "transaction_kinds", "legal_entity", "mandate_status", "conflict_status"], icon: <path d="M4 20V8l8-4 8 4v12M9 20v-6h6v6" /> },
  { id: "B", title: "Space", short: "Space", blurb: "How much space, measured how, for how many people, built to what standard.", keys: ["area", "area_basis", "seats", "growth_assumption", "attendance_assumption", "fitout_standard", "power", "it_load", "certifications"], icon: <path d="M4 4h16v16H4zM4 12h16M12 4v16" /> },
  { id: "C", title: "Location", short: "Location", blurb: "Where the office can and cannot be, and how people will get there.", keys: ["preferred_locations", "forbidden_locations", "employee_catchments", "transit", "parking", "working_hours", "security_access"], icon: <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" /> },
  { id: "D", title: "Budget & terms", short: "Budget", blurb: "What the client will pay, on what basis, and for how long they commit.", keys: ["budget", "budget_basis", "budget_inclusions", "tenure_months", "lockin_months", "expansion", "capex_financing"], icon: <path d="M7 5h10M7 9h10M9 5c5 0 5 8 0 8H7l8 7" /> },
  { id: "E", title: "Timeline", short: "Timeline", blurb: "The dates the search has to land on, from today's lease to the decision.", keys: ["current_lease_notice", "occupation_date", "decision_date"], icon: <path d="M3 12h18M7 8v8M12 8v8M17 8v8" /> },
  { id: "F", title: "Approvals", short: "Approvals", blurb: "Who signs off, and how the client's buying process runs.", keys: ["commercial_authority", "procurement_process"], icon: <path d="M5 12l4 4L19 6" /> },
  { id: "G", title: "Assumptions & open questions", short: "Gaps", blurb: "Everything we know, guess or still need to ask — in one place.", keys: [], icon: <path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V15M12 18.5v.01" /> },
];

export function allFields(b: Brief) { return new Map(b.sections.flatMap((s) => s.fields).map((f) => [f.key, f])); }
export function sectionFields(b: Brief, id: SectionId) {
  const m = allFields(b);
  return (SECTION_META.find((s) => s.id === id)?.keys ?? []).map((k) => m.get(k)).filter(Boolean) as BriefField[];
}
/** "known/total" — N/A excluded from the total. */
export function completeness(fs: BriefField[]) {
  const rel = fs.filter((f) => f.status !== "Not applicable");
  return { known: rel.filter((f) => f.status !== "Missing").length, total: rel.length };
}

/** Parse formatValue's range string ("min: 1,200 · target: 1,500") back to numbers for display only. */
function rangeOf(v: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (v ?? "").split("·")) {
    const m = part.match(/(\w+):\s*([\d,.\-]+)/);
    if (m) { const n = Number(m[2].replace(/,/g, "")); if (Number.isFinite(n)) out[m[1]] = n; }
  }
  return out;
}
const n0 = (x: number) => x.toLocaleString("en-IN");

/* ---------- shell ---------- */
export function SectionIcon({ id, className = "size-4" }: { id: SectionId; className?: string }) {
  const meta = SECTION_META.find((s) => s.id === id)!;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>{meta.icon}</svg>;
}

export function SectionShell({ id, done, children }: { id: SectionId; done?: { known: number; total: number }; children: ReactNode }) {
  const meta = SECTION_META.find((s) => s.id === id)!;
  return (
    <section id={`sec-${id}`} aria-labelledby={`sec-${id}-h`} className="scroll-mt-24">
      <header className="flex items-start gap-3">
        <span className="mt-1 font-serif text-sm text-brand" aria-hidden>{id}</span>
        <div className="min-w-0 flex-1">
          <h2 id={`sec-${id}-h`} className="font-serif text-2xl leading-tight text-ink">{meta.title}</h2>
          <p className="mt-1 text-sm text-ink-soft">{meta.blurb}</p>
        </div>
        {done && <span className="mt-1.5 shrink-0 text-xs tabular-nums text-ink-soft">{done.known}/{done.total} known</span>}
      </header>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** Value with its status dot + label, click to edit. */
function Val({ f, ctx, big = false, fallback }: { f: BriefField; ctx: EditCtx; big?: boolean; fallback?: string }) {
  return (
    <EditableValue f={f} ctx={ctx}>
      <span className={`block ${big ? "text-xl font-semibold tracking-tight" : "text-[15px]"} ${f.value ? "text-ink" : "text-ink-soft"}`}>{f.value ?? fallback ?? "—"}</span>
      <Status s={f.status} />
    </EditableValue>
  );
}
const known = (fs: BriefField[]) => fs.filter((f) => f.status !== "Missing" && f.status !== "Not applicable");
const missing = (fs: BriefField[]) => fs.filter((f) => f.status === "Missing");
const na = (fs: BriefField[]) => fs.filter((f) => f.status === "Not applicable");
function NaLine({ fs }: { fs: BriefField[] }) {
  if (!fs.length) return null;
  return <p className="mt-3 text-xs text-ink-soft/80">Not applicable: {fs.map((f) => f.label).join(", ")}</p>;
}

/* ---------- A. Client ---------- */
function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?"; }
export function ClientSection({ brief, ctx }: { brief: Brief; ctx: EditCtx }) {
  const fs = sectionFields(brief, "A");
  const statusNote = brief.sections[0]?.notes?.find((n) => n.startsWith("Requirement status"));
  const people = brief.stakeholders.filter((s) => s.people.length);
  return (
    <SectionShell id="A" done={completeness(fs)}>
      <div className="grid gap-6 md:grid-cols-[1.1fr_1fr]">
        <div className="rounded-xl border border-line bg-surface p-5">
          <p className="text-xs uppercase tracking-[0.16em] text-ink-soft">Company</p>
          <p className="mt-1 font-serif text-xl text-ink">{brief.organisation ?? "No organisation linked"}</p>
          {statusNote && <p className="mt-1 text-xs text-ink-soft">{statusNote}</p>}
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
            {known(fs).map((f) => <div key={f.key}><dt className="text-xs text-ink-soft">{f.label}</dt><dd className="mt-0.5"><Val f={f} ctx={ctx} /></dd></div>)}
          </dl>
          <p className="mt-4 text-xs text-ink-soft">Industry and headcount live on the <Link className="underline" href={`/requirements/${brief.requirementId}`}>requirement</Link> and company pages.</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.16em] text-ink-soft">People</p>
          {people.length === 0 ? <p className="mt-2 text-sm text-ink-soft">No people linked yet. Add them with their role on the <Link className="text-brand underline" href={`/requirements/${brief.requirementId}`}>requirement page</Link>.</p> : (
            <ul className="mt-2 space-y-3">
              {people.map((s) => (
                <li key={s.slot}>
                  <p className="text-xs text-ink-soft">{s.slot}</p>
                  <ul className="mt-1 flex flex-wrap gap-2">{s.people.map((p, i) => (
                    <li key={`${p}-${i}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-3 text-sm">
                      <span className="grid size-6 place-items-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand-strong" aria-hidden>{initials(p)}</span>{p}
                    </li>))}</ul>
                </li>))}
            </ul>
          )}
        </div>
      </div>
      <NaLine fs={na(fs)} />
      <MissingLine fields={missing(fs)} ctx={ctx} />
    </SectionShell>
  );
}

/* ---------- B. Space ---------- */
function RangeBar({ r, unit }: { r: Record<string, number>; unit: string }) {
  const vals = [r.min, r.target, r.max].filter((x) => x !== undefined) as number[];
  if (!vals.length) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pos = (x: number) => `${((x - lo) / span) * 100}%`;
  return (
    <div className="mt-4" aria-hidden>
      <div className="relative h-1.5 rounded-full bg-line">
        {r.min !== undefined && r.max !== undefined && <div className="absolute inset-y-0 rounded-full bg-brand/30" style={{ left: pos(r.min), right: `calc(100% - ${pos(r.max)})` }} />}
        {r.target !== undefined && <div className="absolute -top-1 size-3.5 -translate-x-1/2 rounded-full border-2 border-surface bg-brand" style={{ left: vals.length === 1 ? "50%" : pos(r.target) }} />}
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-ink-soft">
        <span>{r.min !== undefined ? `min ${n0(r.min)}` : "min —"}</span>
        <span className="font-medium text-ink">{r.target !== undefined ? `target ${n0(r.target)} ${unit}` : ""}</span>
        <span>{r.max !== undefined ? `max ${n0(r.max)}` : "max —"}</span>
      </div>
    </div>
  );
}
function Tile({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={`rounded-xl border border-line bg-surface p-4 ${wide ? "sm:col-span-2" : ""}`}><p className="text-xs uppercase tracking-[0.14em] text-ink-soft">{label}</p><div className="mt-2">{children}</div></div>;
}
export function SpaceSection({ brief, ctx }: { brief: Brief; ctx: EditCtx }) {
  const fs = sectionFields(brief, "B");
  const g = new Map(fs.map((f) => [f.key, f]));
  const area = g.get("area"), basis = g.get("area_basis"), seats = g.get("seats");
  const basisText = basis?.value ? basis.value : "basis unknown";
  const isCarpet = /carpet/i.test(basis?.value ?? ""), isCharge = /charg|super|built/i.test(basis?.value ?? "");
  const others = known(fs).filter((f) => !["area", "area_basis", "seats"].includes(f.key));
  return (
    <SectionShell id="B" done={completeness(fs)}>
      <div className="grid gap-3 sm:grid-cols-2">
        {area && area.status !== "Missing" && area.status !== "Not applicable" && (
          <Tile label="Area (sf)" wide>
            <EditableValue f={area} ctx={ctx}>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xl font-semibold tracking-tight text-ink">{area.value}</span>
                <Status s={area.status} />
              </span>
              <RangeBar r={rangeOf(area.value)} unit="sf" />
            </EditableValue>
            <p className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className={`rounded-full border px-2 py-0.5 ${isCarpet ? "border-brand text-brand" : "border-line text-ink-soft"}`}>Carpet</span>
              <span className={`rounded-full border px-2 py-0.5 ${isCharge ? "border-brand text-brand" : "border-line text-ink-soft"}`}>Chargeable</span>
              <span className="self-center text-ink-soft">Measured on: <strong className="font-medium text-ink">{basisText}</strong></span>
            </p>
          </Tile>
        )}
        {basis && basis.status !== "Missing" && basis.status !== "Not applicable" && <Tile label="Area basis"><Val f={basis} ctx={ctx} big /></Tile>}
        {seats && seats.status !== "Missing" && seats.status !== "Not applicable" && (
          <Tile label="Seats"><EditableValue f={seats} ctx={ctx}><span className="flex items-baseline gap-3"><span className="text-xl font-semibold text-ink">{rangeOf(seats.value).target !== undefined ? n0(rangeOf(seats.value).target) : seats.value}</span><Status s={seats.status} /></span>
            {rangeOf(seats.value).target !== undefined && <span className="mt-1 block text-xs text-ink-soft">{seats.value}</span>}</EditableValue></Tile>
        )}
        {others.map((f) => <Tile key={f.key} label={f.label}><Val f={f} ctx={ctx} /></Tile>)}
      </div>
      <NaLine fs={na(fs)} />
      <MissingLine fields={missing(fs)} ctx={ctx} />
    </SectionShell>
  );
}

/* ---------- C. Location ---------- */
export function LocationSection({ brief, ctx }: { brief: Brief; ctx: EditCtx }) {
  const fs = sectionFields(brief, "C");
  const g = new Map(fs.map((f) => [f.key, f]));
  const chips = (f: BriefField | undefined, tone: "in" | "out") => f && f.value && f.status !== "Not applicable" ? (
    <div>
      <p className="text-xs uppercase tracking-[0.14em] text-ink-soft">{f.label}</p>
      <EditableValue f={f} ctx={ctx} className="mt-2">
        <span className="flex flex-wrap gap-2">{f.value.split(",").map((x) => x.trim()).filter(Boolean).map((x) => (
          <span key={x} className={`rounded-full px-3 py-1 text-sm ${tone === "in" ? "bg-brand-soft text-brand-strong" : "border border-line text-ink-soft line-through decoration-ink-soft/50"}`}>{x}</span>))}</span>
        <span className="mt-1.5 block"><Status s={f.status} /></span>
      </EditableValue>
    </div>
  ) : null;
  const lines = known(fs).filter((f) => !["preferred_locations", "forbidden_locations"].includes(f.key));
  return (
    <SectionShell id="C" done={completeness(fs)}>
      <div className="space-y-6">
        {chips(g.get("preferred_locations"), "in")}
        {chips(g.get("forbidden_locations"), "out")}
        {lines.length > 0 && (
          <dl className="divide-y divide-line border-y border-line">
            {lines.map((f) => (
              <div key={f.key} className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
                <dt className="text-sm text-ink-soft">{f.label}</dt>
                <dd><Val f={f} ctx={ctx} /></dd>
              </div>))}
          </dl>
        )}
      </div>
      <NaLine fs={na(fs)} />
      <MissingLine fields={missing(fs)} ctx={ctx} />
    </SectionShell>
  );
}

/* ---------- D. Budget & terms ---------- */
export function BudgetSection({ brief, ctx }: { brief: Brief; ctx: EditCtx }) {
  const fs = sectionFields(brief, "D");
  const g = new Map(fs.map((f) => [f.key, f]));
  const basis = g.get("budget_basis")?.value ?? null;
  const perSf = basis && /sf|sq/i.test(basis);
  const money = (f: BriefField) => {
    const r = rangeOf(f.value);
    if (r.min === undefined && r.max === undefined) return f.value;
    const fmt = (x?: number) => (x === undefined ? "—" : `${inr(x)}${perSf ? " / sf / month" : ""}`);
    return `${fmt(r.min)} – ${fmt(r.max)}`;
  };
  const basisOf = (f: BriefField) => f.key === "budget" ? (basis ? `${basis}${perSf ? " (per sf per month)" : ""}` : "basis not set") : /months/.test(f.key) ? "months" : "—";
  const rows = known(fs).filter((f) => f.key !== "budget_basis");
  return (
    <SectionShell id="D" done={completeness(fs)}>
      {rows.length === 0 ? <p className="text-sm text-ink-soft">No commercial terms captured yet.</p> : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead><tr className="border-b border-ink text-xs uppercase tracking-[0.14em] text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-medium">Term</th><th scope="col" className="py-2 pr-4 font-medium">Value</th>
              <th scope="col" className="py-2 pr-4 font-medium">Basis / periodicity</th><th scope="col" className="py-2 font-medium">Status</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((f) => (
                <tr key={f.key} className="align-top">
                  <th scope="row" className="py-3 pr-4 font-normal text-ink-soft">{f.label}</th>
                  <td className="py-3 pr-4"><EditableValue f={f} ctx={ctx}><span className="font-medium tabular-nums text-ink">{f.key === "budget" ? money(f) : f.value}</span></EditableValue></td>
                  <td className="py-3 pr-4 text-ink-soft">{basisOf(f)}</td>
                  <td className="py-3"><Status s={f.status} /></td>
                </tr>))}
            </tbody>
          </table>
        </div>
      )}
      {g.get("budget_basis") && g.get("budget_basis")!.status !== "Missing" && (
        <div className="mt-3 text-xs text-ink-soft">Budget basis: <EditableValue f={g.get("budget_basis")!} ctx={ctx} className="inline-block"><span className="text-ink">{basis}</span> <Status s={g.get("budget_basis")!.status} quiet /></EditableValue></div>
      )}
      <NaLine fs={na(fs)} />
      <MissingLine fields={missing(fs)} ctx={ctx} />
    </SectionShell>
  );
}

/* ---------- E. Timeline ---------- */
export function TimelineSection({ brief, ctx, approvedAt }: { brief: Brief; ctx: EditCtx; approvedAt: string | null }) {
  const fs = sectionFields(brief, "E");
  const g = new Map(fs.map((f) => [f.key, f]));
  type Stop = { label: string; f?: BriefField; text?: string | null; note?: string };
  const stops: Stop[] = [
    { label: "Current lease notice / break", f: g.get("current_lease_notice") },
    { label: "Possession / move-in", f: g.get("occupation_date") },
    { label: "Lease commencement", text: null, note: "set on the lease once signed" },
    { label: "Brief approved", text: approvedAt, note: "approve a snapshot below" },
    { label: "Decision deadline", f: g.get("decision_date") },
  ];
  return (
    <SectionShell id="E" done={completeness(fs)}>
      <ol className="relative grid gap-6 border-l border-line pl-5 md:grid-cols-5 md:gap-3 md:border-l-0 md:border-t md:pl-0 md:pt-5">
        {stops.map((s) => {
          const value = s.f ? s.f.value : s.text;
          const set = Boolean(value);
          return (
            <li key={s.label} className="relative min-w-0">
              <span className={`absolute -left-[1.6rem] top-1 size-3 rounded-full md:-top-[1.6rem] md:left-0 ${set ? "bg-brand" : "border border-dashed border-ink-soft bg-canvas"}`} aria-hidden />
              <p className="text-xs uppercase tracking-[0.12em] text-ink-soft">{s.label}</p>
              {s.f ? (
                <EditableValue f={s.f} ctx={ctx} className="mt-1">
                  <span className={`block ${set ? "font-semibold text-ink" : "italic text-ink-soft"}`}>{value ?? "not set"}</span>
                  {set && <Status s={s.f.status} />}
                </EditableValue>
              ) : (
                <p className={`mt-1 ${set ? "font-semibold text-ink" : "italic text-ink-soft"}`}>{value ?? "not set"}{!set && s.note && <span className="block text-[11px] not-italic">{s.note}</span>}</p>
              )}
            </li>);
        })}
      </ol>
      <NaLine fs={na(fs)} />
    </SectionShell>
  );
}

/* ---------- F. Approvals ---------- */
export function ApprovalsSection({ brief, ctx }: { brief: Brief; ctx: EditCtx }) {
  const fs = sectionFields(brief, "F");
  const filled = brief.stakeholders.filter((s) => s.people.length).length;
  return (
    <SectionShell id="F" done={{ known: completeness(fs).known + filled, total: completeness(fs).total + brief.stakeholders.length }}>
      <ul className="divide-y divide-line border-y border-line">
        {brief.stakeholders.map((s) => {
          const ok = s.people.length > 0;
          return (
            <li key={s.slot} className="flex items-start gap-3 py-3">
              <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded ${ok ? "bg-ok text-white" : "border border-ink-soft/50"}`} aria-hidden>
                {ok && <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3}><path d="M5 12l4 4L19 6" /></svg>}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{s.slot}</p>
                <p className={`text-sm ${ok ? "text-ink" : "text-ink-soft"}`}>{ok ? s.people.join(", ") : "Nobody identified yet"}</p>
              </div>
              <span className="sr-only">{ok ? "identified" : "missing"}</span>
            </li>);
        })}
      </ul>
      {brief.stakeholderGaps.length > 0 && <ul className="mt-3 space-y-1 text-sm text-warn">{brief.stakeholderGaps.map((g) => <li key={g}>— {g}</li>)}</ul>}
      <p className="mt-2 text-xs text-ink-soft">Add people and roles on the <Link className="underline" href={`/requirements/${brief.requirementId}`}>requirement page</Link>.</p>
      {known(fs).length > 0 && (
        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          {known(fs).map((f) => <div key={f.key}><dt className="text-xs text-ink-soft">{f.label}</dt><dd className="mt-0.5"><Val f={f} ctx={ctx} /></dd></div>)}
        </dl>
      )}
      <NaLine fs={na(fs)} />
      <MissingLine fields={missing(fs)} ctx={ctx} />
    </SectionShell>
  );
}

/* ---------- G. Assumptions & open questions ---------- */
export function GapsSection({ brief }: { brief: Brief }) {
  const fs = [...allFields(brief).values()];
  const col = (title: string, s: BriefLabel, items: ReactNode[]) => (
    <div className="min-w-0">
      <h3 className="flex items-center gap-2 border-b border-line pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink"><span className={`size-2 rounded-full ${DOT[s]}`} aria-hidden />{title} <span className="font-normal tabular-nums text-ink-soft">{items.length}</span></h3>
      {items.length === 0 ? <p className="mt-2 text-sm text-ink-soft">None.</p> : <ul className="mt-2 space-y-1.5 text-sm">{items}</ul>}
    </div>
  );
  const items = (s: BriefLabel) => fs.filter((f) => f.status === s).map((f) => <li key={f.key}><span className="text-ink-soft">{f.label}:</span> {f.value ?? ""}</li>);
  return (
    <SectionShell id="G">
      <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {col("Confirmed", "Confirmed", items("Confirmed"))}
        {col("Estimated", "Estimated", items("Estimated"))}
        {col("Assumptions", "Assumption", items("Assumption"))}
        {col("Missing", "Missing", fs.filter((f) => f.status === "Missing").map((f) => <li key={f.key} className="text-ink-soft">{f.label}</li>))}
        <div className="min-w-0">
          <h3 className="border-b border-line pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink">Open questions <span className="font-normal tabular-nums text-ink-soft">{brief.openQuestions.length}</span></h3>
          {brief.openQuestions.length === 0 ? <p className="mt-2 text-sm text-ink-soft">Nothing left to ask.</p> : (
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">{brief.openQuestions.map((q) => (
              <li key={q.key}>{q.question} <span className="text-xs text-ink-soft">({q.priority}{q.reason === "estimated_needs_confirmation" ? ", needs client confirmation" : ""})</span></li>))}</ol>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="border-b border-line pb-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink">Pending approvals <span className="font-normal tabular-nums text-ink-soft">{brief.pendingApprovals.length}</span></h3>
          {brief.pendingApprovals.length === 0 ? <p className="mt-2 text-sm text-ink-soft">No changes waiting for approval.</p> : (
            <ul className="mt-2 space-y-1.5 text-sm">{brief.pendingApprovals.map((p) => (
              <li key={p.id} className="flex justify-between gap-3"><span>{p.reason ?? "Requirement change"}</span><Link className="shrink-0 text-brand" href="/approvals">{p.state} →</Link></li>))}</ul>
          )}
        </div>
      </div>
      {brief.stakeholderGaps.length > 0 && <p className="mt-6 text-xs text-ink-soft">Stakeholder gaps are listed under F. Approvals.</p>}
    </SectionShell>
  );
}

/* ---------- summary + navigator ---------- */
export function CompletenessBar({ counts }: { counts: Record<BriefLabel, number> }) {
  const order: BriefLabel[] = ["Confirmed", "Estimated", "Assumption", "Missing"];
  const total = order.reduce((a, k) => a + counts[k], 0) || 1;
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full border border-line bg-surface" role="img"
        aria-label={order.map((k) => `${counts[k]} ${k.toLowerCase()}`).join(", ")}>
        {order.map((k) => counts[k] > 0 && <div key={k} className={BAR[k]} style={{ width: `${(counts[k] / total) * 100}%` }} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {[...order, "Not applicable" as BriefLabel].map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-full ${DOT[k]}`} aria-hidden /><span className="font-semibold tabular-nums text-ink">{counts[k]}</span><span className="text-ink-soft">{k.toLowerCase()}</span></li>))}
      </ul>
    </div>
  );
}

export function SectionNav({ brief }: { brief: Brief }) {
  return (
    <nav aria-label="Brief sections" className="sticky top-0 z-10 -mx-4 border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur lg:top-6 lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
      <ol className="flex gap-2 overflow-x-auto lg:flex-col lg:gap-0.5">
        {SECTION_META.map((s) => {
          const c = s.id === "G" ? { known: brief.openQuestions.length, total: -1 } : s.id === "F"
            ? { known: completeness(sectionFields(brief, "F")).known + brief.stakeholders.filter((x) => x.people.length).length, total: completeness(sectionFields(brief, "F")).total + brief.stakeholders.length }
            : completeness(sectionFields(brief, s.id));
          const full = c.total > 0 && c.known === c.total;
          return (
            <li key={s.id} className="shrink-0">
              <a href={`#sec-${s.id}`} className="flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:border-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:rounded-md lg:border-0 lg:bg-transparent lg:px-2 lg:hover:bg-surface">
                <SectionIcon id={s.id} className="size-4 text-ink-soft" />
                <span className="text-ink-soft">{s.id}</span>
                <span className="lg:flex-1">{s.short}</span>
                <span className={`text-xs tabular-nums ${full ? "text-ok" : "text-ink-soft"}`}>{s.id === "G" ? `${c.known} q` : `${c.known}/${c.total}`}</span>
              </a>
            </li>);
        })}
      </ol>
    </nav>
  );
}

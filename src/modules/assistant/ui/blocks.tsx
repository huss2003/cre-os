"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import clsx from "clsx";
import type { Block, EntityRef, SourceRef } from "../types";
import { parseMarkdown, type Inline } from "./markdown";
import { api } from "./api";
import dynamic from "next/dynamic";

/** Leaflet touches window — load the map only in the browser. */
const MapView = dynamic(() => import("./map-view").then((m) => m.MapView), { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl border border-line bg-canvas" aria-label="Loading map" /> });

/* Renderers for every assistant Block kind. Model text is rendered via the safe markdown AST only. */

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => {
    switch (n.t) {
      case "text": return <span key={i}>{n.v}</span>;
      case "bold": return <strong key={i} className="font-semibold"><InlineNodes nodes={n.c} /></strong>;
      case "em": return <em key={i}><InlineNodes nodes={n.c} /></em>;
      case "code": return <code key={i} className="rounded bg-canvas px-1 py-0.5 text-[0.9em]">{n.v}</code>;
      case "link": return n.external
        ? <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"><InlineNodes nodes={n.c} /></a>
        : <Link key={i} href={n.href} className="font-medium text-brand underline decoration-brand/30 underline-offset-2 hover:decoration-brand"><InlineNodes nodes={n.c} /></Link>;
    }
  })}</>;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2.5 text-[15px] leading-relaxed">
      {parseMarkdown(text).map((b, i) => {
        if (b.t === "p") return <p key={i}><InlineNodes nodes={b.c} /></p>;
        if (b.t === "h") return <p key={i} className={clsx("font-semibold", b.level === 1 ? "text-lg" : "text-base")}><InlineNodes nodes={b.c} /></p>;
        if (b.t === "code") return <pre key={i} className="overflow-x-auto rounded-lg bg-canvas p-3 text-xs"><code>{b.v}</code></pre>;
        if (b.t === "ul") return <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, k) => <li key={k}><InlineNodes nodes={it} /></li>)}</ul>;
        return <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5">{b.items.map((it, k) => <li key={k}><InlineNodes nodes={it} /></li>)}</ol>;
      })}
    </div>
  );
}

const STATUS_CHIP: Record<NonNullable<SourceRef["status"]>, [string, string]> = {
  verified: ["Verified", "bg-ok/10 text-ok border-ok/20"],
  reported: ["Reported", "bg-warn/10 text-warn border-warn/30"],
  inferred: ["Inferred", "bg-accent/10 text-accent border-accent/30"],
  unknown: ["Unknown", "bg-canvas text-ink-soft border-line"],
};
function Chip({ status }: { status?: SourceRef["status"] }) {
  const [label, cls] = STATUS_CHIP[status ?? "unknown"];
  return <span className={clsx("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", cls)}>{label}</span>;
}
const fmtDate = (d?: string | null) => {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t.getTime()) ? d : t.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

function EntityLink({ e, className }: { e: EntityRef; className?: string }) {
  return e.href ? <Link href={e.href} className={clsx("font-semibold text-ink hover:text-brand hover:underline", className)}>{e.label}</Link>
    : <span className={clsx("font-semibold", className)}>{e.label}</span>;
}

function Frame({ title, children, tone }: { title?: ReactNode; children: ReactNode; tone?: "warn" }) {
  return (
    <section className={clsx("rounded-xl border p-4", tone === "warn" ? "border-warn/40 bg-warn/5" : "border-line bg-surface")}>
      {title ? <h3 className="mb-2 text-sm font-semibold">{title}</h3> : null}
      {children}
    </section>
  );
}

export function Sources({ items }: { items: SourceRef[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((s, i) => (
        <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {s.href ? (/^https?:/.test(s.href)
            ? <a href={s.href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">{s.label}<span className="sr-only"> (opens in new tab)</span></a>
            : <Link href={s.href} className="font-medium text-brand hover:underline">{s.label}</Link>)
            : <span className="font-medium">{s.label}</span>}
          {fmtDate(s.observedAt) ? <span className="text-xs text-ink-soft">{fmtDate(s.observedAt)}</span> : <span className="text-xs text-ink-soft">date unknown</span>}
          <Chip status={s.status} />
        </li>
      ))}
    </ul>
  );
}

const isNum = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^[-₹$]?\s?[\d,]+(\.\d+)?\s?(%|sf|L|Cr)?$/.test(v.trim()));
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "Unknown" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Pick a lease, then get an Approve/Reject card (nothing is written until approved). */
function LeaseAttach({ b }: { b: Extract<Block, { kind: "lease_attach" }> }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ id: string; label: string }[] | null>(null);
  const [leaseId, setLeaseId] = useState(b.suggestions[0]?.id ?? "");
  const [attachDoc, setAttachDoc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Block[] | null>(null);
  const options = [...b.suggestions, ...(found ?? []).filter((f) => !b.suggestions.some((s) => s.id === f.id))];
  const search = async () => {
    setErr(null);
    try { const r = await api.leases(q.trim()); setFound(r.items); if (!leaseId && r.items[0]) setLeaseId(r.items[0].id); }
    catch (e) { setErr(e instanceof Error ? e.message : "Search failed"); }
  };
  const attach = async () => {
    if (!leaseId) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.attachLeaseTerms(b.extractionId, leaseId, attachDoc);
      if (r.blocks?.length) setResult(r.blocks); else setErr(r.error ?? "Nothing to attach — no lease field would change.");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not prepare the change"); }
    finally { setBusy(false); }
  };
  if (result) return <div className="space-y-3"><BlockList blocks={result} /></div>;
  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-label="Attach extracted terms to a lease record">
      <h3 className="text-sm font-semibold">Attach these terms to a lease record</h3>
      <p className="mt-1 text-sm text-ink-soft">Pick the lease. You&apos;ll see every field that would change before anything is saved.</p>
      {options.length ? (
        <fieldset className="mt-3 space-y-1.5">
          <legend className="sr-only">Lease</legend>
          {options.map((o) => (
            <label key={o.id} className={clsx("flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm", leaseId === o.id ? "border-brand bg-brand-soft/40" : "border-line hover:border-brand/40")}>
              <input type="radio" name={`lease-${b.extractionId}`} checked={leaseId === o.id} onChange={() => setLeaseId(o.id)} className="accent-brand" />
              <span className="min-w-0 truncate">{o.label}</span>
            </label>
          ))}
        </fieldset>
      ) : found ? <p className="mt-3 text-sm text-ink-soft">No matching leases. Try the tenant&apos;s name.</p> : null}
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={options.length ? "Find another lease by tenant name" : "Find the lease by tenant name"} aria-label="Find a lease by tenant name"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 text-sm focus:border-brand focus:outline-none" />
        <button type="submit" className="min-h-11 rounded-lg border border-line px-3 text-sm font-medium hover:border-brand/40">Search</button>
      </form>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={attachDoc} onChange={(e) => setAttachDoc(e.target.checked)} className="accent-brand" />
        Also store “{b.file}” on the lease
      </label>
      <button type="button" disabled={!leaseId || busy} onClick={attach}
        className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:opacity-50">
        {busy ? "Preparing…" : "Attach to lease record"}
      </button>
      {err ? <p role="alert" className="mt-2 text-sm text-bad">{err}</p> : null}
    </section>
  );
}

function ApprovalCard({ b }: { b: Extract<Block, { kind: "approval" }> }) {
  const [status, setStatus] = useState(b.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<Block[] | null>(null);
  const open = status === "pending" || status === "waiting" || status === "proposed";
  const decide = async (d: "approve" | "reject") => {
    setBusy(true); setErr(null);
    try { const r = await api.decide(b.approvalId, d); setStatus(r.status); setResult(r.blocks ?? null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not record the decision"); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-xl border-2 border-brand/30 bg-brand-soft/40 p-4" aria-label={`Approval needed: ${b.title}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">{b.title}</h3>
        <span className={clsx("rounded-full border px-2 py-0.5 text-[11px] font-medium",
          open ? "border-brand/30 bg-surface text-brand" : status === "approved" || status === "executed" ? "border-ok/20 bg-ok/10 text-ok" : "border-line bg-canvas text-ink-soft")}>
          {open ? "Waiting for you" : status.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{b.explanation}</p>
      {b.affected.length ? <p className="mt-2 text-sm">Affects: {b.affected.map((e, i) => <span key={i}>{i ? ", " : ""}<EntityLink e={e} /></span>)}</p> : null}
      {b.diff.length ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[320px] text-left text-sm">
            <thead className="bg-canvas text-xs text-ink-soft"><tr><th className="px-3 py-1.5 font-medium">Field</th><th className="px-3 py-1.5 font-medium">Now</th><th className="px-3 py-1.5 font-medium">After</th></tr></thead>
            <tbody className="divide-y divide-line">
              {b.diff.map((d, i) => (
                <tr key={i}><td className="px-3 py-1.5 font-medium">{d.field}</td><td className="px-3 py-1.5 text-ink-soft line-through decoration-bad/40">{show(d.before)}</td><td className="px-3 py-1.5 font-medium text-ok">{show(d.after)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => decide("approve")} className="inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-strong disabled:opacity-50">Approve change</button>
          <button type="button" disabled={busy} onClick={() => decide("reject")} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:border-bad/40 hover:text-bad disabled:opacity-50">Reject</button>
        </div>
      ) : null}
      {err ? <p role="alert" className="mt-2 text-sm text-bad">{err}</p> : null}
      {result?.length ? <div className="mt-3"><BlockList blocks={result} /></div> : null}
    </section>
  );
}

export function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "text": return <Markdown text={b.markdown} />;
    case "entity_card": return (
      <Frame>
        <div className="mb-2 flex items-center justify-between gap-2"><EntityLink e={b.entity} className="text-base" /></div>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2">
          {b.fields.map((f, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-ink-soft">{f.label}</dt>
              <dd className={clsx("font-medium", f.value === null && "italic text-ink-soft")}>{f.value ?? "Unknown"}</dd>
              {f.status ? <Chip status={f.status} /> : null}
            </div>
          ))}
        </dl>
        {b.sources?.length ? <div className="mt-3 border-t border-line pt-2"><Sources items={b.sources} /></div> : null}
      </Frame>
    );
    case "table": return (
      <Frame title={b.title}>
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-max text-left text-sm">
            <thead className="text-xs text-ink-soft"><tr>{b.columns.map((c, i) => <th key={i} scope="col" className={clsx("border-b border-line px-2 py-1.5 font-medium", b.rows.some((r) => isNum(r[i])) && "text-right")}>{c}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {b.rows.map((r, i) => <tr key={i}>{r.map((v, k) => <td key={k} className={clsx("px-2 py-1.5", isNum(v) && "text-right tabular-nums", v === null && "italic text-ink-soft")}>{v ?? "Unknown"}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
        {b.note ? <p className="mt-2 text-xs text-ink-soft">{b.note}</p> : null}
        {b.sources?.length ? <div className="mt-2 border-t border-line pt-2"><Sources items={b.sources} /></div> : null}
      </Frame>
    );
    case "ranked_list": return (
      <Frame title={b.title}>
        <ol className="space-y-3">
          {b.items.map((it) => (
            <li key={it.rank} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">{it.rank}</span>
              <div className="min-w-0 text-sm">
                <div className="flex flex-wrap items-baseline gap-2"><EntityLink e={it.entity} />{it.score != null ? <span className="text-xs tabular-nums text-ink-soft">score {it.score}</span> : null}</div>
                <p className="text-ink-soft">{it.why}</p>
                {it.next ? <p className="mt-0.5"><span className="font-medium">Next:</span> {it.next}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </Frame>
    );
    case "brief": return (
      <Frame title={b.href ? <Link href={b.href} className="hover:text-brand hover:underline">{b.title}</Link> : b.title}>
        <div className="space-y-3">
          {b.sections.map((s, i) => (
            <div key={i}><p className="text-sm font-semibold">{s.heading}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{s.bullets.map((x, k) => <li key={k}>{x}</li>)}</ul></div>
          ))}
        </div>
      </Frame>
    );
    case "tasks": return (
      <Frame title={b.title ?? "Tasks"}>
        <ul className="space-y-1.5 text-sm">
          {b.items.map((t, i) => (
            <li key={i} className="flex items-start gap-2">
              <span aria-hidden className={clsx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]", t.done ? "border-ok bg-ok text-white" : "border-line")}>{t.done ? "✓" : ""}</span>
              <span className="min-w-0 flex-1">
                {t.href ? <Link href={t.href} className="hover:text-brand hover:underline">{t.title}</Link> : t.title}
                <span className="sr-only">{t.done ? " (done)" : " (open)"}</span>
                {t.entity ? <span className="text-ink-soft"> · <EntityLink e={t.entity} className="font-normal" /></span> : null}
              </span>
              {t.due ? <span className="shrink-0 text-xs text-ink-soft">{fmtDate(t.due)}</span> : null}
            </li>
          ))}
        </ul>
      </Frame>
    );
    case "sources": return <Frame title="Sources"><Sources items={b.items} /></Frame>;
    case "missing": return b.items.length ? (
      <Frame tone="warn" title={<span className="text-warn">Missing / not verified</span>}>
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">{b.items.map((m, i) => <li key={i}>{m}</li>)}</ul>
      </Frame>
    ) : null;
    case "approval": return <ApprovalCard b={b} />;
    case "lease_attach": return <LeaseAttach b={b} />;
    case "draft": return (
      <Frame title={`Draft ${b.channel}`}>
        {b.subject ? <p className="text-sm font-medium">{b.subject}</p> : null}
        <p className="mt-1 line-clamp-6 whitespace-pre-line rounded-lg bg-canvas p-3 text-sm text-ink-soft">{b.preview}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Link href={b.draftHref} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:border-brand/40 hover:text-brand">Open draft</Link>
          <span className="text-xs text-ink-soft">Nothing is sent. Review and send it yourself from the draft.</span>
        </div>
      </Frame>
    );
    case "status": return <StatusBlock b={b} />;
    case "download": return (
      <a href={b.href} download className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold hover:border-brand/40 hover:text-brand">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden><path d="M12 4v11M8 11l4 4 4-4M5 20h14" /></svg>{b.label}
      </a>
    );
    case "map": return <MapView b={b} />;
  }
}

/** Kinds worth turning into a deliverable (mirrors outputs/render.ts hasStructured). */
export const isExportable = (blocks: Block[]) => blocks.some((b) => !["text", "status", "approval", "download", "draft"].includes(b.kind));

/**
 * One-click deliverables for a stored assistant message: "Make deck" / "Word doc" / "PDF".
 * Render under any assistant message that has a messageId and structured blocks.
 */
export function ExportBar({ messageId, blocks }: { messageId?: string | null; blocks: Block[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [files, setFiles] = useState<{ label: string; href: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  if (!messageId || !isExportable(blocks)) return null;
  const make = async (format: "pptx" | "docx" | "pdf") => {
    setBusy(format); setErr(null);
    try {
      const res = await fetch("/api/v1/assistant/exports", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ messageId, format }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Export failed (${res.status})`);
      setFiles((f) => [{ label: { pptx: "Deck", docx: "Word doc", pdf: "PDF" }[format], href: body.href, name: body.fileName }, ...f.filter((x) => x.name !== body.fileName)]);
    } catch (e) { setErr(e instanceof Error ? e.message : "Export failed"); }
    finally { setBusy(null); }
  };
  const btn = "inline-flex min-h-9 items-center rounded-lg border border-line bg-surface px-3 text-xs font-semibold hover:border-brand/40 hover:text-brand disabled:opacity-50";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Export this answer">
      <button type="button" className={btn} disabled={!!busy} onClick={() => make("pptx")}>{busy === "pptx" ? "Building…" : "Make deck"}</button>
      <button type="button" className={btn} disabled={!!busy} onClick={() => make("docx")}>{busy === "docx" ? "Building…" : "Word doc"}</button>
      <button type="button" className={btn} disabled={!!busy} onClick={() => make("pdf")}>{busy === "pdf" ? "Building…" : "PDF"}</button>
      {files.map((f) => <a key={f.href} href={f.href} download={f.name} className="text-xs font-medium text-brand underline">{f.label}: {f.name}</a>)}
      {err ? <span role="alert" className="text-xs text-bad">{err}</span> : null}
    </div>
  );
}

function StatusBlock({ b }: { b: Extract<Block, { kind: "status" }> }) {
  const col = (label: string, items: string[], cls: string) => items.length ? (
    <div><p className={clsx("text-xs font-semibold", cls)}>{label} ({items.length})</p>
      <ul className="mt-1 space-y-0.5 text-sm">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
  ) : null;
  return (
    <section aria-label="Run status" className="grid gap-3 rounded-xl border border-line bg-canvas/60 p-4 sm:grid-cols-3">
      {col("Done", b.done, "text-ok")}{col("Pending", b.pending, "text-warn")}{col("Blocked", b.blocked, "text-bad")}
      {!b.done.length && !b.pending.length && !b.blocked.length ? <p className="text-sm text-ink-soft">Nothing to report.</p> : null}
    </section>
  );
}

export function BlockList({ blocks }: { blocks: Block[] }) {
  return <div className="space-y-3">{blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>;
}

/** Plain text of blocks (copy / markdown export). */
export function blocksToMarkdown(blocks: Block[]): string {
  return blocks.map((b) => {
    switch (b.kind) {
      case "text": return b.markdown;
      case "entity_card": return `**${b.entity.label}**\n` + b.fields.map((f) => `- ${f.label}: ${f.value ?? "Unknown"}`).join("\n");
      case "table": return `${b.title ? `**${b.title}**\n` : ""}| ${b.columns.join(" | ")} |\n|${b.columns.map(() => "---").join("|")}|\n` + b.rows.map((r) => `| ${r.map((v) => v ?? "Unknown").join(" | ")} |`).join("\n");
      case "ranked_list": return `${b.title ? `**${b.title}**\n` : ""}` + b.items.map((i) => `${i.rank}. ${i.entity.label} — ${i.why}${i.next ? ` (next: ${i.next})` : ""}`).join("\n");
      case "brief": return `**${b.title}**\n` + b.sections.map((s) => `${s.heading}\n${s.bullets.map((x) => `- ${x}`).join("\n")}`).join("\n\n");
      case "tasks": return b.items.map((t) => `- [${t.done ? "x" : " "}] ${t.title}${t.due ? ` (due ${t.due})` : ""}`).join("\n");
      case "sources": return "Sources:\n" + b.items.map((s) => `- ${s.label}${s.observedAt ? ` (${s.observedAt})` : ""}${s.href ? ` ${s.href}` : ""} [${s.status ?? "unknown"}]`).join("\n");
      case "missing": return "Missing / not verified:\n" + b.items.map((x) => `- ${x}`).join("\n");
      case "lease_attach": return "";
      case "approval": return `Approval needed: ${b.title} (${b.status})\n${b.explanation}`;
      case "draft": return `Draft ${b.channel}${b.subject ? `: ${b.subject}` : ""}\n${b.preview}`;
      case "status": return `Done: ${b.done.join("; ") || "—"}\nPending: ${b.pending.join("; ") || "—"}\nBlocked: ${b.blocked.join("; ") || "—"}`;
      case "download": return `${b.label}: ${b.href}`;
      case "map": return `${b.title ? `**${b.title}**\n` : ""}` + b.points.map((p) => `- ${p.label} (${p.lat}, ${p.lon})`).join("\n") + `\n${b.note}`;
    }
  }).join("\n\n");
}

import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Badge, EmptyState, Input, Select, Textarea, Button, ButtonLink } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { listMemories, CATEGORIES, type MemoryListItem } from "@/modules/assistant/memory/service";
import { correctAction, verifyAction, restrictAction, forgetAction } from "@/modules/assistant/memory/actions";
import { fmtDate } from "@/lib/util/time";
import { StyleProfileCard } from "@/modules/assistant/outputs/style-card";

export const metadata = { title: "Assistant memory" };
type SP = { category?: string; entity?: string; status?: string; q?: string };
const STATUS_LABEL: Record<string, string> = { current: "Current", active: "Active", restricted: "Restricted", outdated: "Outdated (history)", forgotten: "Forgotten", all: "All" };
const CAT_LABEL: Record<string, string> = { person: "Person", company: "Company", requirement: "Requirement", relationship: "Relationship" };

function Chips({ m }: { m: MemoryListItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone="neutral">{CAT_LABEL[m.category]}</Badge>
      {m.stated ? <Badge tone="ok" title="The person or user said this explicitly">Stated</Badge> : <Badge tone="accent" title="The assistant inferred this — not a confirmed fact">Inferred</Badge>}
      <Badge tone="neutral" title="Confidence">{Math.round(Number(m.confidence) * 100)}%</Badge>
      {m.sensitivity !== "normal" ? <Badge tone="warn">{m.sensitivity}</Badge> : null}
      {m.status !== "active" ? <Badge tone={m.status === "restricted" ? "warn" : "neutral"}>{STATUS_LABEL[m.status]}</Badge> : null}
      {m.stale ? <Badge tone="bad" title="Past its review date or not verified in 180 days — check before relying on it">Needs review</Badge> : null}
      {m.source_ref?.scope === "employer" ? <Badge tone="brand" title="Only used while the person works at the same company">Company-specific</Badge> : null}
    </div>
  );
}

function MemoryCard({ m, editor }: { m: MemoryListItem; editor: boolean }) {
  const live = m.status === "active" || m.status === "restricted";
  return (
    <li className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className={m.status === "forgotten" ? "italic text-ink-soft" : "font-medium"}>{m.content}</p>
          <p className="mt-1 text-xs text-ink-soft">
            About <Link href={m.href} className="font-medium text-brand hover:underline">{m.entityLabel ?? "record not visible"}</Link>
            {" · "}from {m.source.startsWith("conversation:") ? <Link className="hover:underline" href={`/assistant/${m.source.slice(13)}`}>a conversation</Link> : m.source}
            {m.provided_by ? ` · by ${m.provided_by}` : ""} · captured {fmtDate(m.captured_at)}
            {m.last_verified_at ? ` · verified ${fmtDate(m.last_verified_at)}` : " · never verified"}
            {m.review_at ? ` · review by ${fmtDate(m.review_at)}` : ""}
          </p>
        </div>
        <Chips m={m} />
      </div>
      {m.history.length ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-ink-soft">Earlier versions ({m.history.length})</summary>
          <ol className="mt-2 space-y-1 border-l-2 border-line pl-3">
            {m.history.map((h) => <li key={h.id} className="text-ink-soft"><span className="line-through">{h.content}</span> <span className="text-xs">· {h.stated ? "stated" : "inferred"} · {fmtDate(h.captured_at)} · {h.source}</span></li>)}
          </ol>
        </details>
      ) : null}
      {editor && live ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <details className="w-full sm:w-auto">
            <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-xl border border-line px-3 text-sm font-medium hover:border-brand/50">Correct</summary>
            <ActionForm action={correctAction.bind(null, m.id)} className="mt-2 space-y-2 sm:w-96">
              <Textarea name="content" defaultValue={m.content} required aria-label="Corrected memory" />
              <Input name="provided_by" placeholder="Who told you? (optional)" aria-label="Provided by" />
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="inferred" value="1" /> This is my inference, not something they said</label>
              <Submit>Save correction</Submit>
            </ActionForm>
          </details>
          <ActionForm action={verifyAction.bind(null, m.id)}><Submit variant="secondary">Mark verified</Submit></ActionForm>
          {m.status !== "restricted" ? <ActionForm action={restrictAction.bind(null, m.id)}><Submit variant="secondary">Restrict</Submit></ActionForm> : null}
          <details>
            <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-xl border border-bad/30 px-3 text-sm font-medium text-bad">Forget</summary>
            <ActionForm action={forgetAction.bind(null, m.id)} className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" value="1" /> Erase this memory permanently</label>
              <Submit variant="danger">Forget</Submit>
            </ActionForm>
          </details>
        </div>
      ) : null}
    </li>
  );
}

export default async function MemoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const status = (sp.status && STATUS_LABEL[sp.status] ? sp.status : "current") as "current";
  const category = CATEGORIES.includes(sp.category as never) ? (sp.category as "person") : "";
  const items = await listMemories(ctx, { category, entityId: sp.entity && /^[0-9a-f-]{36}$/i.test(sp.entity) ? sp.entity : undefined, status: status === "current" ? "" : status, q: sp.q });
  const editor = hasRole(ctx, "editor");
  const filtered = !!(category || sp.entity || sp.q || status !== "current");
  return (
    <div className="space-y-5">
      <PageHeader title="Memory" subtitle="What the assistant remembers about people, companies and requirements. Inferred items are never treated as confirmed; items older than 180 days are flagged for review." actions={<ButtonLink href="/assistant" variant="secondary">Back to assistant</ButtonLink>} />
      <StyleProfileCard ctx={ctx} />
      <form className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_auto_auto_auto]" method="get">
        <Input name="q" defaultValue={sp.q ?? ""} placeholder="Search memories" aria-label="Search" className="col-span-2 sm:col-span-1" />
        <Select name="category" defaultValue={category} aria-label="Category"><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}</Select>
        <Select name="status" defaultValue={status} aria-label="Status">{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {sp.entity ? <input type="hidden" name="entity" value={sp.entity} /> : null}
        <Button type="submit" variant="secondary" className="col-span-2 sm:col-span-1">Filter</Button>
      </form>
      {sp.entity ? <p className="text-sm text-ink-soft">Showing one record only. <Link href="/assistant/memory" className="text-brand hover:underline">Show all</Link></p> : null}
      {!items.length ? (
        filtered ? <EmptyState title="Nothing matches these filters"><Link href="/assistant/memory" className="text-brand hover:underline">Clear filters</Link></EmptyState> : (
          <EmptyState title="No memories yet" action={<ButtonLink href="/assistant">Open the assistant</ButtonLink>}>
            Tell the assistant things worth remembering, e.g. &ldquo;Remember that John prefers short emails&rdquo; or &ldquo;ABC needs finance approval before signing a lease&rdquo;. Each memory keeps its source and date, and you can correct, restrict or forget it here.
          </EmptyState>
        )
      ) : (
        <ul className="space-y-3">{items.map((m) => <MemoryCard key={m.id} m={m} editor={editor} />)}</ul>
      )}
    </div>
  );
}

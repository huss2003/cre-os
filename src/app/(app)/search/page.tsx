import { Suspense } from "react";
import Link from "next/link";
import { Badge, ButtonLink, EmptyState, FactBadge, Input, PageHeader } from "@/components/ui";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { SEARCH_TYPES, TYPE_LABEL, parseSearchQuery, searchEntities } from "@/modules/admin/search";
import { ClassBadge, Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Search" };

type SP = Promise<Record<string, string | string[] | undefined>>;

async function Results({ searchParams }: { searchParams: SP }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  let params;
  try {
    params = parseSearchQuery(sp);
  } catch {
    params = parseSearchQuery({ q: typeof sp.q === "string" ? sp.q.slice(0, 200) : "" });
  }
  const typeSel = params.types?.length === 1 ? params.types[0] : "";
  const hits = params.q.trim() ? await searchEntities(ctx.db, ctx.workspaceId, params) : [];

  return (
    <div className="space-y-4">
      <form action="/search" data-tour="search-form" className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <Input name="q" defaultValue={params.q} placeholder="Company, person, building, email, CIN, alias…" autoFocus aria-label="Search" />
        <select name="type" defaultValue={typeSel} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" aria-label="Type">
          <option value="">All types</option>
          {SEARCH_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <input type="date" name="as_of" defaultValue={params.asOf ?? ""} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm" aria-label="As of date" />
        <button className="min-h-10 rounded-lg bg-brand px-4 text-sm font-medium text-white">Search</button>
      </form>
      <p className="text-xs text-ink-soft">Results are filtered by your access: you only see accounts you own, that are shared with you, or that your role allows. Facts keep their status — reported, confirmed and AI inference are never blended.</p>

      {!params.q.trim() ? (
        <EmptyState title="Search across companies, people, buildings, requirements and deals"
          action={hasRole(ctx, "editor") ? <div className="flex flex-wrap justify-center gap-2"><ButtonLink variant="secondary" href="/companies/new">Add company</ButtonLink><ButtonLink variant="secondary" href="/people/new">Add person</ButtonLink><ButtonLink variant="secondary" href="/buildings/new">Add building</ButtonLink></div> : undefined}>
          Type a name, alias, exact email, CIN or GSTIN. Use “As of” to see the role or availability that was valid on a date.
        </EmptyState>
      ) : hits.length === 0 ? (
        <EmptyState title={`Nothing found for “${params.q}”`}
          action={hasRole(ctx, "editor") ? <ButtonLink variant="secondary" href={params.types?.[0] === "person" ? "/people/new" : params.types?.[0] === "asset" ? "/buildings/new" : "/companies/new"}>Add a record</ButtonLink> : undefined}>
          Check the spelling or try a shorter name. Records you don&apos;t have access to never appear here — ask an admin to share an account with you.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {hits.map((h) => (
            <li key={`${h.entity_type}:${h.id}`} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">{TYPE_LABEL[h.entity_type]}</Badge>
                <Link href={`${h.href}${params.asOf && ["organisation", "person", "asset"].includes(h.entity_type) ? `?as_of=${params.asOf}` : ""}`} className="font-medium text-brand">{h.title}</Link>
                {h.archived ? <Badge tone="bad">archived</Badge> : null}
              </div>
              {h.subtitle ? <p className="mt-0.5 text-sm">{h.subtitle}</p> : null}
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                {h.fact_status ? <FactBadge status={h.fact_status} /> : null}
                {h.status_label ? <span>{h.status_label}</span> : null}
                <ClassBadge value={h.classification} />
                {h.matched_alias && h.matched_alias !== h.title ? <span>matched “{h.matched_alias}”</span> : null}
                {h.freshness ? <span>updated {fmtDate(h.freshness)}</span> : null}
              </div>
              {h.snippet ? <p className="mt-1 text-xs text-warn">{h.snippet}</p> : null}
            </li>
          ))}
          {hits.length >= params.limit ? <li className="text-xs text-ink-soft">Showing the top {params.limit}. Refine your query or filter by type.</li> : null}
        </ul>
      )}
    </div>
  );
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader title="Search" />
      <Suspense fallback={<Loading label="Searching…" />}><Results searchParams={searchParams} /></Suspense>
    </>
  );
}

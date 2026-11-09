import Link from "next/link";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, MoreFields, Textarea, ButtonLink } from "@/components/ui";
import { orgOptions, personOptions, recentJobMoves } from "@/modules/intelligence/research/queries";
import { threadingGaps, introPathsForOrg } from "@/modules/intelligence/network/service";
import { Flash, Sev, fmtDay, label } from "@/modules/intelligence/ui";
import { jobMoveAction, reconnectAction } from "./actions";
import { verifyMoveAction, introDraftAction } from "@/modules/intelligence/network/actions";
import { RelationshipForm } from "@/modules/intelligence/network/ui";

const UUID = /^[0-9a-f-]{36}$/i;

export default async function NetworkPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; org?: string; draft?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const org = sp.org && UUID.test(sp.org) ? sp.org : null;
  const [orgs, people, moves, gaps, paths] = await Promise.all([
    orgOptions(ctx.db, ctx.workspaceId), personOptions(ctx.db, ctx.workspaceId), recentJobMoves(ctx.db, ctx.workspaceId), threadingGaps(ctx.db, ctx.workspaceId),
    org ? introPathsForOrg(ctx.db, ctx.workspaceId, org, ctx.userId) : Promise.resolve([]),
  ]);
  const opt = (xs: { id: string; name: string }[], placeholder: string) => [<option key="" value="">{placeholder}</option>, ...xs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)];

  return (
    <div>
      <PageHeader title="Network" subtitle="Job moves, warm introduction paths and multi-threading gaps. LinkedIn-compliant: you record what you saw; nothing is scraped or automated." />
      <Flash sp={sp} />
      {sp.draft && <p className="mb-4 text-sm"><ButtonLink variant="secondary" href="/drafts">Open Drafts</ButtonLink></p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canEdit && (
          <Card title="Record a job move">
            {people.length === 0 || orgs.length === 0 ? <p className="text-sm text-ink-soft">Add people and companies first (<Link className="text-brand" href="/people">People</Link>, <Link className="text-brand" href="/companies">Companies</Link>).</p> : (
              <form action={jobMoveAction} className="max-w-md space-y-4">
                <Field label="Person" hint="Pick the exact record — same names stay separate people."><Select name="person_id" defaultValue="">{opt(people, "Choose…")}</Select></Field>
                <Field label="Moved to"><Select name="to_org_id" required defaultValue="">{opt(orgs, "Choose…")}</Select></Field>
                <MoreFields>
                  <Field label="From"><Select name="from_org_id" defaultValue="">{opt(orgs, "Current employer(s)")}</Select></Field>
                  <Field label="New title"><Input name="new_title" maxLength={160} /></Field>
                  <Field label="Effective date"><Input name="effective_on" type="date" /></Field>
                  <Field label="Seen via"><Select name="source_kind" defaultValue="native_alert">{["native_alert", "press_release", "company_page", "appointment_notice", "conversation", "user_export", "other"].map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
                  <Field label="Source URL"><Input name="source_url" type="url" placeholder="https://" /></Field>
                  <Field label="Note"><Textarea name="source_note" maxLength={2000} /></Field>
                </MoreFields>
                <Button type="submit">Record move</Button>
              </form>
            )}
          </Card>
        )}

        <Card title="Recent job moves">
          {moves.length === 0 ? <EmptyState title="No job moves recorded">When you notice a contact has moved (native alert, press release, conversation), record it here.</EmptyState> : (
            <ul className="divide-y divide-line">
              {moves.map((m) => (
                <li key={String(m.id)} className="py-2 text-sm">
                  <div><span className="font-medium">{m.person}</span>{m.from ? ` · ${m.from} →` : " →"} {m.to ?? "?"}{m.title ? ` (${m.title})` : ""}</div>
                  <div className="flex flex-wrap items-center gap-1 text-xs text-ink-soft">observed {fmtDay(String(m.observed_on))}{m.effective_on ? ` · effective ${fmtDay(String(m.effective_on))}` : ""} · <Badge>{label(String(m.evidence_tier))}</Badge>
                    {m.verified ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">unverified — not a fact yet</Badge>}</div>
                  {canEdit && !m.verified && (
                    <form action={verifyMoveAction} className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-center"><input type="hidden" name="claim_id" value={String(m.id)} />
                      <Input name="note" maxLength={300} placeholder="How confirmed (e.g. company page, spoke to them)" aria-label="How confirmed" /><Button variant="secondary">Mark confirmed</Button></form>
                  )}
                  {canEdit && m.to_org_id && (
                    <form action={reconnectAction} className="mt-1 flex flex-wrap gap-2"><input type="hidden" name="person_id" value={String(m.subject_id)} /><input type="hidden" name="org_id" value={m.to_org_id} />
                      <Button variant="secondary" name="channel" value="email">Draft reconnect email</Button><Button variant="ghost" name="channel" value="linkedin">LinkedIn note draft</Button>
                      <ButtonLink variant="ghost" href={`/network?org=${m.to_org_id}`}>Intro paths</ButtonLink></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {canEdit && people.length > 1 && (
        <Card title="Record a relationship" className="mt-4">
          <p className="mb-2 text-xs text-ink-soft">Record intro consent on the person&apos;s page.</p>
          <RelationshipForm back="/network" people={people} />
        </Card>
      )}

      <Card title="Introduction paths" className="mt-4">
        <form className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Company"><Select name="org" defaultValue={org ?? ""}>{opt(orgs, "Choose a company…")}</Select></Field>
          <Button variant="secondary" type="submit">Show paths</Button>
        </form>
        {!org ? <p className="text-sm text-ink-soft">Pick a company to see warm paths from you or colleagues to its current people. Only recorded relationships are used; paths without recorded introduction consent are marked “ask first”, and suppressed people are left out.</p>
          : paths.length === 0 ? <EmptyState title="No paths found">Record relationships (who knows whom, warmth, intro permission) on People to see paths here.</EmptyState> : (
          <ul className="space-y-2 text-sm">
            {paths.map((p, i) => (
              <li key={i} className="rounded-lg border border-line p-2"><div className="font-medium"><Link className="text-brand" href={`/people/${p.target_person_id}`}>{p.target_name}</Link></div>
                <div className="break-words">{p.hops.join(" → ")}</div>
                <div className="mt-1 flex flex-wrap gap-1">{p.warmth && <Badge tone="brand">{p.warmth}</Badge>}{p.consent_edge_id === null ? <Badge>direct — your relationship</Badge> : p.needs_permission ? <Badge tone="warn">ask first — no intro consent recorded</Badge> : <Badge tone="ok">intro consent recorded</Badge>}{p.last_contact && <Badge>last contact {p.last_contact}</Badge>}</div>
                {canEdit && p.consent_edge_id && (p.needs_permission
                  ? <p className="mt-1 text-xs text-ink-soft">Ask {p.hops[p.hops.length - 2]} first, then record their consent on <Link className="text-brand" href={`/people/${p.introducer_person_id ?? p.target_person_id}#relationships`}>their page</Link>. No intro draft is suggested before that.</p>
                  : p.introducer_person_id ? <form action={introDraftAction} className="mt-1"><input type="hidden" name="back" value={`/network?org=${org}`} /><input type="hidden" name="edge_id" value={p.consent_edge_id} /><Button variant="secondary">Draft intro request to {p.hops[1]}</Button></form> : null)}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Multi-threading gaps (${gaps.length})`} className="mt-4">
        {gaps.length === 0 ? <EmptyState title="No gaps detected">Open deals with mapped stakeholders and no single-person dependency show nothing here. Deals with no stakeholders appear once they reach “engaged”.</EmptyState> : (
          <ul className="divide-y divide-line">
            {gaps.map((g) => (
              <li key={g.opportunity_id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Link className="font-medium text-brand" href={`/insights/deals/${g.opportunity_id}`}>{g.name}</Link><Badge>{label(g.stage)}</Badge></div>
                <ul className="mt-1 space-y-0.5">{g.gaps.map((x, i) => <li key={i}><Sev s={x.severity} /> {x.detail}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

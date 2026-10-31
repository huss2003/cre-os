import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Textarea, FactBadge, StaleBanner } from "@/components/ui";
import { dossierPage } from "@/modules/intelligence/research/queries";
import { EVIDENCE_TIER_LABEL, type EvidenceTier } from "@/modules/intelligence/common";
import type { DossierSection } from "@/modules/intelligence/research/dossier";
import { Flash, TIER_TONE, fmtDay, label } from "@/modules/intelligence/ui";
import { generateAction, evidenceAction, webResearchAction, watchAction } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DossierPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const [{ orgId }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(orgId)) notFound();
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const d = await dossierPage(ctx.db, ctx.workspaceId, orgId);
  if (!d.org) notFound();
  const sections = (d.dossier?.sections ?? []) as DossierSection[];
  const falsify = (d.dossier?.falsification_questions ?? []) as string[];
  const overdue = d.dossier && String(d.dossier.next_refresh_at) < new Date().toISOString();

  return (
    <div>
      <PageHeader title={String(d.org.display_name)} subtitle={<><Link className="text-brand" href="/research">Research</Link> · company dossier{d.watch ? <> · <Badge tone={TIER_TONE[String(d.watch.tier)]}>{String(d.watch.tier)}</Badge></> : null}</>}
        actions={canEdit ? (
          <form action={generateAction} className="flex gap-2"><input type="hidden" name="org_id" value={orgId} />
            <Button>{d.dossier ? "Refresh if changed" : "Generate dossier"}</Button>
            {d.dossier && <Button variant="secondary" name="force" value="1">Force rebuild</Button>}
          </form>) : null} />
      <Flash sp={sp} />
      {d.dossier && d.dossier.synthesis_status !== "ok" && <StaleBanner>AI synthesis unavailable ({String(d.dossier.degraded_reason ?? "unknown")}). Sections below come from stored evidence; the timing hypothesis and question are rule-based.</StaleBanner>}
      {overdue && <StaleBanner>This dossier is past its refresh date ({fmtDay(String(d.dossier!.next_refresh_at))}).</StaleBanner>}

      {!d.dossier ? (
        <EmptyState title="No dossier yet">{canEdit ? "Paste any evidence you have below (press release, careers page, your notes), then generate. Sections without evidence will say “unknown” — nothing is guessed." : "An editor can generate one."}</EmptyState>
      ) : (
        <div className="mb-4 space-y-3">
          <p className="text-xs text-ink-soft">Version {String(d.dossier.version)} · generated {fmtDay(String(d.dossier.generated_at))} · {String(d.dossier.evidence_count)} claims · {String(d.dossier.expired_claim_count)} expired · model {String(d.dossier.model ?? "rule")} · next refresh {fmtDay(String(d.dossier.next_refresh_at))}</p>
          {sections.map((s) => (
            <Card key={s.key} title={<span className="flex items-center gap-2">{s.title} <Badge tone={s.status === "known" ? "ok" : s.status === "partial" ? "warn" : "neutral"}>{s.status}</Badge></span>}>
              {s.note && <p className="mb-2 text-xs text-ink-soft">{s.note}</p>}
              {s.claims.length > 0 && (
                <ul className="space-y-2">
                  {s.claims.map((c, i) => (
                    <li key={i} className={`text-sm ${c.expired ? "opacity-60" : ""}`}>
                      <div className="break-words">{c.source.url && s.key === "sources" ? <a className="text-brand underline" href={c.source.url} target="_blank" rel="noopener noreferrer nofollow">{c.text}</a> : c.text}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
                        <FactBadge status={c.status} /><Badge>{EVIDENCE_TIER_LABEL[c.evidence_tier as EvidenceTier] ?? c.evidence_tier}</Badge>
                        <span>observed {c.observed_on ?? "unknown"}</span>{c.published_on && <span>· published {c.published_on}</span>}
                        <span>· expires {c.expires_on ?? "unknown"}</span>{c.expired && <Badge tone="warn">expired — re-verify</Badge>}
                        {c.source.url && s.key !== "sources" && <a className="text-brand" href={c.source.url} target="_blank" rel="noopener noreferrer nofollow">source</a>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
          {falsify.length > 0 && (
            <Card title="Falsification check — what would invalidate the hypothesis?">
              <ul className="list-disc space-y-1 pl-5 text-sm">{falsify.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </Card>
          )}
        </div>
      )}

      {canEdit && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Paste evidence">
            <form action={evidenceAction} className="space-y-3">
              <input type="hidden" name="org_id" value={orgId} />
              <Field label="What does it say?" hint="Stored verbatim as untrusted evidence; it never triggers actions."><Textarea name="text" required minLength={3} maxLength={5000} /></Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Type"><Select name="claim_type" defaultValue="other">{["identity", "footprint", "headcount", "hiring", "funding", "financial", "rto", "consolidation", "gcc_plan", "expansion", "relocation", "other"].map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
                <Field label="Evidence tier"><Select name="evidence_tier" defaultValue="single_unverified">{Object.entries(EVIDENCE_TIER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
                <Field label="Source URL (optional)" hint="Citation only — CRE OS does not fetch it."><Input name="url" type="url" placeholder="https://" /></Field>
                <Field label="Published on"><Input name="published_on" type="date" /></Field>
                <Field label="Function (hiring)"><Input name="function" maxLength={80} /></Field>
                <Field label="Location"><Input name="location" maxLength={80} /></Field>
              </div>
              <Button type="submit">Store evidence</Button>
            </form>
          </Card>
          <div className="space-y-4">
            <Card title="Watchlist tier">
              <form action={watchAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <input type="hidden" name="org_id" value={orgId} /><input type="hidden" name="back" value={`/research/${orgId}`} />
                <Field label="Tier"><Select name="tier" defaultValue={String(d.watch?.tier ?? "active")}><option value="critical">Critical (weekly)</option><option value="active">Active (monthly)</option><option value="universe">Universe (quarterly)</option></Select></Field>
                <Button variant="secondary">Save tier</Button>
              </form>
            </Card>
            <Card title="Web research (optional)">
              <p className="mb-2 text-sm text-ink-soft">Uses the AI gateway&apos;s web search only when an API key is configured and an allowed source exists in the registry, within its rate limit. Results are stored as unverified, cited claims. LinkedIn and paywalled pages are excluded.</p>
              <form action={webResearchAction}><input type="hidden" name="org_id" value={orgId} /><Button variant="secondary">Look for public sources</Button></form>
            </Card>
            <Card title={`Evidence on file (${d.claims.length})`}>
              {d.claims.length === 0 ? <p className="text-sm text-ink-soft">None yet.</p> : (
                <ul className="space-y-1 text-sm">{d.claims.map((c) => <li key={String(c.id)} className="break-words"><Badge>{label(String(c.claim_type))}</Badge> {String(c.predicate ?? "")} <span className="text-xs text-ink-soft">({String(c.observed_on ?? "?")} → {String(c.expires_on ?? "?")})</span></li>)}</ul>
              )}
            </Card>
            {d.versions.length > 1 && <Card title="Versions"><ul className="text-sm">{d.versions.map((v) => <li key={String(v.id)}>v{String(v.version)} · {fmtDay(String(v.generated_at))} · {String(v.synthesis_status)}</li>)}</ul></Card>}
          </div>
        </div>
      )}
    </div>
  );
}

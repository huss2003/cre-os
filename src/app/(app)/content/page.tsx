import { requirePageContext, hasRole } from "@/lib/auth/context";
import { PageHeader, Card, Button, Badge, EmptyState, Field, Select, Input, Textarea } from "@/components/ui";
import { listPosts, voiceSamples } from "@/modules/intelligence/content/service";
import { AUDIENCES, AUDIENCE_LABEL, checklistPasses, type CheckItem } from "@/modules/intelligence/content/editor";
import { Flash, Disclaimer, fmtDay, label } from "@/modules/intelligence/ui";
import { planAction, ideaAction, postAction, voiceAction } from "./actions";

export default async function ContentPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePageContext();
  const canEdit = hasRole(ctx, "editor");
  const isAdmin = hasRole(ctx, "admin");
  const [posts, samples] = await Promise.all([listPosts(ctx.db, ctx.workspaceId), voiceSamples(ctx.db, ctx.workspaceId)]);
  const weeks = [...new Set(posts.map((p) => String(p.week_start)))];

  return (
    <div>
      <PageHeader title="Content" subtitle="Weekly plan, LinkedIn posts and market notes in your voice. You publish manually — CRE OS never posts." actions={canEdit ? <form action={planAction}><Button>Plan this week</Button></form> : null} />
      <Disclaimer>Every draft passes a brand and confidentiality checklist (no client names, personal data, unsourced prices or forecasts) before it can be approved.</Disclaimer>
      <Flash sp={sp} />
      {samples.length === 0 && <p className="mb-4 text-sm text-ink-soft">No voice samples yet — drafts use a neutral template. {isAdmin ? "Add two or three of your past posts below." : "Ask an admin to add your past posts."}</p>}

      {posts.length === 0 ? (
        <Card className="mb-4"><EmptyState title="Nothing planned yet">Use “Plan this week” for two LinkedIn ideas and a market-note slot, or add your own idea below.</EmptyState></Card>
      ) : weeks.map((w) => (
        <Card key={w} title={`Week of ${fmtDay(w)}`} className="mb-4">
          <ul className="divide-y divide-line">
            {posts.filter((p) => String(p.week_start) === w).map((p) => {
              const items = (p.review_checklist ?? []) as CheckItem[];
              const pass = items.length > 0 && checklistPasses(items);
              return (
                <li key={String(p.id)} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1"><span className="font-medium">{String(p.topic)}</span><Badge>{label(String(p.channel))}</Badge><Badge tone="brand">{AUDIENCE_LABEL[p.audience as keyof typeof AUDIENCE_LABEL] ?? String(p.audience)}</Badge><Badge tone={p.status === "approved" || p.status === "published_manually" ? "ok" : "neutral"}>{label(String(p.status))}</Badge></div>
                  {p.published_url ? <a className="text-xs text-brand" href={String(p.published_url)} target="_blank" rel="noopener noreferrer">{String(p.published_url)}</a> : null}
                  {canEdit && p.status !== "published_manually" && (
                    <form action={postAction} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={String(p.id)} />
                      {p.body ? <Textarea name="body" defaultValue={String(p.body)} className="min-h-40" maxLength={3500} /> : null}
                      {items.length > 0 && (
                        <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">{items.map((i) => <li key={i.key} className={i.ok ? "text-ok" : "text-bad"}>{i.ok ? "✓" : "✗"} {i.label} <span className="text-ink-soft">— {i.detail}</span></li>)}</ul>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button variant={p.body ? "secondary" : "primary"} name="op" value="draft">{p.body ? "Redraft" : "Draft it"}</Button>
                        {p.body ? <Button variant="secondary" name="op" value="save">Save &amp; check</Button> : null}
                        {p.body && p.status !== "approved" ? <Button name="op" value="approve" disabled={!pass}>Approve</Button> : null}
                        <Button variant="ghost" name="op" value="discard">Discard</Button>
                      </div>
                      {p.status === "approved" && (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><Field label="Published link (after you post it yourself)"><Input name="url" type="url" placeholder="https://www.linkedin.com/posts/…" /></Field><Button name="op" value="published">Mark published</Button></div>
                      )}
                    </form>
                  )}
                  {(!canEdit || p.status === "published_manually") && p.body ? <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-canvas p-2 text-xs">{String(p.body)}</pre> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {canEdit && (
          <Card title="Add an idea">
            <form action={ideaAction} className="space-y-3">
              <Field label="Topic"><Input name="topic" required minLength={3} maxLength={300} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Audience"><Select name="audience" defaultValue="general">{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</Select></Field>
                <Field label="Channel"><Select name="channel" defaultValue="linkedin"><option value="linkedin">LinkedIn</option><option value="market_note">Market note</option><option value="newsletter">Newsletter</option></Select></Field>
              </div>
              <Button type="submit">Add</Button>
            </form>
          </Card>
        )}
        {isAdmin && (
          <Card title="Your voice">
            <form action={voiceAction} className="space-y-3">
              <Field label="Past posts" hint="Separate posts with a line of three dashes (---). Used only as style reference."><Textarea name="samples" className="min-h-40" defaultValue={samples.join("\n---\n")} /></Field>
              <Button variant="secondary" type="submit">Save samples</Button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}

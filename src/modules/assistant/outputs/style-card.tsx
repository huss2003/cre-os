import { Card, Badge } from "@/components/ui";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import type { AppContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { getStyleProfile } from "./style";
import { rebuildStyleAction, turnOffStyleAction } from "./actions";

const SOURCE: Record<string, string> = { sent_messages: "your sent messages", approved_drafts: "drafts you approved", none: "no messages yet" };

/** Settings card: the user's writing-style profile with Rebuild / Turn off. Server component. */
export async function StyleProfileCard({ ctx }: { ctx: AppContext }) {
  const p = await getStyleProfile(ctx.db, ctx.workspaceId, ctx.userId);
  const s = p?.enabled && p.sample_count ? p.stats : null;
  return (
    <Card title="Your writing style">
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">The assistant matches your tone and length when it prepares drafts. It learns only from your own sent messages (or drafts you approved). Nothing is ever sent.</p>
        {!p ? <p>Not built yet. Press Rebuild to create it.</p>
          : !p.enabled ? <p><Badge tone="neutral">Off</Badge> Drafts use the standard style.</p>
          : !s ? <p>Built {p.built_at ? fmt(p.built_at) : ""} — no messages of yours found yet. Connect your mailbox in Settings → Connections, or approve a few drafts.</p>
          : (
            <>
              <p><Badge tone="ok">On</Badge> From {p.sample_count} of {SOURCE[p.source] ?? p.source}{p.built_at ? `, built ${fmt(p.built_at)}` : ""}.</p>
              {p.summary ? <p>{p.summary}{p.summary_mocked ? <span className="text-xs text-ink-soft"> (offline summary)</span> : null}</p> : null}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-ink-soft">Typical length</dt><dd>{s.medianWords} words</dd>
                <dt className="text-ink-soft">Tone</dt><dd>{s.formality.level}</dd>
                <dt className="text-ink-soft">Greeting</dt><dd>{s.greetings[0]?.text ?? "—"}</dd>
                <dt className="text-ink-soft">Sign-off</dt><dd>{s.signOffs[0]?.text ?? "—"}</dd>
              </dl>
              {s.commonPhrases.length ? <p className="text-xs text-ink-soft">Common phrases: {s.commonPhrases.slice(0, 5).map((x) => `“${x.text}”`).join(", ")}</p> : null}
            </>
          )}
        <div className="flex flex-wrap gap-2">
          <ActionForm action={rebuildStyleAction}><Submit>Rebuild</Submit></ActionForm>
          {p?.enabled !== false ? <ActionForm action={turnOffStyleAction}><Submit variant="secondary">Turn off</Submit></ActionForm> : null}
        </div>
      </div>
    </Card>
  );
}

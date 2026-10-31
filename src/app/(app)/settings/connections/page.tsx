import Link from "next/link";
import { Badge, Button, ButtonLink, Card, Field, Input, PageHeader, StaleBanner } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { fmt } from "@/lib/util/time";
import { URGENT_CATEGORIES, DEFAULT_DND, type AlertPrefs } from "@/modules/integrations/alerts";
import { isProviderConfigured, scopesFor } from "@/modules/integrations/config";
import { staleness } from "@/modules/integrations/sync";
import { connectMockAction, disconnectAction, saveAlertPrefsAction, syncNowAction } from "./actions";

const NAMES = { microsoft: "Microsoft 365 (Outlook mail & calendar)", google: "Google (Gmail & Calendar)" } as const;
const STATUS: Record<string, { label: string; tone: "ok" | "accent" | "warn" | "bad" }> = {
  connected: { label: "Connected", tone: "ok" }, mock: { label: "Mock data (no credentials configured)", tone: "accent" },
  expired: { label: "Expired — reconnect", tone: "warn" }, revoked: { label: "Access revoked — reconnect", tone: "bad" }, error: { label: "Error", tone: "bad" },
};
const CAT_LABEL: Record<string, string> = { near_term_visit: "Near-term site visit requests", commercial_decision: "Commercial decisions", expiring_offer: "Expiring offers", critical_deadline: "Critical deadlines" };
const ERRORS: Record<string, string> = {
  invalid_state: "That sign-in link was already used or is unknown. Start again.", expired_state: "The sign-in took longer than 10 minutes. Start again.",
  wrong_user: "The sign-in was started by a different user.", token_exchange_failed: "The provider did not accept the sign-in. Check the app registration (docs/setup-oauth.md).",
  access_denied: "You declined the permission request.", consent_revoked: "The provider says consent was revoked. Ask your admin to approve the app, then reconnect.",
  forbidden: "Editors and above can connect mailboxes.",
};

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const canEdit = hasRole(ctx, "editor");
  const { data: accounts } = await ctx.db.from("connector_account").select("id, provider, status, scopes, account_email, last_error, token_expires_at, updated_at")
    .eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId);
  const { data: cursors } = await ctx.db.from("connector_cursor").select("connector_account_id, resource, last_success_at, last_attempt_at, last_error")
    .eq("workspace_id", ctx.workspaceId).in("connector_account_id", (accounts ?? []).map((a) => a.id));
  const { data: pref } = await ctx.db.from("user_preference").select("prefs").eq("workspace_id", ctx.workspaceId).eq("user_id", ctx.userId).maybeSingle();
  const prefs = (pref?.prefs ?? {}) as AlertPrefs;
  const err = typeof sp.error === "string" ? ERRORS[sp.error] ?? `Connection failed (${sp.error}).` : null;

  return (
    <div>
      <PageHeader title="Connections" subtitle="Read-only access to your own mailbox and calendar. CRE OS cannot send email, change your calendar or delete anything." />
      {err ? <StaleBanner>{err}</StaleBanner> : null}
      {sp.notice === "not_configured" ? <StaleBanner>OAuth for {String(sp.provider)} is not configured on this server yet. You can use mock data now; an admin can follow docs/setup-oauth.md to enable the real connection.</StaleBanner> : null}
      {sp.connected ? <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm" role="status">{sp.mock ? "Mock connector enabled and synced with sample data." : "Connected. The first sync has been queued."}</p> : null}
      {sp.synced ? <p className="mb-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm" role="status">Sync finished: {String(sp.synced)}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {(["microsoft", "google"] as const).map((p) => {
          const a = (accounts ?? []).find((x) => x.provider === p);
          const configured = isProviderConfigured(p);
          const fresh = a ? staleness((cursors ?? []).filter((c) => c.connector_account_id === a.id)) : [];
          const st = a ? STATUS[a.status] ?? { label: a.status, tone: "warn" as const } : null;
          return (
            <Card key={p} title={NAMES[p]}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>Not connected</Badge>}
                {!configured ? <Badge tone="accent" title="No client id/secret in the server environment">OAuth not configured</Badge> : null}
                {a?.account_email ? <span className="text-ink-soft break-all">{a.account_email}</span> : null}
              </div>
              {a?.last_error ? <p className="mt-2 text-sm text-bad break-words">Last error: {a.last_error}</p> : null}
              {a ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {fresh.map((f) => (
                    <li key={f.resource} className="flex flex-wrap gap-x-2">
                      <span className="w-20 font-medium capitalize">{f.resource}</span>
                      <span className={f.stale ? "text-warn" : "text-ink-soft"}>{f.lastSuccessAt ? `synced ${fmt(f.lastSuccessAt, "dd MMM, HH:mm", ctx.timezone)}` : "never synced"}{f.stale ? " · stale" : ""}</span>
                      {f.error ? <span className="w-full text-xs text-bad break-words">{f.error}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-ink-soft">{p === "google"
                  ? "Recommended first step for Gmail: import selected threads from Drafts → Inbox triage. Read-only Gmail OAuth needs Google’s restricted-scope verification before external users can connect."
                  : "Reads mail and calendar with Mail.Read and Calendars.Read only. Your organisation’s admin may need to approve the app."}</p>
              )}
              <details className="mt-3 text-xs text-ink-soft">
                <summary className="cursor-pointer">Permissions requested</summary>
                <ul className="mt-1 list-disc pl-5 break-all">{(a?.scopes?.length ? a.scopes : scopesFor(p)).map((s: string) => <li key={s}>{s}</li>)}</ul>
              </details>
              {canEdit ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {configured ? <ButtonLink href={`/api/oauth/${p}/start`} prefetch={false}>{a && a.status !== "mock" ? "Reconnect" : "Connect"}</ButtonLink> : null}
                  {!configured && !a ? <form action={connectMockAction}><input type="hidden" name="provider" value={p} /><Button type="submit">Use mock data</Button></form> : null}
                  {a && (a.status === "connected" || a.status === "mock" || a.status === "error") ? (
                    <form action={syncNowAction}><input type="hidden" name="account_id" value={a.id} /><Button type="submit" variant="secondary">Sync now</Button></form>
                  ) : null}
                  {a ? <form action={disconnectAction}><input type="hidden" name="provider" value={p} /><Button type="submit" variant="ghost">Disconnect</Button></form> : null}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <Card title="Urgent alerts" className="mt-6">
        <form action={saveAlertPrefsAction} className="space-y-3">
          <p className="text-sm text-ink-soft">Private notifications to you only, outside work hours, for verified senders on active opportunities. Nothing is ever sent to the client automatically. Off by default.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {URGENT_CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm"><input type="checkbox" name={`cat_${c}`} defaultChecked={(prefs.urgent_categories ?? []).includes(c)} /> {CAT_LABEL[c]}</label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <Field label="Do not disturb from"><Input type="time" name="dnd_start" defaultValue={prefs.dnd?.start ?? DEFAULT_DND.start} /></Field>
            <Field label="until"><Input type="time" name="dnd_end" defaultValue={prefs.dnd?.end ?? DEFAULT_DND.end} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="dnd_off" defaultChecked={prefs.dnd === null} /> No do-not-disturb window</label>
          <Button type="submit" variant="secondary">Save alert settings</Button>
          {sp.saved === "alerts" ? <span className="ml-2 text-sm text-ok" role="status">Saved.</span> : null}
        </form>
      </Card>
      <p className="mt-6 text-xs text-ink-soft">Admins: follow docs/setup-oauth.md in the repository to register the Microsoft Entra app and the Google OAuth client. Manual email import lives in <Link className="underline" href="/drafts?tab=inbox">Drafts → Inbox triage</Link>.</p>
    </div>
  );
}

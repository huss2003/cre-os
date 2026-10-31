/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped (no generated DB types yet) */
import { Suspense } from "react";
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { hasRole } from "@/lib/auth/context";
import { requireAdminPage } from "@/modules/admin/guard";
import { addMemberAction, removeMemberAction, updateMemberAction } from "@/modules/admin/actions/settings";
import { memberDirectory } from "@/modules/admin/entities";
import { CLASSES, ROLES } from "@/modules/admin/members";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { ClassBadge, Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Members" };

const CLASS_LABEL: Record<string, string> = { public: "Public", permitted_personal: "Permitted personal", corporate_confidential: "Corporate confidential", licensed_restricted: "Licensed restricted" };

function ClassChecks({ selected }: { selected: string[] }) {
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <legend className="mb-1 text-sm font-medium">Data classes visible</legend>
      {CLASSES.map((c) => (
        <label key={c} className="flex items-center gap-1.5"><input type="checkbox" name="allowed_classifications" value={c} defaultChecked={selected.includes(c)} />{CLASS_LABEL[c]}</label>
      ))}
    </fieldset>
  );
}

async function Body() {
  const ctx = await requireAdminPage("admin", "/settings/members");
  const isOwner = hasRole(ctx, "owner");
  const [{ data: rows }, names, { data: invites }] = await Promise.all([
    ctx.db.from("membership").select("user_id, role, allowed_classifications, see_all_accounts, display_name, created_at").eq("workspace_id", ctx.workspaceId).order("created_at"),
    memberDirectory(ctx.db, ctx.workspaceId),
    ctx.db.from("tenant_invite").select("id, email, role, method, status, created_at").eq("workspace_id", ctx.workspaceId).order("created_at", { ascending: false }).limit(20),
  ]);
  const members = (rows ?? []) as Record<string, any>[];
  return (
    <div className="space-y-4">
      {isOwner ? (
        <Card title="Add a member">
          <ActionForm action={addMemberAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email"><Input name="email" type="email" required /></Field>
              <Field label="Display name"><Input name="display_name" /></Field>
              <Field label="Role" hint="Owners/admins see all data classes and accounts."><Select name="role" defaultValue="editor">{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
              <Field label="How they get access" hint="CRE OS never sends email. You hand over the password or link yourself.">
                <Select name="method" defaultValue="temp_password"><option value="temp_password">Temporary password</option><option value="invite_link">Invite link</option></Select>
              </Field>
            </div>
            <ClassChecks selected={["public", "permitted_personal"]} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="see_all_accounts" />See all accounts (otherwise only accounts they own or that are shared with them)</label>
            <Submit>Add member</Submit>
          </ActionForm>
        </Card>
      ) : <p className="text-sm text-ink-soft">Only owners can add members or change roles.</p>}

      <Card title={`Members (${members.length})`}>
        {members.length === 0 ? <EmptyState title="No members" /> : (
          <ul className="divide-y divide-line">
            {members.map((m) => {
              const name = m.display_name ?? names.find((n) => n.user_id === m.user_id)?.display_name ?? "Member";
              const self = m.user_id === ctx.userId;
              return (
                <li key={m.user_id} className="py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{name}</span>{self ? <Badge>you</Badge> : null}<Badge tone="brand">{m.role}</Badge>
                    {m.see_all_accounts ? <Badge>all accounts</Badge> : <Badge tone="warn">assigned accounts only</Badge>}
                    {(m.allowed_classifications as string[]).map((c) => <ClassBadge key={c} value={c} />)}
                  </div>
                  <p className="text-xs text-ink-soft">Member since {fmtDate(m.created_at)}</p>
                  {isOwner ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-brand">Change access</summary>
                      <ActionForm action={updateMemberAction.bind(null, m.user_id)} className="mt-2 space-y-3 rounded-lg border border-line p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Display name"><Input name="display_name" defaultValue={m.display_name ?? ""} /></Field>
                          <Field label="Role"><Select name="role" defaultValue={m.role}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
                        </div>
                        <ClassChecks selected={m.allowed_classifications} />
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="see_all_accounts" defaultChecked={m.see_all_accounts} />See all accounts</label>
                        <Submit variant="secondary">Save access</Submit>
                      </ActionForm>
                      {!self ? (
                        <ActionForm action={removeMemberAction.bind(null, m.user_id)} className="mt-2">
                          <Submit variant="danger" confirm={`Remove ${name} from this workspace? Their record shares are revoked too.`}>Remove member</Submit>
                        </ActionForm>
                      ) : null}
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Recent invitations">
        {(invites ?? []).length === 0 ? <p className="text-sm text-ink-soft">No invitations yet.</p> : (
          <ul className="space-y-1 text-sm">{(invites ?? []).map((i) => <li key={i.id}>{i.email} · {i.role} · {i.method.replace(/_/g, " ")} · <Badge tone={i.status === "accepted" ? "ok" : "warn"}>{i.status}</Badge> <span className="text-xs text-ink-soft">{fmtDate(i.created_at)}</span></li>)}</ul>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Members & roles" subtitle="Least privilege: give colleagues only the data classes and accounts they need." />
      <SettingsNav current="/settings/members" />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}

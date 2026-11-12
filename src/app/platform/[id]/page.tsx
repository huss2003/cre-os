import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, Field, Input, PageHeader, Select, Stat, inr } from "@/components/ui";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformPage } from "@/modules/admin/guard";
import { tenantUsage, TENANT_STATUSES } from "@/modules/admin/platform";
import { ROLES } from "@/modules/admin/members";
import { platformAddMemberAction, setTenantStatusAction, updateTenantSettingsAction } from "@/modules/admin/actions/platform";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Tenant" };

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePlatformPage(`/platform/${id}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let u;
  try { u = await tenantUsage(createAdminClient(), ctx.userId, id); } catch { notFound(); }
  const ws = u.workspace;
  return (
    <div className="space-y-4">
      <PageHeader title={ws.name} subtitle={<span className="flex flex-wrap gap-1.5"><Badge>{ws.slug}</Badge><Badge tone={ws.status === "active" ? "ok" : "warn"}>{ws.status}</Badge>{ws.ai_paused ? <Badge tone="warn">AI paused</Badge> : null}</span>} actions={<Link className="text-sm text-brand" href="/platform">All tenants</Link>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Members" value={u.members.length} />
        <Stat label="AI this month" value={inr(u.aiSpend.inr)} hint={`${u.aiSpend.calls} calls · budget ${inr(u.aiSpend.budgetInr)}`} />
        <Stat label="Companies" value={u.records.organisation ?? 0} hint={`${u.records.person ?? 0} people · ${u.records.asset ?? 0} buildings`} />
        <Stat label="Last export" value={u.lastExport ? fmtDate(u.lastExport.started_at) : "never"} hint={u.lastExport?.status} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Status">
          <ActionForm action={setTenantStatusAction.bind(null, id)} className="space-y-3">
            <Field label="Status" hint="Paused/suspended tenants have AI and ingestion stopped. Suspended/archived tenants cannot be lifted by the tenant."><Select name="status" defaultValue={ws.status}>{TENANT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
            <Field label="Reason"><Input name="reason" /></Field>
            <Submit variant="secondary" confirm="Change this tenant's status?">Apply status</Submit>
          </ActionForm>
        </Card>
        <Card title="Budget & currency">
          <ActionForm action={updateTenantSettingsAction.bind(null, id)} className="space-y-3">
            <Field label="Monthly AI budget (₹)"><Input name="budget" inputMode="numeric" defaultValue={String(ws.monthly_ai_budget_inr)} /></Field>
            <Field label="Currency"><Input name="currency" defaultValue={ws.currency} maxLength={3} /></Field>
            <Submit variant="secondary">Save</Submit>
          </ActionForm>
        </Card>
        <Card title="Members">
          <ul className="mb-3 space-y-1 text-sm">{u.members.map((m) => <li key={m.user_id}>{m.display_name ?? m.user_id.slice(0, 8)} <Badge>{m.role}</Badge> <span className="text-xs text-ink-soft">{fmtDate(m.created_at)}</span></li>)}</ul>
          <ActionForm action={platformAddMemberAction.bind(null, id)} className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input name="email" aria-label="Email" type="email" required placeholder="email" />
              <Input name="display_name" placeholder="name" />
              <Select name="role" defaultValue="owner">{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</Select>
              <Select name="method" defaultValue="invite_link"><option value="invite_link">Invite link</option><option value="temp_password">Temporary password</option></Select>
            </div>
            <Submit variant="secondary">Add member</Submit>
          </ActionForm>
        </Card>
        <Card title="Records">
          <ul className="grid grid-cols-2 gap-1 text-sm">{Object.entries(u.records).map(([t, n]) => <li key={t}>{t.replace(/_/g, " ")}: <strong>{n}</strong></li>)}</ul>
        </Card>
      </div>
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense fallback={<Loading variant="detail" />}><Body params={params} /></Suspense>;
}

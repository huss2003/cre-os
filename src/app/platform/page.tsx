import { Suspense } from "react";
import Link from "next/link";
import { Badge, Card, EmptyState, Field, Input, MoreFields, PageHeader, Select, inr } from "@/components/ui";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformPage } from "@/modules/admin/guard";
import { listTenants } from "@/modules/admin/platform";
import { createTenantAction } from "@/modules/admin/actions/platform";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Platform" };

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { active: "ok", paused: "warn", suspended: "bad", archived: "neutral" };

async function Body() {
  const ctx = await requirePlatformPage("/platform");
  const tenants = await listTenants(createAdminClient(), ctx.userId);
  return (
    <div className="space-y-4">
      <Card title="Onboard a tenant">
        <ActionForm action={createTenantAction} className="max-w-md space-y-4">
            <Field label="Tenant name"><Input name="name" required placeholder="e.g. Acme Advisory Pune" /></Field>
            <Field label="Slug" hint="lowercase letters, digits, dashes"><Input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]" /></Field>
            <Field label="Owner email"><Input name="owner_email" type="email" required /></Field>
            <MoreFields>
            <Field label="Owner name"><Input name="owner_name" /></Field>
            <Field label="Time zone"><Input name="timezone" defaultValue="Asia/Kolkata" /></Field>
            <Field label="Currency"><Input name="currency" defaultValue="INR" maxLength={3} /></Field>
            <Field label="Monthly AI budget (₹)"><Input name="budget" inputMode="numeric" defaultValue="3000" /></Field>
            <Field label="Owner access" hint="Nothing is emailed. Hand the link or password over yourself.">
              <Select name="method" defaultValue="invite_link"><option value="invite_link">Invite link</option><option value="temp_password">Temporary password</option></Select>
            </Field>
            </MoreFields>
          <Submit>Create tenant</Submit>
        </ActionForm>
      </Card>

      {tenants.length === 0 ? <EmptyState title="No tenants yet">Create the first tenant above.</EmptyState> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {tenants.map((t) => (
            <li key={t.id} className="rounded-xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-1.5"><Link className="font-medium text-brand" href={`/platform/${t.id}`}>{t.name}</Link><Badge tone={STATUS_TONE[t.status] ?? "neutral"}>{t.status}</Badge>{t.ai_paused ? <Badge tone="warn">AI paused</Badge> : null}</div>
              <p className="text-xs text-ink-soft">{t.slug} · created {fmtDate(t.created_at)}</p>
              <p className="mt-1 text-sm">{t.memberCount} members · {Object.values(t.records as Record<string, number>).reduce((a, b) => a + b, 0)} records</p>
              <p className="text-sm">AI {inr(t.aiSpend.inr)} of {inr(t.aiSpend.budgetInr)} this month</p>
              <p className="text-xs text-ink-soft">Last export: {t.lastExport ? `${fmtDate(t.lastExport.started_at, true)} (${t.lastExport.status})` : "never"}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Tenants" subtitle="Agency console: onboard tenants, suspend or pause them, set AI budgets and see usage." />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}

import { Suspense } from "react";
import { Card, Field, Input, PageHeader, StaleBanner, inr } from "@/components/ui";
import { hasRole } from "@/lib/auth/context";
import { requireAdminPage } from "@/modules/admin/guard";
import { getSettings } from "@/modules/admin/settings";
import { saveGeneralAction, saveRulesAction } from "@/modules/admin/actions/settings";
import { spendSummary } from "@/modules/admin/health";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Facts, Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "Settings" };

async function Body() {
  const ctx = await requireAdminPage("admin", "/settings");
  const s = await getSettings(ctx.db, ctx.workspaceId);
  const ws = s.workspace;
  const spend = await spendSummary(ctx.db, ctx.workspaceId, Number(ws.monthly_ai_budget_inr ?? 0));
  const isOwner = hasRole(ctx, "owner");
  return (
    <>
      {ctx.mfa === "warn" ? <StaleBanner>Owners should enrol an authenticator app. <a className="underline" href="/settings/security">Set up MFA</a> — it becomes mandatory in production.</StaleBanner> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Workspace">
          {isOwner ? (
            <ActionForm action={saveGeneralAction} className="space-y-3">
              <Field label="Name"><Input name="name" defaultValue={ws.name} required /></Field>
              <Field label="Time zone" hint="IANA name, e.g. Asia/Kolkata. Briefs, due dates and 'as of' dates use it."><Input name="timezone" defaultValue={ws.timezone} required /></Field>
              <Field label="Currency" hint="ISO code used for fees and financials, e.g. INR."><Input name="currency" defaultValue={ws.currency} maxLength={3} required /></Field>
              <Submit>Save</Submit>
            </ActionForm>
          ) : <Facts items={[["Name", ws.name], ["Time zone", ws.timezone], ["Currency", ws.currency]]} />}
          <div className="mt-4 border-t border-line pt-3">
            <Facts items={[["Status", ws.status], ["Workspace id", <code key="id" className="text-xs">{ws.slug}</code>]]} />
            <p className="mt-2 text-xs text-ink-soft">Status and the AI budget are managed by the platform administrator.</p>
          </div>
        </Card>

        <Card title="AI budget">
          <Facts items={[
            ["Monthly budget", inr(ws.monthly_ai_budget_inr)],
            ["Spent this month", `${inr(spend.spentInr)}${spend.pctOfBudget !== null ? ` (${spend.pctOfBudget.toFixed(0)}%)` : ""}`],
            ["Model calls", String(spend.calls)], ["Kill switch", ws.ai_paused ? "PAUSED" : "running"],
          ]} />
          <p className="mt-2 text-xs text-ink-soft">When the budget is reached AI features stop and deterministic fallbacks are used. Pause or resume from <a className="text-brand underline" href="/admin">Health</a>.</p>
        </Card>

        <Card title="Operating rules" className="lg:col-span-2">
          <ActionForm action={saveRulesAction} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Minimum requirement size (sf)" hint="Strict boundary; spec default 5,000."><Input name="min_sf" inputMode="numeric" defaultValue={s.sizeRules.min_sf} required /></Field>
              <Field label="Maximum requirement size (sf)" hint="Strict boundary; spec default 200,000."><Input name="max_sf" inputMode="numeric" defaultValue={s.sizeRules.max_sf} required /></Field>
              <Field label="New-company approaches / month (minimum)" hint="Spec default 120."><Input name="approaches_per_month_min" inputMode="numeric" defaultValue={s.cohortTargets.approaches_per_month_min} required /></Field>
              <Field label="New-company approaches / month (pace)" hint="Spec default 170."><Input name="approaches_per_month_pace" inputMode="numeric" defaultValue={s.cohortTargets.approaches_per_month_pace} required /></Field>
              <Field label="Daily brief time" hint="Local time, HH:MM."><Input name="brief_time" type="time" defaultValue={s.briefTime.time} required /></Field>
              <Field label="Evening debrief time"><Input name="debrief_time" type="time" defaultValue={s.briefTime.debrief_time} required /></Field>
            </div>
            <Submit>Save rules</Submit>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Workspace configuration. Admins and owners only." />
      <SettingsNav current="/settings" />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}

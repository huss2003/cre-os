import { Suspense } from "react";
import { Badge, Card, Input, PageHeader } from "@/components/ui";
import { requireAdminPage } from "@/modules/admin/guard";
import { getRetention } from "@/modules/admin/settings";
import { saveRetentionAction } from "@/modules/admin/actions/settings";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading, fmtDate } from "@/modules/admin/ui/parts";

export const metadata = { title: "Retention" };

async function Body() {
  const ctx = await requireAdminPage("admin", "/settings/retention");
  const rows = await getRetention(ctx.db, ctx.workspaceId);
  const approved = rows.filter((r) => r.approved_at);
  return (
    <Card>
      <p className="mb-3 text-sm text-ink-soft">These are the spec&apos;s proposed defaults — confirm them with counsel or your corporate policy. Nothing is purged until an admin saves (approves) the policy. A legal hold overrides deletion. Audit records are append-only and are never deleted by the app.</p>
      {approved.length ? <p className="mb-3 text-xs text-ink-soft">Last approved {fmtDate(approved.map((r) => r.approved_at as string).sort().reverse()[0], true)}.</p> : <p className="mb-3"><Badge tone="warn">Not yet approved — purge job is inactive</Badge></p>}
      <ActionForm action={saveRetentionAction} className="space-y-4">
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.category} className="grid gap-2 py-3 sm:grid-cols-[1fr_120px_auto] sm:items-center">
              <div>
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-ink-soft">{r.basis}{r.review_cadence ? ` · ${r.review_cadence}` : ""}</div>
                <Input name={`note_${r.category}`} defaultValue={r.note ?? ""} placeholder="Note / policy reference" className="mt-1" />
              </div>
              <label className="text-sm"><span className="block text-xs text-ink-soft">Days (blank = keep)</span>
                <Input name={`days_${r.category}`} inputMode="numeric" defaultValue={r.retain_days ?? ""} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name={`hold_${r.category}`} defaultChecked={!!r.legal_hold} className="h-5 w-5" />Legal hold</label>
            </li>
          ))}
        </ul>
        <Submit>Approve retention policy</Submit>
      </ActionForm>
    </Card>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="Retention" subtitle="How long raw audio, transcripts, downloads and audit records are kept." />
      <SettingsNav current="/settings/retention" />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}

import { Suspense } from "react";
import { Badge, Card, PageHeader } from "@/components/ui";
import { hasRole, requirePageContext } from "@/lib/auth/context";
import { FEATURE_KEYS, FEATURES, GROUPS, type AiMode } from "@/lib/ai/policy";
import { callsAvoidedThisMonth, loadAiPolicy } from "@/modules/admin/ai-policy";
import { saveAiPolicyAction } from "@/modules/admin/actions/ai-policy";
import { ActionForm, Submit } from "@/modules/admin/ui/client";
import { mfaStatus } from "@/modules/admin/guard";
import { SettingsNav } from "@/modules/admin/ui/settings-nav";
import { Loading } from "@/modules/admin/ui/parts";

export const metadata = { title: "AI use" };

const MODE_LABEL: Record<AiMode, string> = { off: "Off", backup: "Backup", on: "On" };
const MODE_HELP: Record<AiMode, string> = { off: "code only", backup: "code first, AI if code can't", on: "AI first, code if AI fails" };

async function Body() {
  const ctx = await requirePageContext("viewer");
  const canEdit = hasRole(ctx, "admin");
  const mfa = canEdit ? await mfaStatus(ctx) : "ok";
  const mfaBlocked = mfa === "enrol" || mfa === "verify";
  const policy = await loadAiPolicy(ctx.db, ctx.workspaceId);
  const avoided = canEdit ? await callsAvoidedThisMonth(ctx.db, ctx.workspaceId) : null;

  const rows = (
    <div className="space-y-4">
      {GROUPS.map((g) => (
        <Card key={g.key} title={g.label}>
          <p className="mb-2 text-sm text-ink-soft">{g.description}</p>
          <ul className="divide-y divide-line">
            {FEATURE_KEYS.filter((k) => FEATURES[k].group === g.key).map((k) => {
              const f = FEATURES[k];
              const cur = policy.modes[k];
              return (
                <li key={k} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium">{f.label} {cur === f.default ? <Badge>default</Badge> : <Badge tone="warn">changed · default {MODE_LABEL[f.default as AiMode]}</Badge>}</div>
                    <div className="text-xs text-ink-soft">{f.description}</div>
                  </div>
                  <fieldset className="flex shrink-0 overflow-hidden rounded-full border border-line" disabled={!canEdit || mfaBlocked} aria-label={`${f.label}: AI use`}>
                    {(["off", "backup", "on"] as AiMode[]).map((m) => (
                      <label key={m} title={MODE_HELP[m]} className="cursor-pointer has-[:checked]:bg-brand has-[:checked]:text-white has-[:disabled]:cursor-default">
                        <input type="radio" name={`mode_${k}`} value={m} defaultChecked={cur === m} className="sr-only" />
                        <span className="block min-w-16 px-3 py-2 text-center text-sm">{MODE_LABEL[m]}</span>
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );

  return (
    <>
      <Card>
        <p className="text-sm">AI is used for <strong>{policy.aiCount}</strong> features; <strong>{policy.codeOnlyCount}</strong> run on code only.
          {avoided !== null ? <> AI calls avoided this month: <strong>{avoided}</strong>.</> : null}</p>
        <p className="mt-1 text-xs text-ink-soft">Off = code only. Backup = code first, AI only when code can&apos;t read the input. On = AI first, code if AI fails. Nothing is lost when a feature is Off — it uses rules and templates.</p>
        {!canEdit ? <p className="mt-2"><Badge tone="neutral">View only — an admin can change these</Badge></p> : null}
      </Card>
      <div className="mt-4">
        {canEdit ? (
          <ActionForm action={saveAiPolicyAction} className="space-y-4">
            <input type="hidden" name="version" value={policy.version} />
            {rows}
            <div className="flex flex-wrap gap-2">
              <Submit disabled={mfaBlocked}>Save</Submit>
              <Submit variant="secondary" name="intent" value="reset" confirm="Reset every feature to its default?" disabled={mfaBlocked}>Reset to defaults</Submit>
            </div>
            {mfaBlocked ? (
              <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
                {mfa === "verify" ? "To change AI settings, first confirm your two-step sign-in code in " : "To change AI settings, first turn on two-step sign-in in "}
                <a className="underline" href="/settings/security?next=%2Fsettings%2Fai">Settings → Security</a>.
              </p>
            ) : null}
          </ActionForm>
        ) : rows}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <>
      <PageHeader title="AI use" subtitle="Choose, per feature, whether CRE OS uses code only, AI as a backup, or AI." />
      <SettingsNav current="/settings/ai" />
      <Suspense fallback={<Loading />}><Body /></Suspense>
    </>
  );
}

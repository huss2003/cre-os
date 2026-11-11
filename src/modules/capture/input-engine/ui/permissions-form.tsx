import { ActionForm, Submit } from "@/modules/changes/ui/client";
import { permissionsAction } from "../actions";
import type { InputPermissions } from "../analysis";

/** What the Input Engine may do without asking (rule 14). Material changes and uncertain matches always wait for review. */
export function PermissionsForm({ p }: { p: InputPermissions }) {
  return (
    <ActionForm action={permissionsAction} className="space-y-2 text-sm">
      <label className="flex items-start gap-2"><input type="checkbox" name="auto_save_internal_observations" defaultChecked={p.auto_save_internal_observations} className="mt-1" /> Save internal observations (objections, preferences, hypotheses) without asking</label>
      <label className="flex items-start gap-2"><input type="checkbox" name="auto_create_tasks" defaultChecked={p.auto_create_tasks} className="mt-1" /> Create follow-up tasks right away (a weekday means the next one)</label>
      <label className="flex items-start gap-2"><input type="checkbox" name="auto_associate_high_confidence" defaultChecked={p.auto_associate_high_confidence} className="mt-1" /> Link captures to high-confidence matches automatically (never merges records)</label>
      <Submit variant="secondary">Save</Submit>
    </ActionForm>
  );
}

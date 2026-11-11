-- Workflows round 2 (spec §10.2 Module 5→7, §14.2 event-based integration, Workflows E and G): four more chains on the
-- same workflow_run / workflow_step tables. Only the allowed `kind` values change. Re-runnable.
alter table mudar.workflow_run drop constraint if exists workflow_run_kind_check;
alter table mudar.workflow_run add constraint workflow_run_kind_check check (kind in (
  'signal_chain', 'lease_chain',
  'reply_chain',      -- outreach reply (interested / meeting) → meeting record or "to schedule" task
  'employer_chain',   -- person moved to a new employer → signals, scores, one re-engagement draft
  'feedback_chain',   -- site-visit feedback → shortlist option + re-run saved property comparison
  'meeting_chain'     -- meeting outcome applied → rescore company, check follow-ups
));
-- Sweep lookups for the new triggers.
create index if not exists workflow_run_kind_subject_idx on mudar.workflow_run(workspace_id, kind, subject_id);

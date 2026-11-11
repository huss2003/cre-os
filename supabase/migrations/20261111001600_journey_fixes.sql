-- Journey M1–M3 fixes (re-runnable). Only adds nullable columns: unknown stays null (S6).
-- 1.1 HQ city on company
alter table mudar.organisation add column if not exists hq_city text;
-- 1.2 occupancy (lease): estimate flag + source note + observation date
alter table mudar.lease add column if not exists is_estimate boolean not null default false;
alter table mudar.lease add column if not exists source_note text;
alter table mudar.lease add column if not exists observed_on date;
-- 1.4 property commercial terms on the dated availability snapshot
alter table mudar.availability add column if not exists cam_psf_month numeric;
alter table mudar.availability add column if not exists deposit_months numeric;
alter table mudar.availability add column if not exists rent_free_months numeric;
alter table mudar.availability add column if not exists escalation_pct numeric;
alter table mudar.availability add column if not exists escalation_every_months integer;
alter table mudar.availability drop constraint if exists availability_terms_chk;
alter table mudar.availability add constraint availability_terms_chk check (
  (cam_psf_month is null or cam_psf_month >= 0) and (deposit_months is null or deposit_months >= 0)
  and (rent_free_months is null or rent_free_months >= 0) and (escalation_pct is null or (escalation_pct >= 0 and escalation_pct <= 100))
  and (escalation_every_months is null or escalation_every_months > 0)) not valid;
-- 3.6 review date on manual score overrides
alter table mudar.score_override add column if not exists review_on date;

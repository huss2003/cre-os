-- Run ONCE in the Supabase SQL editor of the production project (free plan works).
-- Vercel Hobby only allows daily cron jobs, so the 5-minute scheduler runs from Supabase:
-- pg_cron calls https://<your-app>/api/cron/tick every 5 minutes with the CRON_SECRET bearer token.
-- Replace the two placeholders below before running. Secrets are stored in Supabase Vault, not in this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://REPLACE-WITH-YOUR-APP.vercel.app', 'cre_os_app_url');
select vault.create_secret('REPLACE-WITH-THE-SAME-CRON_SECRET-AS-VERCEL', 'cre_os_cron_secret');

select cron.unschedule('cre-os-tick') where exists (select 1 from cron.job where jobname = 'cre-os-tick');
select cron.schedule(
  'cre-os-tick',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cre_os_app_url') || '/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cre_os_cron_secret')),
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it is running:   select * from cron.job_run_details order by start_time desc limit 5;
-- Stop it:               select cron.unschedule('cre-os-tick');

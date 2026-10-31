# CRE OS — admin runbook

Audience: agency platform admins and tenant owners/admins. Written as click-by-click steps; SQL is given only where
there is no screen yet. Nothing here needs to be done in routine daily use (spec: "None requires you to run
technical commands in routine operation").

Where things are in the app:

| Screen | Who | What |
|---|---|---|
| `/platform` | Platform admins (agency) | All tenants: create, pause/suspend/reactivate, usage and AI spend |
| `/settings` | Tenant owner/admin | General (name, timezone, currency, AI budget), operating rules (size limits, targets, brief/debrief times), members, retention |
| `/settings/security` | Everyone | MFA enrolment |
| `/settings/connections` | Everyone | Connect/reconnect/disconnect Outlook or Google |
| `/admin` (nav: **Health**) | Tenant owner/admin | Jobs (failed/dead + Retry), connectors, AI spend vs budget, backup status, audit log, kill switch |

Module-specific operational notes live in each module README — see the links in the root [README](../README.md#modules).

> **Build status (31 Oct 2026):** the services behind these screens exist (`src/modules/admin/*`, integrations,
> brief), but the module pages were still being built when this runbook was written. If a button described here is not
> there yet, use the SQL fallback in [§14](#14-sql-fallbacks-until-the-screens-exist) from the Supabase SQL Editor
> (runs as the database owner — bypasses RLS, so always filter by the tenant's workspace).

---

## 1. Onboarding a tenant

Prerequisites (from [launch-dependencies.md](launch-dependencies.md)): signed data-processing agreement (DPA) if any
corporate data will be loaded; tenant has confirmed what they're allowed to import.

1. **Create the tenant** — `/platform` → **New tenant** (see [deploy.md §10](deploy.md#10-first-platform-admin-and-first-tenant)).
   Choose a short slug, timezone `Asia/Kolkata`, currency `INR`, monthly AI budget (start ₹3,000; see
   [costs.md](costs.md)). Method **Invite link**; copy the link and send it to the owner yourself. CRE OS never emails.
2. **Owner first login** — owner opens the link, sets a password, is sent to `/settings/security` to enrol an
   authenticator app (TOTP). In production, owners cannot use admin pages until MFA is done.
3. **Settings → General / Rules** (owner): confirm brief time (default 08:00), debrief time (20:30), deal-size limits
   (default strictly above 5,000 and below 200,000 sq ft), monthly approach targets.
4. **Tenant configuration** — everything that was "Colliers / Jasfo / CRE Matrix" in the spec is per-tenant data:
   - **Partners** (`partner`): fit-out finance partners, referral providers. Record any preferred partner in
     `reliability_preference` — alternatives are still shown (partner neutrality).
   - **Templates** (`template_asset`): upload the tenant's approved PPTX/DOCX/XLSX templates; mark `approved` only after
     the owner has reviewed a rendered sample. Without templates, built-in neutral templates are used and labelled.
   - **Licensed sources** (`licensed_source`): one row per paid data source with licence id, allowed purposes, user
     count, redistribution limits, retention days, whether AI processing and colleague sharing are permitted, expiry.
   - **Data lanes** (`data_lane`): e.g. "Personal/reference" (public + permitted_personal) and "Corporate restricted"
     (corporate_confidential + licensed_restricted). For each, record approved processors
     (`{supabase, vercel, openai}`), approved regions, approval evidence (DPA reference) and date.
5. **Members** (§2).
6. **Connectors** — each user connects their own mailbox/calendar at `/settings/connections` (§5).
7. **Imports** — an editor uploads the tenant's permitted files at `/imports`. Check the reconciliation screen (counts,
   exceptions, quarantined schemas) before accepting. Re-uploading the same file must create no duplicates.
8. **Training** — walk the adviser through [operator-guide.md](operator-guide.md) and do one end-to-end scenario:
   note → task → requirement → shortlist → draft → approval → undo.

## 2. Members, roles and classifications

**Add a member:** `/settings` → Members → **Add member** → email, role, allowed classifications, "sees all accounts",
method (*Invite link* or *Temporary password*) → copy the link/password shown and deliver it yourself through a
different channel than the email address itself if possible.

| Role | Use for |
|---|---|
| owner | The adviser who owns the tenant (also manages members). Keep to 1–2 people. MFA required. |
| admin | Office manager / agency support person who manages settings, health, kill switch. |
| editor | Colleague who captures notes, edits records, prepares drafts. |
| viewer | Read-only (e.g. a manager reviewing pipeline). |

| Classification | Grant when |
|---|---|
| `public`, `permitted_personal` | Default for everyone. |
| `corporate_confidential` | Colleague is allowed to see client/pipeline data. |
| `licensed_restricted` | Only if the licensed source's terms allow this person (check `licensed_source.user_count` / `permits_colleague_sharing`). |

**Sees all accounts** off (recommended for colleagues) means they only see records they own or that are shared with
them. To assign an account: open the company → **Share** → pick the colleague. Remember that sharing is per record; share
the key people/requirements too if they need them.

**Change a role / classifications:** Members → edit. **Remove:** Members → Remove. Removal takes effect on the user's
next request. If the person leaves on bad terms, also do the incident steps for their account: Supabase →
Authentication → Users → the user → **Sign out user / Ban** (or delete), and disconnect their connectors (§5).

A platform admin is not automatically a member of tenant workspaces. If agency staff need to help inside a tenant, the
owner adds them as `admin` temporarily and removes them afterwards (it's audited).

## 3. Kill switch (pause AI and external ingestion)

Use when: AI costs look wrong, a connector is pulling the wrong mailbox, suspected compromise, or the tenant asks to
stop processing.

1. `/admin` → **Pause AI & ingestion** → enter a reason → confirm. (API: `POST /api/v1/admin/pause`.)
2. Effect: `workspace.ai_paused = true`. Every AI call is refused by the gateway (`AiUnavailableError("paused")`);
   ingestion jobs are expected to stop before external fetches. Internal records, tasks, approvals, drafts and the
   deterministic (non-AI) brief keep working, so the adviser still gets an 08:00 action list.
3. Resume: same button → **Resume**. Both actions are written to the audit log.

Platform level: `/platform` → tenant → **Pause** / **Suspend** sets the tenant status and forces `ai_paused`. Suspended
tenants should be used for non-payment or contract end; `archived` stops nightly backups.

## 4. AI budget

- Each tenant has `monthly_ai_budget_inr` (default ₹3,000). The gateway converts it at the planning rate ₹90/USD and
  refuses further AI calls once the month's logged spend reaches it (`budget_exceeded`). The month resets on the 1st at
  00:00 UTC (05:30 IST).
- When the budget is hit: research/dossier jobs show "AI budget reached — research paused"; captures still store raw
  notes; the brief falls back to the deterministic action list. Nothing is lost.
- Change it at `/settings` → General (owner) or `/platform` (agency).
- `/admin` shows spend this month by workflow, failed calls, and the pricing version used. Spec alert levels are
  50/80/100% — check the Health page weekly until automatic alerts exist.
- Second guard: set a hard monthly limit on the OpenAI project key in the OpenAI dashboard (agency-wide).
- Pricing changes: edit `src/lib/ai/pricing.ts`, bump `PRICING_VERSION`, deploy. Old usage rows keep their old version.

## 5. Connector reconnect

Symptoms: brief shows "Inbox stale since …" / "Calendar stale", or `/admin` shows a connector `expired`/`error`.

1. The **affected user** opens `/settings/connections`.
2. Clicks **Reconnect** next to Microsoft or Google → signs in with the same mailbox → accepts the read-only
   permissions.
3. Status returns to `connected`; the next sync (inbox every ~10 min, calendar ~15 min) back-fills. Back-filled old
   messages are logged but never raise urgent alerts.
4. If it fails again immediately: the tenant's IT may have revoked consent or a Conditional Access policy blocks it —
   ask their Entra/Google admin. Meanwhile the user can import selected emails manually (upload `.eml`), and the brief
   keeps labelling the source stale. See [setup-oauth.md](setup-oauth.md) for app-registration issues (expired client
   secret is the most common cause after 6–24 months).

To **disconnect** (user leaving, incident): `/settings/connections` → **Disconnect** (revokes at Google; for Microsoft
also remove the app from the user's "My Apps" or have the Entra admin revoke sessions).

## 6. Failed jobs

All background work (imports, captures, briefs, connector syncs, research, exports) runs as rows in `public.job`.

1. `/admin` → Jobs. States: `queued`, `running`, `succeeded`, `failed` (will retry automatically with back-off),
   `dead` (gave up after `max_attempts`), `cancelled`.
2. Open a failed/dead job to see `last_error`.
3. Common causes and fixes:

| Error mentions | Fix |
|---|---|
| `paused` / `budget_exceeded` | Expected while kill switch is on or budget is used up. Raise budget or resume, then Retry. |
| `no_api_key` | `OPENAI_API_KEY` missing in production → add in Vercel, redeploy. |
| `invalid_grant`, 401 from Graph/Google | Connector needs reconnect (§5). |
| `no handler for job_type` | Code/deploy mismatch — roll back or redeploy the current version. |
| `TOKEN_ENCRYPTION_KEY` | Variable missing or not 32 bytes base64. |
| timeouts | Usually transient; Retry. Repeated → tell the developer (job too large for the 45 s tick budget). |

4. Click **Retry** (only failed/dead/cancelled). Retry resets attempts and is audited. If it says "an equivalent job is
   already queued or succeeded", the work already happened — nothing to do.
5. Jobs that never run at all: check Vercel → Cron Jobs → `/api/cron/tick` is enabled and returning 200 (a 401 means
   `CRON_SECRET` mismatch).

## 7. Backups

Targets (spec §14, proposed for MVP): **RPO 24 hours, RTO 1 working day.**

| Layer | What | Frequency | Where | Who checks |
|---|---|---|---|---|
| 1. Supabase managed backups | Whole database (all tenants) | Daily (Pro plan; retained 7 days on Pro) | Supabase | Admin glances at Dashboard → Database → Backups monthly |
| 2. Logical export job `admin.export` | Every table with `workspace_id`, per tenant, JSON + manifest (counts + SHA-256), AES-GCM encrypted with `TOKEN_ENCRYPTION_KEY` | Nightly 01:30 tenant time | `workspace-files/<ws>/backups/<stamp>/` | `/admin` → Backups shows last success; alert if > 24 h |
| 3. Restore sample `admin.restore_sample` | Re-reads latest export, verifies counts/hashes, flags suppressions/revocations and removed members newer than the export | Monthly (first tick after 03:00 on the 1st) | `backup_run` row (`kind = restore_sample`) | Admin reviews result monthly |
| 4. Off-site copy | Copy of layer 2 **and of uploaded files** to a separately approved store | Weekly (manual until automated) | Agency-controlled storage (e.g. encrypted drive or a separate cloud bucket) | Admin |
| 5. Full restore drill | Restore into a scratch project and test the app | Quarterly | Scratch Supabase project | Admin + developer |

Important limits — read these:

- Supabase database backups **do not include Storage files** (uploaded originals, call audio, generated decks). The
  logical export is also table rows only. Layer 4 must copy the `workspace-files` bucket too (Supabase Storage
  supports the S3 protocol, so tools like `rclone` or `aws s3 sync` can copy it with S3 keys from Project Settings →
  Storage).
- Layer 2 lives in the same Supabase project as the live data; it protects against bad edits, not against losing the
  project. That's why layer 4 exists.
- Exports are only decryptable with `TOKEN_ENCRYPTION_KEY`. Keep the escrow copy.

**Weekly off-site copy (manual):** developer or admin runs, from a trusted machine with S3 credentials for the project:

```bash
# one-time: create S3 access keys in Supabase → Project Settings → Storage → S3 Connection
rclone sync supabase:workspace-files /secure/backup/cre-os/workspace-files-$(date +%Y%m%d)
```

Keep 4 weekly + 3 monthly copies. Record each copy in the tenant's backup log (Health page note, or a
`backup_run` row of kind `managed_backup_check`).

**Monthly restore sample review:** `/admin` → Backups → latest *restore sample*:
`succeeded` = fine; `warning` = read the hazards list (these are exactly the records you must re-suppress after any
restore); `failed` = integrity mismatch — tell the developer the same day.

**Quarterly drill:** do §8 into a scratch project, time it, and write the result (date, duration, issues) as a
`backup_run` of kind `restore_drill`. Spec acceptance test "Backups": restore within target, and no revoked account or
suppressed contact is reactivated.

## 8. Restore procedure

Decide first **what** is broken:

| Situation | Use |
|---|---|
| A few records were wrongly changed by a capture/import/model | **Undo** in Approvals / change history (compensating reversal). No restore needed. |
| One tenant's data damaged (bad import, mistaken bulk archive) | Restore a copy to a **scratch project**, then copy back only that tenant's affected rows (developer task). |
| Whole project lost or corrupted | Supabase restore of the daily backup (or restore-to-new-project), then re-point Vercel. |

Steps for a full restore (target: done within one working day):

1. **Pause**: `/platform` → pause every affected tenant (stops AI/ingestion and new writes from jobs). Tell users.
2. **Preserve evidence**: export the current `audit_event` and `backup_run` tables (SQL Editor → run
   `select * from public.audit_event where occurred_at > now() - interval '30 days'` → Download CSV) before
   overwriting anything.
3. **Restore**:
   - Preferred: Supabase Dashboard → **Database → Backups** → choose the backup → **Restore to a new project** (where
     offered) → region Mumbai. Otherwise restore in place (this overwrites the database — only after step 2).
   - If the managed backup is unusable: create a new project, `npx supabase db push` the migrations, then load the
     latest logical export (decrypt each `<table>.json.enc` with `TOKEN_ENCRYPTION_KEY` and insert in dependency order
     with triggers disabled). *A loader script for this is not yet in the repo — budget developer time for it.*
4. **Files**: copy the latest off-site `workspace-files` copy back into the bucket (layer 4).
5. **Re-apply safety state** (critical): open the newest restore-sample findings and the current-day audit export.
   Re-suppress every contact/consent revocation and remove every member listed as newer than the backup. Check
   `suppression_tombstone` rows exist for all erased contacts. Revoked connector tokens must stay revoked — ask users to
   reconnect rather than reusing restored tokens.
6. **Re-point** (only if a new project): update `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SECRET_KEY` in Vercel → Redeploy; redo Auth URL configuration ([deploy.md §3](deploy.md#3-configure-auth)).
7. **Verify**: log in as an owner and as a restricted colleague; colleague still cannot see unshared/restricted records;
   counts on Companies/Requirements look right; `/admin` health green.
8. **Resume** tenants, tell users which time window (between backup and incident) they need to re-capture.

## 9. Incident response

Triggers: suspected account takeover, leaked secret, a connector reading the wrong mailbox, data sent to the wrong
place, or a tenant reports unexpected access.

1. **Contain (first 30 minutes)**
   - Pause affected tenants (`/platform`) or the specific workspace kill switch (`/admin`).
   - Suspected user compromise: Supabase → Authentication → Users → user → **Sign out** (revokes refresh tokens) and
     reset password / ban; remove their membership if needed.
   - **Revoke connector tokens**: user disconnects at `/settings/connections`; tenant IT revokes the app's consent in
     Entra (Enterprise applications → CRE OS → Permissions/Users → remove) or Google (Account → Security → Third-party
     access) — do this even if the user can't log in.
   - Leaked secret: rotate it (Supabase secret key: create new → update Vercel → redeploy → delete old;
     `CRON_SECRET`: new value → redeploy; OpenAI key: revoke/create; OAuth client secret: new secret in Entra/Google →
     update Vercel). `TOKEN_ENCRYPTION_KEY` leak: rotate key, then everyone reconnects; old exports remain readable only
     with the old key — keep it sealed.
2. **Preserve evidence** — do not delete anything. Download `audit_event`, `job`, `model_usage`, `connector_account`
   (without tokens), Vercel logs (Project → Logs → export) and Supabase Auth logs for the period. Note times in IST.
3. **Assess** — which tenants, which records/classifications, which people's personal data, whether anything left the
   system (CRE OS cannot send messages, so look at exports/downloads and connector scopes).
4. **Notify** — the tenant owner immediately; the tenant decides on notifying their employer, clients and the
   regulator. Follow the DPA's breach clause and timelines; counsel advises on DPDP obligations. Use the
   corporate/processor incident channels named in the DPA. Supabase/Vercel/OpenAI support if their side is involved.
5. **Recover** — fix the cause, restore if needed (§8), resume, and write a short post-incident note (what, when,
   impact, fix, follow-ups).

## 10. Retention defaults

Seeded per tenant from spec §14. They are **proposals for the tenant to approve**, not legal minima. Legal hold
overrides deletion.

| Category | Default | Clock starts |
|---|---|---|
| Raw consented call/voice audio | 30 days | after transcript verification |
| Working transcripts | 180 days | after creation, unless deal/legal policy requires otherwise |
| Temporary research downloads | 30 days | after download |
| Public fact observations | keep | retained with provenance and staleness labels |
| Contact & relationship records | keep while relevant | review at least annually |
| Audit records | 365 days | 12 months or applicable corporate requirement |

Owner reviews and saves them at `/settings` → Retention (records who approved and when).

**Current status:** retention values are stored, but an automatic purge job is **not built yet**. Until it is, the
admin does a monthly manual purge (developer-assisted SQL/storage cleanup) and records it. Managed backups age out on
their own (7 days on Pro); off-site copies follow the 4-weekly/3-monthly rotation above.

## 11. Data deletion and suppression propagation

When a person asks not to be contacted, or to have their data erased, or a contact is wrong:

1. Open the person → **Suppress** (opt-out / wrong contact) or **Erase** (erasure request). This:
   - marks their `contact_method` rows `suppressed`, revokes `consent_permission`, and
   - writes a `suppression_tombstone` (hash of the email/phone, method, reason) that **survives deletion**, so the same
     address can never be re-imported into an outreach draft. Draft creation checks both person-level and
     address-level suppression and refuses.
2. Active outreach sequences for that person are paused automatically.
3. For erasure, also remove or redact: interactions/notes about the person (keep a minimal tombstone), capture
   transcripts mentioning them where feasible, generated documents in storage that name them, and research downloads.
4. **Backups:** you cannot edit managed backups. Instead, after any restore, re-apply tombstones and suppressions
   (restore procedure step 5). Note the erasure date so off-site copies older than it are deleted on schedule rather
   than restored.
5. Log the request, date, what was done, and who did it (the audit log captures the record changes; add a note on the
   person/tombstone).

Requests about the **tenant's own** users (staff) are handled by removing the membership and, if asked, deleting the
Supabase Auth user (their authored rows keep a null/foreign author id).

## 12. Monthly / quarterly checklist

Monthly (30 minutes):
- [ ] `/admin` health: no dead jobs older than a week; connectors connected; brief delivered on time all month.
- [ ] Restore-sample result reviewed.
- [ ] Off-site copies present (4 weekly).
- [ ] AI spend per tenant vs budget ([costs.md](costs.md)); OpenAI / Supabase / Vercel invoices match expectations.
- [ ] Manual retention purge done (until automated).
- [ ] Dependency/security updates applied by the developer (`npm audit`, Next.js/Supabase patch releases).

Quarterly:
- [ ] Full restore drill (§7 layer 5).
- [ ] Access review: each tenant's members, roles, classifications, record shares; remove leavers.
- [ ] OAuth client-secret expiry dates checked; licensed-source expiry dates checked.
- [ ] Re-read [launch-dependencies.md](launch-dependencies.md) for each tenant.

## 13. Admin recovery

| Problem | Recovery |
|---|---|
| Owner lost their authenticator phone | Another owner or a platform admin: Supabase → Authentication → Users → the user → **Factors** → delete the TOTP factor (or SQL `delete from auth.mfa_factors where user_id = '<uuid>';`). The user logs in with password and re-enrols. Verify identity out-of-band first. |
| Owner forgot password | Supabase → Authentication → Users → user → **Send password recovery** (needs SMTP), or set a temporary password there and share it out-of-band. |
| Only owner left the company / unreachable | Platform admin adds a new owner: `/platform` → tenant → add member as `owner` (or SQL insert into `membership`). Audited. |
| All platform admins locked out | Someone with access to the Supabase organisation runs: `insert into public.platform_admin(user_id) select id from auth.users where email = '…';` in the SQL Editor. This is why the Supabase organisation must have ≥ 2 agency owners. |
| Lost access to the Supabase organisation | Supabase support with proof of ownership (billing). Keep org owners ≥ 2 and recovery codes in the password manager. |
| Lost access to Vercel / GitHub | Same principle: two agency owners on the Vercel team and GitHub repo; recovery codes stored. |
| `TOKEN_ENCRYPTION_KEY` lost | Generate a new key, set it in Vercel, redeploy; every user reconnects connectors. Old exports are unrecoverable — take a fresh export immediately and keep the new key in escrow. |
| MFA enforcement blocking first-time setup | Temporarily set `OWNER_MFA_ENFORCE=false` in Vercel, redeploy, enrol, then remove it and redeploy. |

## 14. SQL fallbacks (until the screens exist)

Supabase → **SQL Editor**. Replace the placeholders. Each statement touches one workspace only. Business-table
changes are captured by the audit trigger automatically (actor shows as `system`); for workspace-level actions add the
explicit audit row shown.

```sql
-- Find the workspace id
select id, name, slug, status, ai_paused, monthly_ai_budget_inr from public.workspace order by name;

-- Kill switch on / off (+ audit)
update public.workspace set ai_paused = true, updated_at = now() where id = '<ws>';
insert into public.audit_event (workspace_id, actor_kind, action, entity_type, entity_id, after, classification)
values ('<ws>', 'system', 'pause', 'workspace', '<ws>', '{"ai_paused":true,"reason":"<why>"}', 'corporate_confidential');

-- AI budget (INR per month)
update public.workspace set monthly_ai_budget_inr = 5000, updated_at = now() where id = '<ws>';

-- This month's AI spend (USD) by workflow
select workflow, round(sum(estimated_usd)::numeric, 4) usd, count(*) calls, count(*) filter (where not ok) failed
from public.model_usage
where workspace_id = '<ws>' and occurred_at >= date_trunc('month', now() at time zone 'utc')
group by 1 order by 2 desc;

-- Members
select m.role, u.email, m.allowed_classifications, m.see_all_accounts
from public.membership m join auth.users u on u.id = m.user_id where m.workspace_id = '<ws>';

-- Share (assign) one record to a colleague / remove the share
insert into public.record_share (workspace_id, entity_type, entity_id, user_id)
values ('<ws>', 'organisation', '<org id>', (select id from auth.users where email = '<colleague email>'));
delete from public.record_share where workspace_id = '<ws>' and entity_id = '<org id>'
  and user_id = (select id from auth.users where email = '<colleague email>');

-- Failed / dead jobs and retry
select id, job_type, state, attempts, left(last_error, 200) err, updated_at
from public.job where workspace_id = '<ws>' and state in ('failed','dead') order by updated_at desc;
update public.job set state = 'queued', attempts = 0, due_at = now(), lease_until = null, locked_by = null
where id = '<job id>' and workspace_id = '<ws>' and state in ('failed','dead','cancelled');

-- Backup status
select kind, status, started_at, finished_at, bytes, error, findings
from public.backup_run where workspace_id = '<ws>' order by started_at desc limit 10;

-- Suppress a person (opt-out / wrong contact / erasure) and keep a tombstone that survives deletion
update public.contact_method set suppressed = true where workspace_id = '<ws>' and person_id = '<person id>';
update public.consent_permission set suppressed = true, revoked_at = coalesce(revoked_at, now())
where workspace_id = '<ws>' and person_id = '<person id>';
insert into public.suppression_tombstone (workspace_id, value_hash, method_type, reason, person_id, note)
select workspace_id, value_hash, method_type, 'opt_out', person_id, '<request ref / date>'
from public.contact_method where workspace_id = '<ws>' and person_id = '<person id>'
on conflict (workspace_id, method_type, value_hash) do nothing;
```

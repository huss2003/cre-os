# Deploying CRE OS (Supabase cloud + Vercel)

Audience: the agency owner doing it by clicking, with a developer available for the two terminal steps.
Target: Supabase project in **Mumbai (`ap-south-1`)**, Vercel project in **Mumbai (`bom1`)**, code in GitHub
**`huss2003/cre-os`**.

Current status (31 Oct 2026): runs locally only. The Supabase organisation has hit the Free-plan limit of active
projects, so the cloud project needs either a paused/deleted old project or an upgrade to Pro (recommended for
production anyway — see [costs.md](costs.md)).

Time needed: about 1.5–2 hours the first time.

Contents
1. [Before you start](#1-before-you-start)
2. [Create the Supabase project](#2-create-the-supabase-project)
3. [Configure Auth](#3-configure-auth)
4. [Push the database](#4-push-the-database-migrations)
5. [Check storage](#5-check-storage)
6. [Create the Vercel project](#6-create-the-vercel-project)
7. [Environment variables](#7-environment-variables)
8. [Cron (scheduler)](#8-cron-the-scheduler)
9. [Custom domain](#9-custom-domain)
10. [First platform admin and first tenant](#10-first-platform-admin-and-first-tenant)
11. [Rollback](#11-rollback)
12. [Go-live checklist](#12-go-live-checklist)

---

## 1. Before you start

You need:

- [ ] A GitHub account with access to `huss2003/cre-os`.
- [ ] A Supabase account (an **organisation** owned by the agency, not by a freelance developer).
- [ ] A Vercel account on the **Pro** plan (Hobby only allows a once-a-day cron and is for non-commercial use).
- [ ] A password manager to store every secret below.
- [ ] Optional now, needed later: OpenAI API key, Microsoft Entra app, Google OAuth client
      ([setup-oauth.md](setup-oauth.md)). Without them the app runs in **mock mode** — safe, but AI and
      connectors return placeholder results.
- [ ] A developer machine with Node 22+, `npm i` done in the repo, and the Supabase CLI (installed as a dev
      dependency: `npx supabase --version`).

Generate two secrets now and save them in the password manager:

```bash
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY  (must decode to exactly 32 bytes)
openssl rand -hex 32      # → CRON_SECRET
```

> **TOKEN_ENCRYPTION_KEY is precious.** It encrypts connector tokens *and* the nightly backup exports. Keep a
> second, offline copy (e.g. printed and sealed). If it is lost, every user must reconnect Outlook/Gmail and old
> exports cannot be decrypted.

---

## 2. Create the Supabase project

1. Go to <https://supabase.com/dashboard> and sign in.
2. If you see "project limit reached": open the old project you no longer need → **Project Settings → General →
   Pause project** (or delete it), **or** upgrade the organisation: **Organization → Billing → Change plan → Pro**.
3. Click **New project**.
   - Organisation: the agency's organisation.
   - Name: `cre-os-prod`.
   - Database password: click **Generate**, then copy it into the password manager.
   - Region: **South Asia (Mumbai) — `ap-south-1`**.
   - Compute: Micro is fine to start (included in Pro's compute credit).
4. Click **Create new project** and wait (~2 minutes).
5. Write down, from **Project Settings**:
   - **General → Reference ID** (looks like `abcdefghijklmnopqrst`) → `PROJECT_REF`.
   - **API Keys** → the **Publishable key** (`sb_publishable_…`) and a **Secret key** (`sb_secret_…`; create one if
     none exists). The secret key is the service role — never paste it anywhere public.
   - **Data API → Project URL** (`https://<ref>.supabase.co`).
6. **Database → Settings** (or **Project Settings → Database**): leave "Enforce SSL" on.
7. Pro plan only: **Database → Backups** should show "Daily backups" enabled. Point-in-time recovery is an optional
   paid add-on; not required for the 24-hour RPO target.

## 3. Configure Auth

In the Supabase dashboard, **Authentication**:

1. **URL Configuration**
   - **Site URL:** your production URL, e.g. `https://app.<your-domain>` (use the `*.vercel.app` URL until the domain
     is ready, then come back and change it).
   - **Redirect URLs** — add each of these:
     - `https://app.<your-domain>/auth/callback`
     - `https://app.<your-domain>/**`
     - `https://<project>.vercel.app/**` (production Vercel URL)
     - `https://*-<your-vercel-team>.vercel.app/**` only if you want preview deployments to log in (optional).
2. **Sign In / Providers → Email**: enabled. Turn **"Confirm email"** on.
3. **Sign In / Providers → User Signups**: turn **"Allow new users to sign up" OFF.** Tenants and members are created
   by admins only. (Invites and temporary passwords created from the app still work, because they use the admin API.)
4. **Multi-Factor → TOTP (App Authenticator)**: **Enabled** (both enrol and verify). Leave phone MFA off.
5. **Sign In / Providers → Password**: set minimum length 12 (local dev uses 6).
6. **Emails / SMTP**: CRE OS itself sends no email. Supabase's built-in mailer (used only for password resets and
   email-change confirmation) is rate-limited; for production add your own SMTP under **Emails → SMTP Settings**
   (e.g. the agency's transactional mail provider). Invite links are shown in the app for the admin to copy, so
   onboarding does not depend on SMTP.
7. **Rate Limits**: defaults are fine.

The repo's `supabase/config.toml` is for **local** development only (sign-ups on, MFA off, 6-char passwords). Do not
`supabase config push` it to production.

## 4. Push the database migrations

On the developer machine, in the repo folder:

```bash
npx supabase login                          # opens a browser; log in to the agency account
npx supabase link --project-ref PROJECT_REF # asks for the database password from step 2
npx supabase db push --dry-run              # shows which migrations will run
npx supabase db push                        # applies supabase/migrations/*.sql in timestamp order
```

- **Do not** use `--include-seed`. `supabase/seed.sql` creates `owner@cre-os.local` etc. with the password
  `password123` and must never exist in production.
- Migrations are timestamped; core files `20261031000100–000300`, then one per module (`001000`–`001699`).
- After the push: **Table Editor** should show tables such as `workspace`, `membership`, `organisation`,
  `change_proposal`, `draft`, `job`, `backup_run`. **Database → Roles/Schemas** should show schema `app`.
- In **Project Settings → Data API → Exposed schemas**, make sure both `public` **and `app`** are listed (the job
  queue and several RPCs live in `app`; locally this comes from `config.toml`). Add `app` if missing and save.

## 5. Check storage

The migration creates a private bucket. In **Storage**:

- [ ] Bucket **`workspace-files`** exists and is **not public**.
- [ ] Under **Policies**, two policies on `storage.objects`: "ws files read" and "ws files write".
- [ ] **Storage → Settings**: global upload limit at least 50 MB (local default) so audio captures and workbooks fit.

## 6. Create the Vercel project

1. <https://vercel.com/new> → **Import Git Repository** → choose `huss2003/cre-os` (install the Vercel GitHub app for
   that repo if asked).
2. Framework preset: **Next.js** (auto-detected). Root directory: `/`. Build command / output: defaults.
3. Before clicking Deploy, open **Environment Variables** and add everything in [§7](#7-environment-variables).
4. Click **Deploy**. The first build takes a few minutes.
5. **Settings → Functions → Function Region**: confirm **Mumbai, India (`bom1`)**. `vercel.json` already sets
   `"regions": ["bom1"]`, so the database and the functions sit in the same city.
6. **Settings → Git**: Production branch = `main`. Every push to `main` deploys production; other branches create
   preview deployments.
7. **Settings → Deployment Protection**: keep Vercel Authentication on for **Preview** deployments so previews aren't
   public.

## 7. Environment variables

Add in **Vercel → Project → Settings → Environment Variables**. Mark "Production" (and "Preview" only if previews
should work against production data — normally **don't**; give previews a separate Supabase project or leave them
broken).

| Name | Required | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | `sb_publishable_…` |
| `SUPABASE_SECRET_KEY` | yes | `sb_secret_…` (sensitive) |
| `CRON_SECRET` | yes | from step 1 (sensitive) |
| `TOKEN_ENCRYPTION_KEY` | yes | from step 1 (sensitive) |
| `APP_URL` | yes | `https://app.<your-domain>` (no trailing slash). Used for OAuth redirect URIs and invite links. |
| `OPENAI_API_KEY` | for real AI | leave empty = mock mode |
| `OPENAI_MODEL_LUNA` / `OPENAI_MODEL_SOL` / `OPENAI_MODEL_TRANSCRIBE` | no | override model pins (`gpt-6-luna`, `gpt-6.1-sol`, `gpt-4o-mini-transcribe`). If you change one, bump `PRICING_VERSION` in `src/lib/ai/pricing.ts`. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | for Outlook | see [setup-oauth.md](setup-oauth.md); empty = mock connector |
| `MICROSOFT_TENANT_ID` | recommended | tenant's Entra directory id; default `common` |
| `MICROSOFT_ENABLE_SELECTED_FILES` | no | `1` to request `Files.SelectedOperations.Selected` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Gmail/Google Calendar | see [setup-oauth.md](setup-oauth.md) |
| `OWNER_MFA_ENFORCE` | no | default: enforced when `NODE_ENV=production`. Set `false` only temporarily during first setup if locked out. |

`DATABASE_URL` is only used by local tooling (psql/tests); Vercel doesn't need it.

After changing any variable: **Deployments → … on the latest → Redeploy** (variables apply to new deployments only).

## 8. Cron (the scheduler)

`vercel.json` declares:

```json
{ "crons": [ { "path": "/api/cron/tick", "schedule": "*/5 * * * *" } ] }
```

- Every 5 minutes Vercel calls `GET /api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` (Vercel adds the header
  automatically when `CRON_SECRET` is set). The route runs every module's scheduler, then drains due jobs for up to
  45 s (`maxDuration = 60`).
- **Requires Vercel Pro.** On Hobby, cron jobs run at most once per day, which breaks the 08:00 brief, inbox sync and
  T-60 meeting briefs.
- Check: **Vercel → Project → Settings → Cron Jobs** lists `/api/cron/tick`, enabled. Click **Run** once and confirm
  **Logs** show a 200 with JSON like `{"ran":0,"failed":0,...}`. A 401 means `CRON_SECRET` is missing/mismatched.
- Cron schedules are UTC, but each job computes its own due time in the tenant's timezone (default `Asia/Kolkata`).
  With a 5-minute tick, a job due at 07:40 runs between 07:40 and 07:45.
- Fallbacks if Vercel Cron is unavailable: Supabase `pg_cron` + `pg_net` calling the same URL with the bearer header,
  or any external uptime pinger that can send a header. Never run two schedulers *without* the secret.

## 9. Custom domain

1. **Vercel → Project → Settings → Domains → Add** `app.<your-domain>`.
2. At your DNS provider, add the record Vercel shows (usually `CNAME app → cname.vercel-dns.com`). Wait for the green
   tick (minutes to a few hours). HTTPS certificates are automatic.
3. Update `APP_URL` in Vercel to the new domain and redeploy.
4. Update Supabase **Auth → URL Configuration** Site URL / Redirect URLs (step 3).
5. Update the redirect URIs in the Microsoft Entra app and Google OAuth client to
   `https://app.<your-domain>/api/oauth/microsoft/callback` and `…/api/oauth/google/callback`.

## 10. First platform admin and first tenant

### 10.1 Create the agency admin user

1. Supabase → **Authentication → Users → Add user → Create new user**. Email = agency admin's real email, a strong
   password, tick **Auto Confirm User**.
2. Supabase → **SQL Editor → New query**, paste, replace the email, **Run**:

```sql
insert into public.platform_admin (user_id)
select id from auth.users where lower(email) = lower('admin@your-agency.example');
```

3. Open `https://app.<your-domain>/login`, sign in. You'll land on `/no-workspace` (normal — you belong to no tenant
   yet). Go to **`/settings/security`** (or follow the MFA prompt) and enrol an authenticator app (TOTP). Save the
   recovery approach (§ "Admin recovery" in [admin-runbook.md](admin-runbook.md#13-admin-recovery)).

Create **at least two** platform admins (spec: no single person or developer may be the only admin).

### 10.2 Create the first tenant — preferred: the `/platform` page

Go to **`/platform`** → **New tenant** → name, slug (e.g. `pune-occupier`), timezone `Asia/Kolkata`, currency `INR`,
monthly AI budget (₹3,000 default), owner email, method **Invite link** → **Create**. Copy the invite link it shows and
send it to the tenant owner yourself (WhatsApp/email from your own account). The page also seeds default settings and
retention rows.

### 10.3 Fallback: SQL (if `/platform` is unavailable)

First create the owner in **Authentication → Users → Add user** (auto-confirm, temporary password), then:

```sql
with ws as (
  insert into public.workspace (name, slug, timezone, currency, monthly_ai_budget_inr)
  values ('Pune Occupier Services', 'pune-occupier', 'Asia/Kolkata', 'INR', 3000)
  returning id
), owner as (
  select id from auth.users where lower(email) = lower('owner@tenant.example')
)
insert into public.membership (workspace_id, user_id, role, allowed_classifications, see_all_accounts, display_name)
select ws.id, owner.id, 'owner',
       array['public','permitted_personal','corporate_confidential','licensed_restricted']::public.classification[],
       true, 'Tenant Owner'
from ws, owner;

-- default operating settings (same as the /platform page)
insert into public.workspace_setting (workspace_id, key, value)
select id, k, v::jsonb from public.workspace,
  (values ('size_rules','{"min_sf":5000,"max_sf":200000}'),
          ('cohort_targets','{"approaches_per_month_min":120,"approaches_per_month_pace":170}'),
          ('brief_time','{"time":"08:00","debrief_time":"20:30"}')) s(k, v)
where slug = 'pune-occupier';
```

Retention defaults appear on the tenant's retention settings screen and can be saved from there. Give the owner the
temporary password through a separate channel and ask them to change it and enrol MFA on first login.

Then follow [admin-runbook.md → Onboarding a tenant](admin-runbook.md#1-onboarding-a-tenant) for members, data lanes,
templates, licensed sources and connectors.

## 11. Rollback

### Application (Vercel) — instant

1. **Vercel → Project → Deployments**.
2. Find the last good production deployment → **⋯ → Instant Rollback** (Pro can roll back to any earlier production
   deployment). Takes seconds; no rebuild.
3. Rolled-back state disables auto-promotion of new pushes until you **Promote** a deployment again — fix forward on a
   branch, test the preview, then promote.
4. Environment variable mistakes: fix the variable and **Redeploy**; rollback re-uses the old deployment's variables
   only if they were unchanged.

### Database — forward-fix, not down-migrations

There are no "down" migrations. Policy:

1. **Every migration is additive and backwards-compatible** with the previous app deployment for at least one release
   (add columns/tables first, deploy code, remove old things in a later migration). Then a Vercel rollback never
   meets a schema it can't read.
2. If a migration is wrong, write a **new** migration that corrects it (`supabase migration new fix_xyz`), test locally
   (`npm run db:reset`), then `npx supabase db push`.
3. Never edit a migration file that has already been pushed — the CLI tracks applied versions in
   `supabase_migrations.schema_migrations`.
4. If data was damaged: use the restore procedure in [admin-runbook.md](admin-runbook.md#8-restore-procedure)
   (restore to a new project, compare, copy back the affected rows), not a blind full restore over production.
5. Before any risky migration: trigger a manual backup (Supabase → Database → Backups, if available on the plan) and
   make sure last night's logical export succeeded (`/admin` Health page).

## 12. Go-live checklist

Infrastructure
- [ ] Supabase project in `ap-south-1`, organisation on **Pro**, daily backups visible.
- [ ] Vercel on **Pro**, functions region `bom1`, cron `/api/cron/tick` every 5 min returning 200.
- [ ] Custom domain with HTTPS; `APP_URL`, Supabase Site URL/Redirect URLs, OAuth redirect URIs all use it.
- [ ] Exposed schemas include `public` and `app`.
- [ ] Seed **not** applied: no `*@cre-os.local` users in Authentication → Users.

Security
- [ ] Public sign-ups disabled; email confirmation on; min password length ≥ 12.
- [ ] TOTP MFA enabled in Supabase; every owner and platform admin has enrolled.
- [ ] Two platform admins exist; neither is a developer's personal account only.
- [ ] `TOKEN_ENCRYPTION_KEY` stored in password manager **and** offline.
- [ ] OpenAI project key has a hard monthly limit in the OpenAI dashboard.
- [ ] No secrets in GitHub (`git grep -i "sb_secret\|sk-"` returns nothing).
- [ ] Preview deployments protected (or not wired to production data).
- [ ] Known gaps in [security-model.md §11](security-model.md#11-known-gaps-and-hardening-backlog) reviewed and accepted.

Per-tenant (before importing corporate data)
- [ ] Data-processing agreement signed; `data_lane` approval recorded ([launch-dependencies.md](launch-dependencies.md)).
- [ ] Licensed sources registered with their actual rights.
- [ ] Retention settings reviewed and saved by the tenant owner.
- [ ] Connectors tested: connect → inbox/calendar sync → disconnect → reconnect.

Operations
- [ ] `/api/health` returns `{"ok":true}`.
- [ ] After the first night: `/admin` shows a succeeded logical export for each tenant.
- [ ] 08:00 brief arrives on five consecutive working days by 08:05 (spec acceptance test).
- [ ] Restore drill done once into a scratch project ([admin-runbook.md §8](admin-runbook.md#8-restore-procedure)).
- [ ] Operator trained with [operator-guide.md](operator-guide.md); admin trained with [admin-runbook.md](admin-runbook.md).

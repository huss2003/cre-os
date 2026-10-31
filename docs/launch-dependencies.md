# CRE OS — launch dependency register

Spec: Part III "Launch dependency register", Part I §17 "Remaining implementation inputs", Part II §8.

Rule from the spec: *each dependency has an owner, due date, status, fallback and affected feature. Until resolved,
ship the permitted manual/export path and label unavailable features accurately. No hidden dependency may be counted
as a completed integration.*

The register has two parts: **platform** items (the agency, once) and **per-tenant** items (copy section B for every
new tenant). Status values: `not started` · `in progress` · `blocked` · `done` · `n/a`.

Last reviewed: 31 Oct 2026 (repo state: local only, mock AI, mock connectors).

---

## A. Platform (agency) dependencies

| # | Item | Owner | Due | Status | Fallback until done | Feature affected |
|---|---|---|---|---|---|---|
| P1 | **Supabase Pro** organisation + production project in Mumbai (`ap-south-1`) — free-plan project limit currently reached | Agency owner | before first tenant | not started | Run locally / demo only. Free plan is not acceptable for production data (pausing, no backups). | Everything in production; daily backups (RPO 24 h) |
| P2 | **Vercel Pro** team + project from `huss2003/cre-os`, region `bom1` | Agency owner | before first tenant | not started | None for production: Hobby is non-commercial and cron runs at most daily. External pinger calling `/api/cron/tick` with the bearer secret is a stop-gap only. | 08:00 brief, T-60 meeting briefs, inbox/calendar sync, nightly export |
| P3 | **OpenAI API** organisation + project key with hard monthly limit; confirm model availability (`gpt-6-luna`, `gpt-6.1-sol`, `gpt-4o-mini-transcribe`) on the key; decide standard vs regional endpoint | Agency owner | before AI go-live | not started | **Mock mode** (`OPENAI_API_KEY` empty): deterministic placeholder extraction/briefs; captures stored raw; finance/tasks/lease radar unaffected (no AI). UI shows AI unavailable. | Capture extraction, transcription, brief synthesis, research, drafts |
| P4 | **Microsoft Entra app registration** (multi-tenant or per tenant), delegated read-only scopes, redirect URI on the production domain, client-secret expiry date recorded | Agency developer | before Outlook go-live | not started | Mock connector; manual `.eml` import of selected emails; calendar entered manually. Brief labels inbox/calendar "not connected". | Inbox triage, hot-reply alerts, calendar & visits, Sent Items reconciliation |
| P5 | **Google OAuth client** (Gmail read-only + Calendar read-only) and **Gmail restricted-scope verification** — see caveat below | Agency developer | before Gmail go-live | not started | Selected-thread manual import (`.eml` / forward-to-file); Google Calendar entered manually. Google connector may run in *Testing* mode for ≤ 100 named test users with weekly re-consent. | Gmail inbox triage, Google Calendar |
| P6 | Custom domain + DNS | Agency owner | before first tenant | not started | `*.vercel.app` URL | OAuth redirect URIs, invite links (`APP_URL`) |
| P7 | `TOKEN_ENCRYPTION_KEY` generated and escrowed (password manager + offline) | Agency owner | at deploy | not started | — (required) | Connector tokens, encrypted backups |
| P8 | Two agency platform admins; two owners on Supabase org, Vercel team, GitHub repo | Agency owner | at deploy | not started | — (spec: no single/developer-only admin) | Admin recovery |
| P9 | Agency **data-processing agreement template** + sub-processor list (Supabase, Vercel, OpenAI, Microsoft/Google) reviewed by counsel; DPDP obligations mapped | Agency owner + counsel | before any corporate data | not started | Onboard personal/public data only | All corporate-data features |
| P10 | Off-site backup store (separate account) + S3 credentials for storage copy | Agency owner | first week of production | not started | Monthly manual download of exports + bucket | Backup layer 4, RTO 1 working day |
| P11 | Transactional SMTP for Supabase Auth (password reset) | Agency owner | before first tenant | not started | Admin sets temporary passwords; invite links copied manually | Self-service password reset |

### Gmail restricted-scope caveat (P5)

`https://www.googleapis.com/auth/gmail.readonly` is a Google **restricted** scope. For an app used by external
(non-Workspace-internal) users in *Production* publishing status, Google requires OAuth app verification **and** an
annual third-party security assessment (CASA) before unverified-app limits are lifted. Practical options:

1. **Testing mode:** up to 100 named test users; users see an "unverified app" warning and refresh tokens expire after
   ~7 days, so the user reconnects weekly. Acceptable for a pilot, not for a paying tenant long-term.
2. **Internal app:** if a tenant uses Google Workspace, register the OAuth client inside *their* Workspace as an
   *Internal* app — no verification/CASA for internal users. Requires their Workspace admin.
3. **Verify + CASA:** budget time (weeks) and the assessor's fee; re-assess annually.
4. **No Gmail OAuth:** keep manual selected-thread import (spec default for "occasional Gmail").

`calendar.readonly` is a *sensitive* (not restricted) scope: verification needed for production, but no CASA.
Microsoft Graph has no equivalent assessment, but the tenant's Entra admin may need to grant consent.
Details and click-paths: [setup-oauth.md](setup-oauth.md).

---

## B. Per-tenant dependencies (copy for each tenant)

Tenant: `__________` Workspace slug: `__________` Owner: `__________` Agency contact: `__________`

| # | Item | Owner | Due | Status | Fallback until done | Feature affected |
|---|---|---|---|---|---|---|
| T1 | **Data-processing agreement** signed (agency ↔ tenant), and tenant's written confirmation they're authorised by their employer to process corporate data in CRE OS; `data_lane` approval recorded (`approved_processors`, `approved_regions`, `approval_evidence`, `approved_at`) | Tenant owner + agency | **before importing any corporate data** | | Personal/public lane only (`public`, `permitted_personal` classifications) | Imports of employer data, inbox ingestion of work mail, CRM exports |
| T2 | **Tenant's Microsoft 365**: corporate SKU, Entra admin consent path, Conditional Access constraints; (optional) the one SharePoint/OneDrive folder to grant via selected-files access | Tenant IT | before Outlook go-live | | Manual `.eml` import; manual calendar | Inbox triage, calendar, T-60 briefs, Sent Items reconciliation |
| T3 | **Tenant's Google** (if used): Workspace admin for Internal app, or accept Testing-mode limits | Tenant IT | before Gmail go-live | | Manual selected-thread import | Gmail triage, Google Calendar |
| T4 | **CRM export rights**: exact official CRM name, whether API or export is permitted, field list, official-ID field, who is the record authority | Tenant owner | before pipeline import | | Manual entry of active deals; CRE OS marks itself non-authoritative and stores official CRM id when known | Pipeline import, official-CRM conflict check, fee reconciliation |
| T5 | **Licensed-source rights** (e.g. a property database): licence id, allowed purposes, users, redistribution, retention, AI-processing allowed?, colleague sharing allowed?, expiry → one `licensed_source` row each | Tenant owner | before importing licensed data | | Don't import; reference manually; or import as `licensed_restricted` visible only to the licensee with AI processing off | Market data, availability, transactions |
| T6 | **Office templates** (deck, proposal, market note, comparison workbook) approved by the tenant's employer/brand team → `template_asset` rows marked `approved` | Tenant owner | before client-facing documents | | Built-in neutral templates, clearly labelled not-employer-branded | Documents / Design studio |
| T7 | **Writing samples**: 10–20 examples of the adviser's own emails/posts (permitted to use) | Tenant owner | before outreach drafting go-live | | Neutral professional tone; heavier editing | Drafts, outreach sequences, content queue |
| T8 | **Consented audio samples**: representative call/voice notes in Hindi/English/Hinglish, with the consent/notice mechanism documented; device recording format confirmed | Tenant owner | before transcription benchmark | | Text/typed captures only; transcription unbenchmarked (labelled) | Voice capture accuracy target (≥95% task/entity on 20-note pilot) |
| T9 | **Partner terms**: actual quotes/terms from fit-out finance or referral partners → `partner.terms_json`; conflicts noted | Tenant owner | before partner-finance comparisons | | Partner option hidden or shown as "terms not provided" | Finance: fit-out financing comparison |
| T10 | **Fee rules**: official fee recognition/attribution rules, current pipeline and YTD credited revenue | Tenant owner | before revenue dashboards | | Fees tracked as "unconfirmed rules"; funnel maths uses stated targets only | Fees, revenue/controller, cohort reviews |
| T11 | **IP / ownership position** for templates, data and outputs (personal vs employer) | Tenant owner (+ their counsel) | before go-live | | Treat all employer-originated data as `corporate_confidential` | Data lanes, exports on exit |
| T12 | Retention settings reviewed and saved by tenant owner | Tenant owner | first week | | Spec defaults apply (proposed, not approved) | Retention |
| T13 | AI budget agreed and set (`monthly_ai_budget_inr`) | Agency + tenant | at onboarding | | ₹3,000 default | All AI workflows |
| T14 | Members list with roles, classifications, account assignments | Tenant owner | at onboarding | | Owner-only use | Colleague access |

---

## C. How to label unavailable features

When a dependency is open, the product must say so (rule S10, spec "do not claim a live integration exists"):

- Brief source-status line shows "Outlook not connected — manual import only" rather than an empty inbox section.
- Documents generated without approved templates carry "Neutral template — not employer-approved".
- Licensed data imported without AI permission is excluded from AI calls (classification + `permits_ai_processing`).
- Mock AI outputs are marked `mock:` in `model_usage` and shown as placeholders in the UI.

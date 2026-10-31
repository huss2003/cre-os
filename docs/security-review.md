# CRE OS — security review (2026-10-31)

Reviewer: security agent. This review covers the core (`supabase/migrations/2026103100{01,02,03}00_*.sql`, `src/lib/**`,
`src/proxy.ts`) and every module migration present at review time (`001000` imports, `001100` capture/changes,
`001200` brief, `001300` deals, `001400` integrations, `001500` intelligence, `001600` admin), plus module services under
`src/modules/**`.

**Pass 2 limitation:** at 14:55 IST there were still **no** `src/app/api/v1/**` routes, no module pages and no module
`actions.ts`. Only the core routes exist (`/api/cron/tick`, `/api/health`, `/auth/callback`, `/auth/signout`, login
and workspace-switch actions). So route-level checks (authentication, role, idempotency, secrets in responses) could
only be done for those routes. Re-run this review when the module routes land. The tests discover tables and
functions live, so new module tables are covered automatically.

Executable tests: `tests/security/*.test.ts` (run with `npx vitest run tests/security`). Every exploit scenario runs as the
real API role (`set local role authenticated` plus `request.jwt.claims`, which is what PostgREST does) inside a
transaction that is **always rolled back**. Storage and PostgREST tests delete only the rows and objects they created.

> **Threat-model note.** `@supabase/ssr` keeps the user's JWT in cookies that JavaScript can read, and the publishable key is public.
> Any signed-in user can therefore call PostgREST, Storage and every RPC granted to `authenticated` directly, outside the
> Next.js app. Any control that exists only in TypeScript (a role check, approval, risk classification or MFA step-up)
> can be bypassed. The database is the real security boundary.

---

## Critical

### C1. `reverse_change` trusts a forgeable `change_proposal` row and lets an editor take over the workspace as owner (and write to any workspace table)
`supabase/migrations/20261031001100_changes_apply_reverse.sql:571-690` (`:624` `cx_load_row(cp.target_type…)`,
`:635` keys from `cp.before->'fields'`, `:658` `cx_update_fields(cp.target_type…)`, `:602` merge path uses `r->>'table'`/`r->>'column'`);
the root cause is that `change_proposal` is an ordinary business table (`20261031000200_core_domain.sql:613`). Editors can INSERT and UPDATE it directly.

`apply_change` checks `cx_allowed_tables()` and `cx_patch_fields()`. `reverse_change` does neither. It loads
`cp.target_type`/`cp.target_id`, takes field names and values from `cp.before`, and writes them with the
SECURITY DEFINER `cx_update_fields`. All of those columns are under the caller's control.

**How it fails (proven, test `change-tamper.test.ts › CRITICAL: editor cannot escalate…`):** the colleague (an editor) inserts
`change_proposal{target_type:'membership', target_id:<own membership id>, state:'applied', applied_audit_id:1, risk:'routine_internal',
before:{kind:'update', fields:{role:'owner', see_all_accounts:true}, after:{role:'editor', see_all_accounts:false}}}`
through PostgREST. It then calls `app.reverse_change(id)`, and its membership becomes `owner` with `see_all_accounts=true`.
The same primitive can rewrite `record_share`, `connector_account`, `job`, `outbox` and so on, and any column (`classification`,
`owner_user_id`). The merge branch adds an arbitrary `update public.<table> set <col>=…`.
This breaks the spec acceptance test "Prompt injection … cannot change roles": a model-created proposal is just a row.

**Fix:**
- (a) Revoke INSERT and UPDATE on `change_proposal` (and on `approval` and `change_conflict`) from `authenticated`. Create, edit and decide proposals only
  through SECURITY DEFINER functions such as `app.propose_change(...)`, which set `state='proposed'`, `before=null` and `applied_audit_id=null`
  and validate `target_type ∈ cx_allowed_tables()` and the patch. Or add a BEFORE INSERT/UPDATE trigger that rejects any change to
  `state, before, applied_audit_id, risk, target_type, target_id, reversal_of, decided_*` unless
  `current_setting('app.change_proposal_id', true)` was set by the definer functions.
- (b) Defence in depth inside `reverse_change` and `preview_reverse`: require `cp.target_type = any(cx_allowed_tables())`, run every
  key of `cp.before->'fields'` through the `cx_patch_fields` column checks (deny `cx_denied_columns()`), whitelist the
  `repointed` table and column pairs against `cx_merge_refs(cp.target_type)`, and check `cx_can_read` on the target row.

### C2. `preview_reverse` reads any column of any workspace table, including `connector_account.token_ciphertext`
`20261031001100_changes_apply_reverse.sql:515-569` (`:530`, `:533`).
**How it fails (proven, `change-tamper.test.ts › CRITICAL: editor cannot read secrets…`):** the colleague cannot `select token_ciphertext`
(error 42501). But with a forged proposal `{target_type:'connector_account', before.fields:{token_ciphertext:null}}`,
`app.preview_reverse` returns `"current":"SEC-TOKEN-CIPHERTEXT"`. The same works for `oauth_state.code_verifier_ciphertext`,
other users' `membership` rows, `audit_event`-adjacent tables and restricted records (no `cx_can_read` on the target).
**Fix:** same as C1 (a) and (b). Also, `preview_reverse` should only return fields listed in `cx_patch_fields` for allowed tables.

---

## High

### H1. Storage read policy ignores classification and account assignment; backup exports are readable by every member
`20261031000200_core_domain.sql:774-777` ("ws files read" = `is_member(prefix)`); `src/modules/admin/backup.ts:14,57`
(exports go to `workspace-files/<ws>/backups/<stamp>/`).
**How it fails (proven, `storage.test.ts › viewer-level members cannot read files…`):** the owner stores a `licensed_restricted`
capture file. The colleague cannot see the `capture` row, but `storage.download(path)` returns the file. This breaks the
"Permissions" acceptance test ("direct object URL"). Any viewer can also download the nightly full-workspace export, which contains all
restricted rows, `connector_account` and `oauth_state` ciphertexts, `membership` and `audit_event`. When `TOKEN_ENCRYPTION_KEY` is unset
the export is plaintext. Even when encrypted, it is a full copy outside RLS. (Already listed in `docs/security-model.md` §11.1.)
**Fix:** deny `authenticated` on `<ws>/backups/**` and write backups to a separate service-only bucket. For other files,
resolve access through the owning row: store objects as `<ws>/<entity_type>/<entity_id>/…` and use a policy that calls
`app.can_read(ws, cls, owner, etype, eid)` looked up from the owning row. Alternatively, keep the bucket service-only and serve downloads through a route
that checks RLS on the row and returns a short-lived signed URL.

### H2. `record_share` is not bound to the record's workspace, so a share in workspace A unlocks a record in workspace B
`20261031000100_core_platform.sql:101` (`can_read` matches `record_share` by `entity_type, entity_id, user_id` only) and `:242`.
**How it fails (proven, `rpc.test.ts › record_share created in another workspace…`):** a user who is a restricted editor in
WS1 but admin in any other workspace (for example agency staff, or a workspace they created) inserts `record_share{workspace_id: <their ws>,
entity_id: <WS1 org id>, user_id: self}`. The hidden WS1 account becomes readable, and writable if they are an editor.
**Fix:** in `can_read` and `cx_can_read`, require `s.workspace_id = ws`. Also add a trigger on `record_share` that checks that the entity exists in
`workspace_id`.

### H3. `app.alias_matches` (SECURITY DEFINER) leaks names of accounts the caller cannot see
`20261031001600_admin.sql:90-108`. It filters only by membership and classification, not by owner or share.
**How it fails (proven, `rpc.test.ts › colleague cannot discover restricted accounts through alias_matches`):** the colleague gets
`entity_id` and `raw_alias` of an owner-only organisation, while table RLS and `search_entities` both return 0 rows.
This breaks the "Permissions → full-text index" acceptance test.
**Fix:** add `and app.can_read(a.workspace_id, a.classification, a.owner_user_id, 'entity_alias', a.id)`, or make the function
`security invoker` (entity_alias already has RLS).

---

## Medium

### M1. A tenant owner can lift a platform suspension and raise the AI budget
`20261031000100_core_platform.sql:225-226`: UPDATE on all `workspace` columns is granted to owners. Proven by `rpc.test.ts › a tenant owner cannot lift a platform suspension…`.
**Fix:** `revoke update on public.workspace from authenticated; grant update (name, timezone) on public.workspace to authenticated;`.
Change `status` and `monthly_ai_budget_inr` only through platform-admin functions, and `ai_paused` through `set_ai_paused`. The gateway
(`src/lib/ai/gateway.ts:134`) should also refuse when `status <> 'active'`.

### M2. Draft approval binding can be forged directly through the API
`20261031001400_integrations.sql:212-235`. The trigger checks only that `content_hash` *changed*, not that it is the hash of
the content. It also lets any editor set `state='approved'` with `approved_hash = content_hash`, with no `approval` row and no
suppression check. Proven by `drafts.test.ts › a forged content_hash…`: body changed, hash set to `'forged'`, self-approved, then `marked_sent`.
Nothing is sent (S3 holds), but the "approved / marked sent" audit trail and the suppression gate in
`approveDraft` can be bypassed.
**Fix:** compute `content_hash` in SQL (in the trigger, from recipient, subject, body and attachments) instead of trusting the client.
Make the approval and sent transitions go only through a SECURITY DEFINER `app.approve_draft`/`app.mark_draft_sent` that checks the role,
suppression and approval row, and revoke direct UPDATE of `state/approved_*` from `authenticated` (column grants).

### M3. Material changes (S4) are enforced only in TypeScript
`src/modules/admin/entities.ts:88-120` routes material fields to proposals, but RLS lets any editor `UPDATE`
`requirement.area_*`, `opportunity.expected_fee`, `lease.contractual_expiry` and so on directly. Editors can also change `change_proposal.risk`, which also
enables the reversal bypass in `change-tamper.test.ts › editor cannot reverse a high-value change…` (`:586` uses the stored `cp.risk`;
**failing**).
**Fix:** use column-level UPDATE grants or a BEFORE UPDATE trigger that rejects `cx_material_fields(tg_table_name)` changes unless
`app.change_proposal_id` is set (that is, the write came from `apply_change`/`reverse_change`). In `reverse_change`, recompute the risk with
`cx_risk_floor` from `cp.before` instead of trusting `cp.risk`.

### M4. Cross-tenant foreign keys
None of the FKs between business tables include `workspace_id`. A WS2 user can insert `space.asset_id = <WS1 asset>`,
`requirement.org_id = <WS1 org>`, and so on. This also works through `apply_change` `create`/`update`, because `cx_patch_fields` validates names, not referenced
workspaces. The effects are: an existence oracle for foreign IDs; `on delete cascade` from WS1 deletes WS2 rows; and service-role jobs that join by
id without a workspace filter could mix tenants.
**Fix:** composite FKs `(workspace_id, x_id) → (workspace_id, id)` (needs `unique (workspace_id, id)` on parents), or a
generic trigger that checks that referenced rows share `workspace_id`.

### M5. `/api/cron/tick` accepts `Bearer undefined` when `CRON_SECRET` is unset
`src/app/api/cron/tick/route.ts:9`, and it is not a constant-time comparison.
**Fix:** `if (!process.env.CRON_SECRET || !timingSafeEqual(...)) return 401`.

### M6. Open redirect after login
`src/app/auth/callback/route.ts:11` and `src/app/login/actions.ts:10`: `next.startsWith("/")` accepts `//evil.example`, which is
protocol-relative (`new URL("//evil.example", req.url)` → `http://evil.example/`).
**Fix:** require `/^\/(?!\/|\\)/` and resolve against the app origin, rejecting any URL whose origin differs.

### M7. Owner MFA is enforced only in Next.js
`src/modules/admin/guard.ts` enforces AAL2 for admin pages and APIs, but `membership_mod`/`record_share_mod`/`workspace_upd` RLS do not
check `auth.jwt()->>'aal'`. A stolen password (AAL1 session) can still change members through PostgREST.
**Fix:** add `and (auth.jwt()->>'aal') = 'aal2'` to the owner and admin mutation policies once MFA is enforced.

### M8. `route()` idempotency is presence-only
`src/lib/util/http.ts:18` requires the `Idempotency-Key` header but does not store or replay responses. Each handler must
dedupe on its own (for example `deal_idempotency`, unique `idempotency_key` columns). Check this per route when `/api/v1/**` lands.
**Suggested fix:** a shared `app.idempotency` table keyed `(workspace_id, user_id, key, route)` with the stored response.

---

## Low

- **L1. Default Supabase grants are not tightened.** `anon` has SELECT/INSERT/UPDATE/DELETE on every public table (RLS blocks it
  today because all policies are `TO authenticated`). It also has SELECT on `connector_account.token_ciphertext`. `anon` and `authenticated` hold
  TRUNCATE on all tables, including `audit_event`, so the table is not strictly append-only at the privilege level. TRUNCATE ignores RLS, though PostgREST cannot issue it.
  Fix: `revoke all on all tables in schema public from anon; revoke truncate on all tables in schema public from anon, authenticated;`
  plus `alter default privileges … revoke …` (`catalog.test.ts`: 3 failing checks).
- **L2. `app.make_business_table`/`make_workspace_table` are executable by `anon`/`authenticated`** (`20261031000100_core_platform.sql:175,208`).
  They are not SECURITY DEFINER, so ALTER fails for non-owners, but they should be revoked. The `app` schema is listed in
  `supabase/config.toml` `[api].schemas`, so every `app.*` function with EXECUTE for PUBLIC can be called over the API. (The running stack currently
  exposes only `public`, so `adminApp().rpc(...)` and `db.schema("app").rpc(...)` will fail until the stack is restarted with the config.)
- **L3. Draft and suppression evidence events can be forged.** Editors can INSERT `draft_event` with any `actor_user_id`/`event`. Set
  `actor_user_id := auth.uid()` in a trigger.
- **L4. The `<evidence>` delimiter is not escaped** (`src/lib/ai/gateway.ts:81`). Untrusted text containing `</evidence>` can close the
  block. Escape or strip the tags in evidence, or use a random per-call boundary. With `webSearch: true` plus evidence, injected
  text can make the model issue searches that exfiltrate prompt content. Avoid combining them.
- **L5. `integrations_touch_collisions`** (SECURITY DEFINER) shows any member the touch history (colleague name, channel, time) for orgs they
  cannot read. This is acceptable for collision warnings if intended, but the function should return only a boolean or count for orgs the caller cannot read.
- **L6. `outbox_own` policy:** a user removed from a workspace can still read outbox rows addressed to them. Add `app.is_member(workspace_id)`.
- **L7. Storage folder cast:** objects whose first path segment is not a UUID make the `::uuid` cast in the storage policies raise
  errors for every listing (a DoS on bucket listing). Guard the cast with a regex.

## Checked and OK

- RLS enabled on all 99 public tables. No `true`/null-qual policies and no policies for `anon`/`public`. Every SECURITY DEFINER
  function pins `search_path`.
- **Tenant isolation:** for all 97 `workspace_id` tables, a seeded WS1 row is invisible to the other tenant and to anon, and cannot be
  updated, deleted or inserted into, while the WS1 owner can see it (positive control). PostgREST checks agree.
- **Storage cross-tenant:** read, list, sign, overwrite, delete and planting into another tenant's prefix are all denied. The bucket is private.
- **Job queue and internal RPCs** (`claim_jobs`, `enqueue_job`, `complete_job`, `fail_job`, `export_table`, `workspace_tables`,
  `user_id_by_email`, `cx_*`) are denied to anon, other and owner. Member RPCs refuse other workspaces, and `p_actor` spoofing is refused.
- **`apply_change` approval binding:** a patch edited after approval → `approval_invalid`. A stale `expected_version` →
  `stale_version`. An approval forged by an editor on the owner's behalf → `approval_invalid`. A risk downgrade by an editor → `forbidden`.
  Permission and system tables cannot be targeted.
- **Drafts:** a content change without re-hashing is rejected, a re-hash drops the approval, `drafted→marked_sent` without approval is rejected, and
  sent drafts cannot be reopened. `audit_event`/`draft_event` cannot be updated or deleted by app users.
- **No outbound send:** there is no nodemailer, sendMail, Graph `Mail.Send`, `gmail.send`, WhatsApp, LinkedIn API or scraping code. The Mail.Send and gmail.send scopes appear only
  on a deny-list (`src/modules/integrations/config.ts:20`). There is no `eval`/`new Function`/`dangerouslySetInnerHTML` and no model-generated SQL.
  Email bodies are reduced to sanitised plain text (`src/modules/integrations/sanitize.ts`).
- **Service-role use** is limited to jobs (`admin/jobs.ts`, `lib/jobs/queue.ts`), the gateway's usage and budget bookkeeping, and
  platform/member admin with explicit `assertPlatformAdmin`/`assertCanManageMembers`. Queries filter `workspace_id`.
- **Connector tokens:** `authenticated` has column-level SELECT without `token_ciphertext`. `oauth_state` is service-only.

## Test results (`npx vitest run tests/security tests/rls.test.ts`, 2026-10-31 14:55 IST)

8 files, **47 tests: 35 passed, 12 failed**. Every failure is a confirmed finding:

| Failing test | Finding |
|---|---|
| change-tamper › CRITICAL: editor cannot escalate own membership… | C1 |
| change-tamper › CRITICAL: editor cannot read secrets… via preview_reverse | C2 |
| change-tamper › editor cannot reverse a high-value change by downgrading risk | M3 / C1 |
| storage › viewer-level members cannot read files of records they cannot see | H1 |
| rpc › record_share created in another workspace… | H2 |
| rpc › colleague cannot discover restricted accounts through alias_matches | H3 |
| rpc › tenant owner cannot lift suspension / raise budget | M1 |
| drafts › forged content_hash cannot be used to approve / mark-sent | M2 |
| catalog › anon has no table privileges | L1 |
| catalog › audit_event append-only (TRUNCATE) | L1 |
| catalog › connector token not selectable by anon (column grant) | L1 |
| catalog › DDL helper functions not executable by API roles | L2 |

The existing `tests/rls.test.ts` (3) passes.

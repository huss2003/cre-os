# Common instructions for every module agent (continuation run)
- A previous agent built part of this module and was stopped mid-work at 14:17 IST. FIRST inventory what exists in your owned paths (src/modules/<m>/**, your migration range, your routes under src/app/(app)/ and src/app/api/**) and run your existing tests, then finish the remaining scope. Reuse and fix existing code; don't start over.
- Read /home/claude/cre-os/AGENTS.md completely (rules S1–S10, ownership, shared-DB etiquette). Spec: docs/spec.txt. Security findings: docs/security-review.md (fix the ones assigned to your module).
- Do NOT run git commands. Don't edit shared files (report needs instead). Never run supabase db reset/stop. No next build/dev. Re-apply your migration with psql after changes (make it re-runnable).
- PRIORITY ORDER this run: (1) security fixes assigned to you, (2) pages + API routes (none exist yet for most modules — the product is unusable without them), (3) remaining services/tests, (4) README.
- Pages must work at 375px, use src/components/ui, have helpful empty states (DB starts empty).
- Core hardening is being applied concurrently by the coordinator (migration 20261031001900_core_hardening.sql): storage paths <ws>/backups/** admin-only and <ws>/private/** owner-only; record_share must match workspace; idempotency-key dedupe in route(); workspace.status/ai budget only platform-admin editable. Don't fight these.
- Done = tsc clean for your files, your vitest suite + relevant tests/security tests pass, README written. Final report under 300 words.

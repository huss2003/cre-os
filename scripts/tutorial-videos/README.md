# Tutorial videos

Short videos recorded from the real app (Playwright + an injected overlay: cursor, click ripple, highlight ring,
caption bar, title and outro cards). They are shown on `/tutorials` and `/tutorials/videos/<slug>`.

| File | What it is |
|---|---|
| `flows.js` | The videos: one flow per task, captions, "try it" route. Edit here when the UI changes. |
| `harness.js` | Recording helpers: `title(text, sub)`, `step(caption, fn)`, `moveAndClick(locator)`, `type(locator, text)`, `point`, `scroll`, `outro(did, next)`. |
| `overlay.js` | Injected into every page (`addInitScript`); state survives navigations via `sessionStorage`. |
| `record.js` | Runs the flows, converts to MP4 + poster, writes `timings.json` and the manifest `src/app/(app)/tutorials/videos.ts`. |
| `setup-demo.ts` | Idempotent demo data in the synthetic demo workspace (Zentrix Analytics, Ananya Rao, Kharadi/Hinjewadi buildings, a lease expiring in ~10 months, a 25,000 sf Kharadi requirement, a Pune-expansion signal). |
| `workflow-demo.ts` | Resets and runs the Zentrix "lease → renewal / relocation" automation (used by the `automation` video). |

### Module groups added 2026-11-12 (prepared, not yet recorded)

| Group (`--group`) | Flows file | Demo data (run by the group's `prepare`) | Slugs |
|---|---|---|---|
| `leases` | `flows-leases.js` | `setup-leases.ts` (TUT-LEASE-A/B/C rebuilt each run) | leases-dashboard, lease-add, lease-critical-dates, lease-escalation, lease-renewals, lease-termination, lease-obligations, lease-calendar, lease-portfolio |
| `transactions` | `flows-transactions.js` | `setup-transactions.ts` ("… (tutorial)" transactions archived + rebuilt) | tx-create, tx-offers, tx-positions, tx-issues, tx-inspections-docs, tx-stakeholders, tx-loi-points, tx-agreement-approvals, tx-execution-handover, tx-closure, tx-command-view |
| `supply` | `flows-supply.js` | `setup-supply.ts` | supply-inventory, supply-operators, supply-matching, supply-reconfirmation, supply-feedback |
| `signals2` | `flows-signals2.js` | `setup-signals2.ts` (needs `setup-leases.ts` companies) | signals-dashboard-v2, signal-card-v2, signal-counter-evidence, signal-unresolved-company, signal-actions, signals-sources |
| `ai-settings` | `flows-ai-settings.js` | `setup-ai-settings.ts` (resets AI modes; card PNG in /tmp/tutorial-ai) | ai-use-settings, local-ocr-business-card |

Shared helpers for these groups: `new-modules-common.js` (`SOFT_LOG=1` prints optional pointers that were not found during a dry run).
Existing videos broken by recent UI changes, with step fixes: `RERECORD.md`.

## Re-record everything (one command)

With the local Supabase stack and the app running on port 3100 (`npx next build && PORT=3100 npx next start -p 3100`):

```bash
npx tsx --env-file=.env.local scripts/tutorial-videos/setup-demo.ts && node scripts/tutorial-videos/record.js
```

- Only some videos: `node scripts/tutorial-videos/record.js capture outreach`
- Check selectors without recording: `node scripts/tutorial-videos/record.js --dry`
- A failed flow leaves a screenshot at `/tmp/tutorial-videos/<slug>-FAILED.png`; the other videos still record.

Output: `public/tutorials/videos/<slug>.mp4` (H.264, CRF 26, 1280×800, no audio, faststart) and `<slug>.jpg` (poster).
The manifest keeps each step's start time, so the step list under the player seeks to it.

### Requirements

- `playwright-core` (default `/tmp/pw/node_modules/playwright-core`, override with `PLAYWRIGHT_CORE`), Chrome at
  `/usr/bin/google-chrome` (`CHROME`), ffmpeg at `/usr/local/bin/ffmpeg` (`FFMPEG`). App URL: `BASE_URL` (default `http://127.0.0.1:3100`).
- Playwright records video with its own ffmpeg build. If it says `Executable doesn't exist at …/ffmpeg-linux`, link the
  system one: `mkdir -p /opt/pw-browsers/ffmpeg-1013 && ln -sf /usr/local/bin/ffmpeg /opt/pw-browsers/ffmpeg-1013/ffmpeg-linux`
  (use the folder name from the error).
- Signs in as `owner@cre-os.local` / `password123` (`TUT_EMAIL`, `TUT_PASSWORD`) and records in that user's default
  workspace, which is the synthetic "Demo — Pune CRE (synthetic)" workspace once `setup-demo.ts` has run.
  Recording creates a few demo records each run (a capture, an outreach draft, a meeting, a comparison) — demo workspace only.

### Writing captions

One short plain-English sentence per step, describing only what is on screen (AI runs in mock mode locally).
Keep each video 20–60 s: about 6–11 steps.

## Publishing (Supabase Storage)
Videos are served from the public Supabase Storage bucket `tutorials` (`videos/<slug>.mp4|.jpg`, see `VIDEO_BASE` in
`src/app/(app)/tutorials/videos.ts`). `public/tutorials/videos/` is git-ignored. To publish new or re-recorded videos:
1. Temporarily force-add the new files (`git add -f public/tutorials/videos/<slug>.*`) and deploy.
2. The `tutorials.sync` job (hourly) copies files that are **missing** from the bucket. For a re-recorded slug, delete the old
   object in Supabase Storage first (the job never overwrites).
3. Once the bucket has them, remove the files from git again.

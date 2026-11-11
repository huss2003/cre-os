# Brief for tutorial-video recording agents (several run in parallel)

Goal: short videos (20–55 s, one task each) recorded from the REAL app so a new user can pick the flow they want and learn it.
Read first: `README.md`, `harness.js`, `overlay.js`, `flows.js` (examples of 9 finished flows), `setup-demo.ts`, `record.js`.

## Shared environment — do NOT rebuild or restart it
- App is already running at http://localhost:3100 (production build). **Never run `next build`, `next dev`, `next start`, `fuser -k 3100`, or `pkill next-server`.** If localhost:3100 is down, wait 60 s and retry; if still down, say so in your report.
- Local Supabase at 127.0.0.1:54321 (if `curl -s http://127.0.0.1:54321/auth/v1/health` ≠ 200: `(sudo nohup dockerd >/tmp/dockerd.log 2>&1 &); sleep 8; cd /home/claude/cre-os && npx supabase start`).
- Login owner@cre-os.local / password123. Recording happens in the synthetic workspace "Demo — Pune CRE (synthetic)" (see setup-demo.ts). Run `npx tsx --env-file=.env.local scripts/tutorial-videos/setup-demo.ts` once if demo data is missing.
- AI is in practice (mock) mode locally — captions must describe only what the screen shows.

## Your files only (several agents work at once)
- Flows: `scripts/tutorial-videos/flows-<group>.js` exporting `{ FLOWS, prepare?, finish? }` (same flow shape as flows.js; each flow needs `slug, title, category, learn, tryRoute, run`). Reuse harness helpers; import shared helpers from flows.js/harness.js but don't edit them (if you truly need a helper, copy it into your file).
- Optional demo-data additions: `scripts/tutorial-videos/setup-<group>.ts` (idempotent, demo workspace only, never touch other workspaces).
- Record ONLY your group: `node scripts/tutorial-videos/record.js --group <group>` (add `--dry` first to check selectors; add slugs to record a subset). Outputs: `public/tutorials/videos/<slug>.mp4|.jpg` and `scripts/tutorial-videos/timings/<slug>.json`; the manifest `src/app/(app)/tutorials/videos.ts` is regenerated from all groups (fine if another agent rewrites it — it always includes everything recorded).
- Slugs must be unique and prefixed with nothing special, but must not collide with: tour, capture, find-accounts, company, outreach, meeting, compare, ask-ai, automation, or other groups' slugs listed in your task.
- **Do not edit app code** (src/**). If a flow is broken in the app, record what works, and list the bug in your report.

## Video rules
- One clear task per video. Title card says the task; captions are plain English, one sentence, explain WHY as well as WHAT (the owner doesn't yet understand the app's flow). End card: "You did: … · Next: …".
- Show real navigation from the sidebar (Today, Ask AI, Capture, Review / Records / Work / More) so viewers learn where things live.
- 1280×800, readable pace (~1.2 s pause after each step), keep each MP4 under ~1.5 MB.
- Never show or type real secrets/keys; nothing must actually be sent externally.
- `category` must be exactly one of: "Start here", "Records & data", "Signals, scores & contacts", "Outreach & meetings", "Deal toolkit", "Ask AI & automation", "Review & settings".

## Report
List: slug, title, category, seconds, MB; any flows that failed or app bugs found; files created.

## UPDATE from the owner (overrides the length rule above)
Videos may be longer than a minute — **completeness beats brevity**. Show and explain EVERY feature on the screen(s) of your
task: each section, button, tab, filter, status chip and what it means, plus the full end-to-end flow (including what happens
next / where the result appears). Do not trim or skip content. Split into "Part 1 / Part 2" only if a single video would exceed
~3 minutes. Size limit relaxed to ~5 MB per video (crf 28 is fine if needed).

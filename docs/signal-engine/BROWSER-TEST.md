# Signal Engine — browser test (SPEC §19–§20)

Date: 2026-11-12 (IST). App: http://localhost:3100, Demo workspace, owner@cre-os.local, mock-AI mode.
Tool: playwright-core + Chrome headless, 1440px and 375px. Screenshots: `/tmp/sig-test/`. Scripts: `/tmp/sigscripts/`.
No app code was edited.

Legend: PASS / PARTIAL / FAIL / BLOCKED.

## 1. Paste → signal → review → approve → task → outcome → history
| Check | Result | Notes / screenshot |
|---|---|---|
| Paste box at top of /signals | PASS | `01-signals-1440.png` |
| Paste "Cobaltfern Systems announces expansion of its Pune operations, adding 300 roles in Kharadi…" | PASS | "1 signal(s) found, 1 new"; exact-name resolution. `02-after-paste.png` |
| Detail: 12 numbered sections, FOR/AGAINST, Fact/Inference/Hypothesis/Unknown labels | PASS | `03-detail-1440.png` |
| Lease events typed (expiry / notice / lock-in / escalation + basis) | PASS (cosmetic) | Basis shown as raw enum `calculated_from_source_tenure`; past events (lock-in 2024) listed as "relevant" |
| Contacts, missing info, next action | PASS | Nikhil Naik etc.; area/budget/date flagged unknown (not invented) |
| Event date ("from Q1 2027" in text) | FAIL | Event date stays "Not dated"; horizon shows "No dated events yet" |
| Micro-market | FAIL | Text says Kharadi; signal stored `micro_market = Magarpatta–Hadapsar` (taken from company record). §1 summary says "Existing Magarpatta and Magarpatta–Hadapsar occupancy" while §6 lists Amberline (Kharadi) + Riverstone — inconsistent |
| Approve + task | PASS | "Approved — follow-up task created." `04-approved.png` |
| Task appears in /tasks | PASS (cosmetic) | Title is the full recommended-action paragraph incl. "On record: …" (create_task form strips it, approve does not). `05-tasks.png`, `06-task-in-list.png` |
| Complete task with outcome in /tasks | PASS | task status done with evidence |
| Signal history shows the completion/outcome | FAIL | History only shows "approve (new → converted)"; the task completion from /tasks is not reflected and "Record outcome" is still offered. History timestamps are UTC ("2026-11-11 19:12") while header shows IST "12 Nov". `07-signal-history.png` |
| Company history link | PARTIAL | Company page has Signals (1) tab and evidence trail entry; trail shows raw `Tier single_unverified`, `expansion — expansion_terms`. Task outcome not visible on company overview. `08-company-history.png` |

## 2. Grouping and counter-evidence
| Check | Result | Notes |
|---|---|---|
| Same text from second URL groups into one signal | PASS | "1 found, 0 new"; FOR (2), sources 2, independent 1 (syndication note). `09`, `10` |
| Independent count | PASS (debatable) | Both items labelled "Pasted text" (URL domain not used as source name). The syndication rule note is counted as a *contradicting* item ("1 · 2 contradicting") — misleading |
| Paste remote-hiring counter-evidence via paste box | FAIL | "Cobaltfern Systems says its 300 new Pune hires will work remotely…" → "No CRE signal found in that text. Nothing was created." Not attached as counter-evidence to the open signal. `11b-paste-counter.png` |
| Add counter-evidence on detail page | PARTIAL | Shown under AGAINST, "re-assessed" message; confidence already "low" so no visible drop; priority stays 47/100 and band "This month" unchanged. `13-counter-added.png` |

## 3. Unknown company
| Check | Result | Notes |
|---|---|---|
| Paste with Company field blank ("Quillwave Robotics announces…") | FAIL | Company name not extracted from text: "Unresolved company", raw_name null, "“Unknown name” was not matched automatically (none)". `16-unresolved-detail.png` |
| Paste with Company = Quillwave Robotics | PASS | Unresolved, "No likely matches", "Add Quillwave Robotics as a new company" works. `21`, `22` |
| Near name "Cobaltfern Technologies" → candidates with reasons, pick | PASS (ranking) | Candidates: Marigold Loop Technologies (shared generic word "technologies") ranked *above* Cobaltfern Systems. "This is it" links correctly; title still "Cobaltfern Technologies: …". Raw "(none)" method shown. `19`, `20` |

## 4. Actions
| Action | Result | Notes |
|---|---|---|
| Reject with reason | PASS | status rejected, reason stored. `23` |
| Dismiss with reason | PASS | `24` |
| Snooze past date | PASS | "Snooze until a date after today." `25` |
| Snooze future + reason | PASS | until 20 Dec 2026. `31` |
| Assign to me | PASS | `26` |
| Link to opportunity (picker) | PASS (cosmetic) | Picker context shows raw stage `options_visits`. `33`, `34` |
| Propose opportunity → Review | PASS | Appears in /approvals as "New deal … From signal". `55-approvals.png` |
| Already known | PASS | `36` |
| Add evidence with `javascript:` URL (pattern removed client-side) | PASS | "Only http:// or https:// links can be added as evidence." `14` |
| Correct company | PASS (minor) | History says "correct company" without from/to. `35` |
| Priority override + reason + review date | PASS | Missing reason rejected. `28` |
| Re-evaluate | PASS | `29` |
| Create task | PASS | `30` |

## 5. Views, filters, search
| Check | Result | Notes |
|---|---|---|
| All 10 views render at 1440 and 375, no overflow, no load failure | PASS | `37-*`, `39-*`, `45-lease-view-375.png` |
| Dismissed & snoozed view shows reasons / snooze date | PASS | `37-dismissed-view-1440.png` |
| Search (Kharadi, Cobaltfern, remote, nonsense) | PASS | Search only covers open signals (snoozed Quillwave not found from All) |
| Filters: category, confidence, urgency, status, assigned, sort | PASS | |
| Filter micro-market=Kharadi | FAIL | 0 results although pasted signals are about Kharadi (see micro-market bug) |
| Filter freshness "last 7 days" | FAIL | Pasted signals have `latest_evidence_on = NULL` (no published date) → excluded from freshness filter |
| Filter "Detected from 2026-11-12" | FAIL | Returns 0 although cards show "Detected 12 Nov 2026" — filter uses UTC date, UI shows IST |

## 6. /signals/sources
| Check | Result | Notes |
|---|---|---|
| Registry, RSS labelled "Unavailable — needs access" | PASS | `40-sources-1440.png`, `40-sources-375.png` |
| Pause / Resume | PASS | `41-paused.png` |
| Reconnect RSS stays unavailable with explanation | PASS | `42` |
| Refresh now | PASS | "Refresh done — lease: 36, claims: 15, commercial: 0", run listed. Note: this created 51 real signals in Demo (left in place). `43` |
| Universe setting (1500, invalid -5, back to 1200) | PASS | Validation "between 50 and 8,000". `44` |

## 7. /settings/ai
| Check | Result | Notes |
|---|---|---|
| Three groups (Runs on code / Code first, AI as backup / Needs AI) | PASS | `48-settings-ai.png`; 375 no overflow `51` |
| Change feature and Save | BLOCKED/FAIL | Save returns raw error `mfa_enrolment_required: owners must enrol TOTP at /settings/security`; value not persisted. Not enrolled MFA (shared owner account) |
| Reset to defaults | BLOCKED | No message; nothing to reset (same MFA gate presumably) |

## 8. Quick checks
| Check | Result | Notes |
|---|---|---|
| /today planner 1440/375 | PASS | no overflow. `52`, `53` |
| Capture → Photo, PNG card (sharp from SVG) | PARTIAL/FAIL | Local OCR (tesseract-local) read text perfectly, no AI call. But "Extracted information (0) — Nothing structured was found": name Ravi Kulkarni, email, phone, title/company not turned into contact fields; only geographies matched. `54-capture-card.png`, input `card-input.png` |

## Cross-cutting
- Console: only error is a 404 from `t2/t3.gstatic.com/faviconV2?...url=http://example.com` on /signals — the list loads source favicons from Google, which also leaks evidence domains to a third party.
- 375px: no horizontal overflow on any page tested.
- Raw values in UI: `calculated_from_source_tenure`, `manual_paste · review_required` / `duplicate` (Source items), `(none)` resolution method, `options_visits`, `Tier single_unverified`, `expansion_terms`; sub-type "pune expansion" lowercase on list card.
- Copy: priority reasons render as ". Why act now: Expansion relevance (+14).; Evidence low (+4).; …" (leading ". " and ".;"); "1 months ago".

## Cleanup
Archived (SQL `archived_at`): test signals 6411e763, 7f5d51f7, 86f0a536, 926eca64, 2eed6a6b; tasks a21eb842, ec8f6577; org Quillwave Robotics; capture 0464a7bb; opportunity proposal b8ecb1c0 set rejected. Left: 51 signals from "Refresh now", evidence rows on archived signals, source-run log.

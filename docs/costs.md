# CRE OS — cost model and pricing worksheet (agency view)

Audience: the agency owner deciding what CRE OS costs to run and what to charge tenants.

> **Everything here is a planning estimate.** Vendor rates are those recorded in the spec (verified 23 Oct 2026) or
> the vendors' public pricing pages as understood at writing; re-check before quoting a client. ₹90/USD is the spec's
> **planning** exchange rate, not a live rate. The 18% reserve is a cash-planning allowance for GST/reverse-charge on
> foreign SaaS invoices, not tax advice — confirm treatment and input-credit eligibility with your CA. Card
> conversion fees are excluded.

The code's own copy of the AI rates is `src/lib/ai/pricing.ts` (`PRICING_VERSION = "2026-10-23"`); every AI call
logs its estimated USD cost and the pricing version to `model_usage`, and the `/admin` Health page totals it.

---

## 1. Rate card used

| Item | Rate | INR at ₹90 | Notes |
|---|---|---|---|
| Supabase **Pro** | $25 / month per **organisation** | ₹2,250 | Includes $10/month compute credit = one **Micro** instance. Daily backups (7-day retention). Extra projects (e.g. a staging project) pay their own compute (~$10/month Micro). Bigger compute (Small ≈ $15/month, i.e. +$5 net) only when needed. Usage beyond included quota (DB disk, file storage, egress) is metered. |
| Supabase **Free** | $0 | ₹0 | Limited active projects (current blocker), pauses after ~1 week inactivity, no production backups. Prototype only. |
| Vercel **Pro** | $20 / month per **deploying team member** | ₹1,800 | Needed for 5-minute cron and for commercial use. Includes a monthly usage allowance; CRE OS's traffic (8,640 cron calls/month + a few users) should stay inside it. Viewers/tenant users are app users, not Vercel seats. |
| OpenAI `gpt-6-luna` (routine extraction) | $0.10 in / $0.50 out per M tokens | ₹9 / ₹45 per M | Short-context Standard. |
| OpenAI `gpt-6.1-sol` (hard synthesis) | $2 in / $10 out per M tokens | ₹180 / ₹900 per M | |
| OpenAI web search | $10 per 1,000 calls (+ content tokens) | ₹0.90 per call | |
| OpenAI `gpt-4o-mini-transcribe` | ~$0.003 / minute | ₹0.27 / min | Estimate. |
| Off-site backup storage | allowance | ₹300 | Spec allowance. |
| Domain | allowance | ₹100 | Spec allowance. |
| GitHub (private repo) | $0 on Free | ₹0 | Paid only if you add seats/features. |
| Microsoft Entra app / Google OAuth client | $0 | ₹0 | Gmail restricted-scope security assessment (CASA), if required, is a separate third-party fee — get a quote ([launch-dependencies.md](launch-dependencies.md)). |

Regional (in-country) OpenAI processing, if a tenant requires it, carries a stated ~10% uplift on qualifying models —
reprice for the actual endpoint.

## 2. Fixed platform cost (shared by all tenants)

One production Supabase project (all tenants live in it, separated by RLS) + one Vercel Pro seat.

| Monthly item | INR |
|---|---:|
| Supabase Pro (one project, Micro) | 2,250 |
| Vercel Pro, 1 deploying member | 1,800 |
| Off-site backup storage allowance | 300 |
| Domain allowance | 100 |
| **Fixed base** | **4,450** |
| 18% reserve | 801 |
| **Fixed base incl. reserve** | **5,251** |

Add ₹1,800/month for each extra agency developer who deploys, and ~₹900/month if you keep an always-on staging
Supabase project. Agency labour (support, maintenance, patching, restore drills) is **not** in this table — see §5.

## 3. Variable AI cost per tenant

Three usage profiles taken from the spec's own workload examples:

| Profile | Monthly usage | USD | INR | INR + 18% |
|---|---|---:|---:|---:|
| **Light** — one adviser (spec "hybrid" example) | Luna 10 M in / 2 M out; Sol 2 M / 0.4 M; 300 searches; 600 audio min | 14.80 | 1,332 | 1,572 |
| **Heavy** — one adviser, 3× light | 3× all of the above | 44.40 | 3,996 | 4,715 |
| **Team** — three users (spec "professional" envelope) | Luna 30 M / 6 M; Sol 10 M / 2 M; 1,500 searches; 2,000 audio min; $8 buffer | 75.00 | 6,750 | 7,965 |

How the light number is built: Luna $1 + $1 = $2; Sol $4 + $4 = $8; search $3; audio $1.80 → $14.80.

**Hard cap per tenant.** The gateway refuses AI calls once the month's logged spend reaches the tenant's
`monthly_ai_budget_inr` (default **₹3,000 ≈ $33.33**), so with the default a tenant cannot exceed ~₹3,000 (+ at most
one in-flight call). Set the budget from the profile you sold: Light ₹2,000, Heavy ₹5,000, Team ₹8,000 are sensible
starting caps. When the cap is hit, research pauses and the brief falls back to the deterministic list — nothing breaks.

Illustrative unit costs (assumptions for intuition, not measured):

| Action | Assumed size | Cost |
|---|---|---|
| Capture extraction (Luna) | 4k in / 1k out tokens | ~$0.0009 ≈ ₹0.08 |
| 5-minute voice note transcription | 5 min | $0.015 ≈ ₹1.35 |
| Daily brief synthesis (Sol) | 20k in / 2k out | $0.06 ≈ ₹5.40 → ~₹160/month |
| Research dossier | 10 searches + Sol 50k in / 4k out | ~$0.24 ≈ ₹22 |

Measure real usage per workflow on `/admin` after the first month and re-fit the profiles.

## 4. Marginal cost per tenant

Adding a tenant adds: its AI usage, a few MB of database rows, its uploaded files, and its share of the nightly export
storage. Until the project outgrows Supabase Pro's included quota and Micro compute, **the marginal infrastructure cost
of a tenant is essentially its AI spend.**

| Tenants (N) | Fixed share per tenant (incl. reserve) | + Light AI | = Infra cost per tenant |
|---:|---:|---:|---:|
| 1 | 5,251 | 1,572 | 6,823 |
| 3 | 1,750 | 1,572 | 3,322 |
| 5 | 1,050 | 1,572 | 2,622 |
| 10 | 525 | 1,572 | 2,097 |

Watch-points that raise the fixed base: database > included disk; many large audio/document uploads (file storage +
off-site copy); slow pages under load → move from Micro to Small/Medium compute; needing PITR (paid add-on); needing
a separate staging project.

## 5. Suggested pricing worksheet (assumptions — edit before use)

Fill in per tenant:

| Line | Formula | Example A (N=3, Light) | Example B (N=5, Heavy) |
|---|---|---:|---:|
| a. Fixed share incl. reserve | 5,251 ÷ N | 1,750 | 1,050 |
| b. AI cost incl. reserve | profile from §3 | 1,572 | 4,715 |
| c. Support time | hours/month × your hourly cost (*assumed* 2 h × ₹1,500) | 3,000 | 3,000 |
| d. **Monthly cost to serve** | a + b + c | **6,322** | **8,765** |
| e. Target gross margin | your choice (*assumed* 50%) | 50% | 50% |
| f. **Monthly price before GST** | d ÷ (1 − e) | **≈ 12,600** | **≈ 17,500** |
| g. At 60% margin | d ÷ 0.4 | ≈ 15,800 | ≈ 21,900 |

Rounded suggestion (assumption, for discussion): **₹12,500–₹16,000/month** for a single-adviser tenant on the Light
profile, **₹17,500–₹22,000** for Heavy, plus a **one-time onboarding fee** (file import mapping and reconciliation,
templates, data lanes, connector setup, training) — the spec's build estimates (₹75k–₹150k for a one-person MVP) were
for a bespoke build; as a SaaS onboarding, ₹25k–₹75k depending on the number and messiness of source files is a
reasonable *assumption*. Charge GST on your invoices as your CA advises.

Notes for the proposal:

- Make the AI budget cap part of the plan ("includes up to ₹X of AI processing per month; research pauses at the cap").
- Exclusions (from spec §15): the tenant's own Microsoft/Google licences, CRM seats, licensed property databases,
  paid LinkedIn tiers, WhatsApp Business Platform, telephony/recording hardware, legal reviews.
- v1 has **no billing module** — invoice manually; use `/platform` usage numbers for the AI line.
- Re-run this worksheet whenever a vendor changes prices, the FX planning rate is revised, or measured usage differs
  from the profile by more than ~25%.

## 6. Budget controls checklist

- [ ] Per-tenant `monthly_ai_budget_inr` set from the sold profile.
- [ ] OpenAI project hard limit set ≈ sum of tenant caps + 20%.
- [ ] Supabase **Spend cap** left ON in Organization → Billing (blocks surprise overages; turn off only deliberately).
- [ ] Vercel spend management: set a monthly limit/alert in Team → Settings → Billing.
- [ ] Monthly: compare `/admin` spend per tenant and vendor invoices; spec alert levels 50/80/100% of each tenant cap.

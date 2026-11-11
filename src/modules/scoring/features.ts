/**
 * Feature extraction: reads Module 1 records and Module 2 signals for one entity and turns them into factor values
 * in [0,1] (or null = unknown) with a plain-language explanation and evidence links. No AI, no invented values.
 * All reads go through the caller's client (RLS for users; jobs use the admin client filtered by workspace_id).
 */
import type { Db } from "@/lib/supabase/server";
import type { Features, FeatureValue, Evidence, ModelKey } from "./engine";
import { clamp01 } from "./engine";

type Row = Record<string, any>;
const DAY = 86_400_000;
const days = (iso: string | null | undefined) => (iso ? Math.round((Date.parse(iso) - Date.now()) / DAY) : null);
const ago = (iso: string | null | undefined) => (iso ? Math.round((Date.now() - Date.parse(iso)) / DAY) : null);
const fv = (value: number | null, explanation: string, evidence: Evidence[] = []): FeatureValue => ({ value: value === null ? null : clamp01(value), explanation, evidence });
async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> { const { data } = await q; return (data ?? []) as Row[]; }

// ---------------------------------------------------------------- contact role classification (rules, not seniority alone)

export type RoleClass = "decision_maker" | "influencer" | "evaluator" | "gatekeeper" | "operational" | "unknown";
const ROLE_RULES: [RegExp, RoleClass, number, string][] = [
  [/(head|director|vp|vice president|chief|lead).{0,30}(real estate|corporate real estate|cre|workplace|facilit)/i, "decision_maker", 1, "Leads real estate / workplace / facilities"],
  [/(real estate|workplace|facilit)/i, "evaluator", 0.75, "Works in real estate / workplace / facilities"],
  [/(authori[sz]ed signatory|managing director|country head|site head|centre head|center head|gcc head|head of gcc)/i, "decision_maker", 0.9, "Site or country leadership — likely signs off"],
  [/(cfo|chief financial|finance (head|director|controller)|head.{0,10}finance)/i, "influencer", 0.75, "Finance approves cost"],
  [/(procure|purchas|sourcing)/i, "evaluator", 0.65, "Procurement runs the process"],
  [/(admin(istration)? (head|manager|director)|head.{0,10}admin)/i, "evaluator", 0.7, "Administration often runs office moves"],
  [/(chro|hr head|head.{0,10}(hr|people|human))/i, "influencer", 0.55, "HR shapes headcount and workplace policy"],
  [/(assistant|executive assistant|secretary|receptionist|office manager)/i, "gatekeeper", 0.3, "Controls access to decision-makers"],
  [/(ceo|coo|founder|president|chairman)/i, "influencer", 0.6, "Senior, but property decisions may sit elsewhere"],
  [/(admin|facility|operations|it )/i, "operational", 0.35, "Operational stakeholder"],
];
export function classifyRole(title: string | null | undefined): { cls: RoleClass; value: number | null; why: string } {
  const t = (title ?? "").trim();
  if (!t) return { cls: "unknown", value: null, why: "No designation recorded" };
  for (const [re, cls, v, why] of ROLE_RULES) if (re.test(t)) return { cls, value: v, why: `${t}: ${why}` };
  return { cls: "unknown", value: 0.15, why: `${t}: no known link to property decisions` };
}

// ---------------------------------------------------------------- shared loaders

async function orgBundle(db: Db, ws: string, orgId: string) {
  const [org, leases, reqs, sigs, emps, opps, links] = await Promise.all([
    db.from("organisation").select("id, display_name, sector, headcount_min, is_gcc").eq("workspace_id", ws).eq("id", orgId).maybeSingle().then((r) => r.data as Row | null),
    rows(db.from("lease").select("id, area_sf, contractual_expiry, asset:asset_id(name, locality:locality_id(name))").eq("workspace_id", ws).eq("tenant_org_id", orgId).is("archived_at", null).limit(50)),
    rows(db.from("requirement").select("*").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).neq("status", "closed").limit(20)),
    rows(db.from("signal").select("id, category, kind, title, confidence, verification, latest_evidence_on, detected_at, location_text, event_date, status, evidence:signal_evidence(source_url, source_name, published_on, role)")
      .eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).not("status", "in", "(dismissed,rejected)").limit(50)),
    rows(db.from("employment").select("person_id, title, fact_status, updated_at, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", orgId).eq("is_current", true).is("archived_at", null).limit(50)),
    rows(db.from("opportunity").select("id, name, outcome, mandate_status, expected_fee").eq("workspace_id", ws).eq("org_id", orgId).is("archived_at", null).limit(20)),
    rows(db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, is_meaningful)").eq("workspace_id", ws).eq("entity_type", "organisation").eq("entity_id", orgId).limit(500)),
  ]);
  const leaseIds = leases.map((l) => l.id);
  const events = leaseIds.length ? await rows(db.from("lease_event").select("id, event_type, event_date, date_basis, confirmed").eq("workspace_id", ws).in("lease_id", leaseIds).is("archived_at", null)) : [];
  return { org, leases, reqs, sigs, emps, opps, events, interactions: links.map((l) => l.interaction).filter(Boolean) as Row[] };
}

const sigEv = (s: Row): Evidence => {
  const e = (s.evidence ?? []).find((x: Row) => x.role !== "counter" && x.source_url) ?? (s.evidence ?? [])[0];
  return { type: "signal", id: s.id, label: s.title, url: e?.source_url ?? null, date: e?.published_on ?? s.latest_evidence_on ?? null,
    tier: s.confidence === "high" ? "documentary_current" : s.confidence === "medium" ? "credible_reported" : "single_unverified" };
};
const GROWTH = new Set(["expansion", "gcc_plan", "hiring", "funding", "new_office", "investment"]);
const NEED = new Set(["expansion", "gcc_plan", "relocation", "consolidation", "new_office"]);

function industryWeight(sector: string | null, weights: Record<string, number>): number | null {
  if (!sector) return null;
  const s = sector.toLowerCase();
  const hit = Object.entries(weights).filter(([k]) => s.includes(k)).sort((a, b) => b[1] - a[1])[0];
  return hit ? hit[1] : 0.5;
}

// ---------------------------------------------------------------- per-model extractors

const BUDGET_WHY = "needed to filter properties by affordability and check commercial feasibility";

export async function companyFeatures(db: Db, ws: string, orgId: string, config: Row): Promise<Features> {
  const b = await orgBundle(db, ws, orgId);
  if (!b.org) throw new Error("Company not found");
  const focus: string[] = (config.focus_cities as string[]) ?? ["Pune"];
  const v: Features["values"] = {};
  // Scale: headcount if known, otherwise sites count (only if > 0). Unknown is excluded, not negative.
  const hc = b.org.headcount_min as number | null;
  v.scale = hc ? fv(hc >= 5000 ? 1 : hc >= 1000 ? 0.8 : hc >= 250 ? 0.6 : hc >= 50 ? 0.35 : 0.15, `Headcount at least ${hc.toLocaleString("en-IN")}`, [{ type: "record", label: "Company record", tier: "records" }])
    : b.leases.length ? fv(Math.min(1, 0.3 + b.leases.length * 0.15), `${b.leases.length} lease(s) on record; headcount unknown`, [{ type: "record", label: `${b.leases.length} leases`, tier: "records" }])
    : fv(null, "Headcount and sites unknown");
  const iw = industryWeight(b.org.sector, (config.industry_weights as Record<string, number>) ?? {});
  v.industry = b.org.is_gcc ? fv(1, "Global capability centre (GCC)", [{ type: "record", label: "Marked as GCC", tier: "records" }])
    : iw === null ? fv(null, "Sector not recorded") : fv(iw, `Sector: ${b.org.sector}`, [{ type: "record", label: b.org.sector, tier: "records" }]);
  const puneSig = b.sigs.filter((s) => focus.some((c) => `${s.location_text ?? ""} ${s.title}`.toLowerCase().includes(c.toLowerCase())));
  const occ = b.leases.map((l) => [l.asset?.name, l.asset?.locality?.name].filter(Boolean).join(", "));
  v.geography = b.leases.length ? fv(puneSig.length ? 1 : 0.85, `Occupies ${occ.slice(0, 2).join("; ")}${puneSig.length ? " and has local expansion evidence" : ""}`, [...b.leases.slice(0, 3).map((l) => ({ type: "lease", id: l.id, label: l.asset?.name ?? "Lease", tier: "records" })), ...puneSig.slice(0, 2).map(sigEv)])
    : puneSig.length ? fv(0.7, `No recorded occupancy, but ${puneSig.length} signal(s) mention ${focus.join("/")}`, puneSig.slice(0, 3).map(sigEv))
    : fv(null, `No recorded ${focus.join("/")} presence (unknown, not absent)`);
  // Growth: count distinct growth events (signals are already de-duplicated per event in Module 2).
  const growth = b.sigs.filter((s) => GROWTH.has(s.kind) || s.category === "expansion");
  const fresh = growth.filter((s) => (ago(s.latest_evidence_on ?? s.detected_at) ?? 999) <= 180);
  v.growth = fv(growth.length ? Math.min(1, fresh.length * 0.4 + (growth.length - fresh.length) * 0.15) : 0,
    growth.length ? `${growth.length} growth event(s), ${fresh.length} in the last 6 months` : "No growth signals yet", growth.slice(0, 4).map(sigEv));
  const upcoming = b.events.filter((e) => { const d = days(e.event_date); return d !== null && d >= 0 && d <= 548; });
  v.cre = fv(Math.min(1, (b.leases.length ? 0.35 : 0) + (upcoming.length ? 0.4 : 0) + (b.reqs.length ? 0.35 : 0)),
    [b.leases.length && `${b.leases.length} lease(s)`, upcoming.length && `${upcoming.length} lease event(s) within 18 months`, b.reqs.length && `${b.reqs.length} open requirement(s)`].filter(Boolean).join(", ") || "No leases, lease events or requirements on record",
    [...upcoming.slice(0, 2).map((e) => ({ type: "lease_event", id: e.id, label: `${e.event_type} ${e.event_date}`, date: e.event_date, tier: e.confirmed ? "documentary_current" : "records" })), ...b.reqs.slice(0, 2).map((r) => ({ type: "requirement", id: r.id, label: r.title, tier: "records" }))]);
  const area = Math.max(0, ...b.leases.map((l) => Number(l.area_sf) || 0), ...b.reqs.map((r) => Number(r.area_max_sf ?? r.area_target_sf ?? r.area_min_sf) || 0));
  v.commercial = area ? fv(area >= 100000 ? 1 : area >= 50000 ? 0.8 : area >= 20000 ? 0.6 : area >= 5000 ? 0.4 : 0.2, `Largest known area ${area.toLocaleString("en-IN")} sq ft`, [{ type: "record", label: "Lease / requirement area", tier: "records" }])
    : fv(null, "No area recorded (not estimated)");
  const missing = [!hc && "Headcount", !b.org.sector && !b.org.is_gcc && "Sector", !b.leases.length && "Current occupancy / leases", !b.emps.length && "Contacts at the company"].filter(Boolean) as string[];
  const rec = !b.emps.length ? "Identify a real-estate, facilities or admin contact." : upcoming.length ? "Confirm intent ahead of the upcoming lease event." : growth.length ? "Verify whether the growth needs more space." : "Keep watching for triggers.";
  return { values: v, missing, recommended: rec, extra: { company: b.org.display_name } };
}

export async function contactFeatures(db: Db, ws: string, personId: string): Promise<Features> {
  const [person, emps, methods, links] = await Promise.all([
    db.from("person").select("id, full_name").eq("workspace_id", ws).eq("id", personId).maybeSingle().then((r) => r.data as Row | null),
    rows(db.from("employment").select("title, fact_status, is_current, updated_at, start_date, org:org_id(display_name)").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null).order("is_current", { ascending: false }).limit(5)),
    rows(db.from("contact_method").select("method_type, verified_on, suppressed, verify_status").eq("workspace_id", ws).eq("person_id", personId).is("archived_at", null)),
    rows(db.from("interaction_link").select("interaction:interaction_id(occurred_at, channel, is_meaningful)").eq("workspace_id", ws).eq("entity_type", "person").eq("entity_id", personId).limit(300)),
  ]);
  if (!person) throw new Error("Person not found");
  const cur = emps.find((e) => e.is_current);
  let role = classifyRole(cur?.title);
  const v: Features["values"] = {};
  // Module 4 role assessment (rules or a user's correction, with reason) takes precedence over the title heuristic.
  const { data: ra } = await db.from("contact_role_assessment").select("role_class, cre_relevance, reason, source").eq("workspace_id", ws).eq("person_id", personId).eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const REL: Record<string, number | null> = { high: 1, medium: 0.7, low: 0.4, none: 0.15, unknown: null };
  const MAP: Record<string, RoleClass> = { decision_maker: "decision_maker", economic_buyer: "influencer", influencer: "influencer", technical_evaluator: "evaluator", procurement: "evaluator", gatekeeper: "gatekeeper", operational: "operational", administrative: "operational", unknown: "unknown" };
  if (ra) role = { cls: MAP[ra.role_class] ?? "unknown", value: REL[ra.cre_relevance] ?? null, why: `${ra.source === "user" ? "Set by your team" : "Assessed"}: ${ra.reason}` };
  v.role = fv(role.value, role.why, cur ? [{ type: "employment", label: `${cur.title ?? "Role"} at ${cur.org?.display_name ?? "?"}`, tier: ra?.source === "user" ? "records" : cur.fact_status }] : []);
  v.employment = cur ? fv(cur.fact_status === "currently_confirmed" ? 1 : cur.fact_status === "reported" ? 0.6 : 0.3, `Current role is ${String(cur.fact_status).replace(/_/g, " ")}`, [{ type: "employment", label: cur.org?.display_name ?? "", tier: cur.fact_status }])
    : fv(0, "No current employment on record");
  const ints = links.map((l) => l.interaction).filter(Boolean) as Row[];
  const last = ints.map((i) => i.occurred_at).sort().pop();
  const meaningful = ints.filter((i) => i.is_meaningful || ["meeting", "visit", "call"].includes(i.channel)).length;
  v.relationship = fv(ints.length ? Math.min(1, meaningful * 0.25 + ((ago(last) ?? 999) <= 90 ? 0.3 : 0)) : 0, ints.length ? `${ints.length} interaction(s), ${meaningful} meaningful, last ${last?.slice(0, 10)}` : "No interactions recorded");
  const ok = methods.filter((m) => !m.suppressed && !["invalid", "risky", "generic"].includes(m.verify_status ?? ""));
  const good = ok.filter((m) => m.verified_on || ["verified", "likely_valid", "published_business"].includes(m.verify_status ?? ""));
  v.reachability = fv(ok.length ? Math.min(1, 0.4 + good.length * 0.3) : 0, ok.length ? `${ok.length} usable business channel(s), ${good.length} verified or published` : "No usable business email or phone");
  const conf = cur?.updated_at ? ago(cur.updated_at) : null;
  v.recency = conf === null ? fv(null, "Never verified") : fv(conf <= 90 ? 1 : conf <= 365 ? 0.6 : 0.25, `Role last updated ${conf} days ago`);
  const strategy: Record<RoleClass, string> = {
    decision_maker: "Engage directly with a specific, evidence-based reason to talk.", influencer: "Use as a sponsor; ask who owns the property decision.",
    evaluator: "Work with them on requirements and options; confirm who approves.", gatekeeper: "Be brief and respectful; ask for the right person.",
    operational: "Useful for site details; not for commercial decisions.", unknown: "Confirm their role in property decisions before investing time.",
  };
  return { values: v, extra: { role_class: role.cls, name: person.full_name, verification: cur?.fact_status ?? "none" },
    missing: [!cur && "Current employer", !ok.length && "Email or phone"].filter(Boolean) as string[], recommended: strategy[role.cls] };
}

export async function relationshipFeatures(db: Db, ws: string, orgId: string): Promise<Features> {
  const b = await orgBundle(db, ws, orgId);
  if (!b.org) throw new Error("Company not found");
  const personIds = b.emps.map((e) => e.person_id);
  const plinks = personIds.length ? await rows(db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, is_meaningful)").eq("workspace_id", ws).eq("entity_type", "person").in("entity_id", personIds).limit(1000)) : [];
  const all = new Map<string, Row>();
  for (const i of [...b.interactions, ...plinks.map((l) => l.interaction).filter(Boolean) as Row[]]) all.set(i.id, i);
  const ints = [...all.values()];
  const meetings = ints.filter((i) => ["meeting", "visit"].includes(i.channel)).length;
  const dates = ints.map((i) => i.occurred_at).sort();
  const lastAgo = ago(dates[dates.length - 1]);
  const { data: ov } = await db.from("score_override").select("value, reason, created_at").eq("workspace_id", ws).eq("model_key", "relationship").eq("entity_id", orgId).eq("kind", "relationship_assessment").eq("active", true).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const OWN: Record<string, number> = { strong: 1, active: 0.75, developing: 0.5, weak: 0.25, none: 0 };
  const v: Features["values"] = {
    meetings: fv(Math.min(1, meetings / 4), `${meetings} meeting(s) / visit(s)`),
    recency: fv(lastAgo === null ? 0 : lastAgo <= 30 ? 1 : lastAgo <= 90 ? 0.7 : lastAgo <= 180 ? 0.4 : 0.15, lastAgo === null ? "No interactions" : `Last interaction ${lastAgo} days ago`),
    depth: fv(ints.length ? ints.filter((i) => i.is_meaningful).length / ints.length : 0, ints.length ? `${ints.filter((i) => i.is_meaningful).length} of ${ints.length} interactions marked meaningful` : "No interactions"),
    duration: fv(dates.length > 1 ? Math.min(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365 * DAY)) : 0, dates.length > 1 ? `First ${dates[0].slice(0, 10)}, last ${dates[dates.length - 1].slice(0, 10)}` : "No history"),
    business: fv(b.opps.some((o) => o.outcome === "won") ? 1 : b.opps.some((o) => o.mandate_status === "exclusive") ? 0.8 : b.opps.length ? 0.3 : 0,
      b.opps.length ? `${b.opps.length} deal(s), ${b.opps.filter((o) => o.outcome === "won").length} won` : "No deals"),
    owner: ov ? fv(OWN[ov.value] ?? null, `Owner assessment: ${ov.value} — ${ov.reason}`, [{ type: "assessment", label: ov.reason, date: String(ov.created_at).slice(0, 10), tier: "records" }]) : fv(null, "No owner assessment"),
  };
  return { values: v, recommended: !ints.length ? "Start a relationship: find a warm introduction." : (lastAgo ?? 999) > 90 ? "Re-engage — last contact was over 3 months ago." : "Keep the cadence.", missing: ov ? [] : ["Relationship owner's assessment"] };
}

export async function requirementFeatures(db: Db, ws: string, reqId: string): Promise<Features> {
  const { data: r } = await db.from("requirement").select("*, org:org_id(display_name)").eq("workspace_id", ws).eq("id", reqId).maybeSingle();
  if (!r) throw new Error("Requirement not found");
  const sh = await rows(db.from("stakeholder").select("role, person:person_id(full_name)").eq("workspace_id", ws).eq("requirement_id", reqId).is("archived_at", null));
  const c = (r.constraints ?? {}) as Row;
  const v: Features["values"] = {};
  const ev = (label: string): Evidence[] => [{ type: "requirement", id: r.id, label, tier: r.status === "client_confirmed" ? "currently_confirmed" : "records" }];
  v.verified = fv(r.status === "client_confirmed" ? 1 : r.status === "estimated" ? 0.3 : 0.1, `Status: ${String(r.status).replace(/_/g, " ")}${r.confirmed_at ? `, confirmed ${String(r.confirmed_at).slice(0, 10)}` : ""}`, ev("Status"));
  const areaN = [r.area_min_sf, r.area_target_sf, r.area_max_sf].filter((x) => x != null).length;
  v.area = fv(areaN >= 2 ? 1 : areaN === 1 ? 0.6 : 0, areaN ? `Area ${[r.area_min_sf, r.area_target_sf, r.area_max_sf].map((x) => x ?? "?").join(" / ")} sq ft (min/target/max)` : "No area given", ev("Area"));
  v.location = fv((r.preferred_geography_ids ?? []).length ? 1 : 0, (r.preferred_geography_ids ?? []).length ? `${r.preferred_geography_ids.length} preferred location(s)` : "No preferred micro-market");
  const hasBudget = r.budget_min != null || r.budget_max != null;
  v.budget = hasBudget ? fv(r.budget_min != null && r.budget_max != null ? 1 : 0.6, `Budget ${r.budget_min ?? "?"}–${r.budget_max ?? "?"} ${r.budget_basis ?? ""}`)
    : fv(null, `Budget unknown — ${BUDGET_WHY}`);
  const when = r.occupation_date ?? r.decision_date;
  const dd = days(when);
  v.timing = fv(when ? (dd !== null && dd < 0 ? 0.3 : 1) : 0, when ? `${r.occupation_date ? "Move-in" : "Decision"} ${when}${dd !== null ? ` (${dd >= 0 ? `in ${dd} days` : "passed"})` : ""}` : "No move-in or decision date");
  // The requirement form stores captured values under constraints.values (older rows used top-level keys) — read both.
  const cv = { ...c, ...((c.values ?? {}) as Row) } as Row;
  const has = (k: string) => cv[k] != null && cv[k] !== "" && !(Array.isArray(cv[k]) && !cv[k].length);
  const tenureKnown = has("tenure_months") || has("lease_term_years");
  const SPEC_LABEL: Record<string, string> = { tenure_months: "lease tenure", lease_term_years: "lease tenure", lockin_months: "lock-in", furnishing: "furnishing", fitout_standard: "fit-out standard", fitout: "fit-out", parking: "parking", power: "power", it_load: "IT load", certifications: "certifications" };
  const specKeys = Object.keys(SPEC_LABEL).filter(has).filter((k) => !(k === "lease_term_years" && has("tenure_months")));
  v.specs = fv(Math.min(1, specKeys.length / 3), specKeys.length ? `Lease terms & technical specs captured: ${specKeys.map((k) => SPEC_LABEL[k]).join(", ")}` : "Lease tenure and technical specs (power, IT load, parking) not captured");
  v.decision_maker = fv(r.confirmed_by_person_id || sh.some((s) => ["approver", "sponsor"].includes(s.role)) ? 1 : sh.length ? 0.5 : 0, sh.length ? `${sh.length} stakeholder(s): ${sh.map((s) => `${s.person?.full_name} (${s.role})`).slice(0, 3).join(", ")}` : "No stakeholder recorded");
  const approver = sh.some((s) => ["approver", "economic_buyer", "signatory", "finance"].includes(String(s.role)));
  const approvalBits = [has("procurement_process") && `procurement: ${cv.procurement_process}`, has("commercial_authority") && `commercial authority: ${cv.commercial_authority}`, approver && "approver stakeholder recorded"].filter(Boolean) as string[];
  v.approval = fv(approvalBits.length >= 2 ? 1 : approvalBits.length ? 0.6 : 0, approvalBits.length ? `Approval process: ${approvalBits.join("; ")}` : "Approval process / commercial authority not recorded");
  // Commercial feasibility: recorded budget vs asking rents of shortlisted options (deterministic, no inference).
  const opts = await rows(db.from("shortlist_option").select("space_id, asset_id, availability_id").eq("workspace_id", ws).eq("requirement_id", reqId).is("archived_at", null).limit(100));
  let rents: number[] = [];
  const avIds = opts.map((o) => o.availability_id).filter(Boolean);
  if (avIds.length) rents = (await rows(db.from("availability").select("asking_rent_min").eq("workspace_id", ws).in("id", avIds))).map((a) => Number(a.asking_rent_min)).filter((x) => Number.isFinite(x) && x > 0);
  const budgetMax = r.budget_max != null ? Number(r.budget_max) : r.budget_min != null ? Number(r.budget_min) : null;
  const perSf = !r.budget_basis || /sf|sq|psf/i.test(String(r.budget_basis));
  if (budgetMax === null) v.feasibility = fv(null, "Commercial feasibility unknown — no budget to compare with asking rents");
  else if (!perSf) v.feasibility = fv(null, `Commercial feasibility not compared — budget basis "${r.budget_basis}" is not per sq ft`);
  else if (!rents.length) v.feasibility = fv(null, "Commercial feasibility not yet checked — no shortlisted options with an asking rent");
  else { const ok = rents.filter((x) => x <= budgetMax).length; v.feasibility = fv(ok / rents.length, `Commercial feasibility: ${ok} of ${rents.length} shortlisted option(s) at or under the ₹${budgetMax}/sf budget`); }
  const ver = ago(r.confirmed_at ?? r.updated_at);
  v.freshness = ver === null ? fv(null, "Never verified") : fv(ver <= 30 ? 1 : ver <= 90 ? 0.7 : ver <= 180 ? 0.4 : 0.15, `Last updated ${ver} days ago`);
  // Separate sub-assessments, as required: completeness / urgency / attractiveness / verification.
  const urgency = dd === null ? null : dd < 0 ? 0 : dd <= 90 ? 100 : dd <= 180 ? 70 : dd <= 365 ? 40 : 20;
  const area = Number(r.area_max_sf ?? r.area_target_sf ?? r.area_min_sf) || null;
  const attractiveness = area === null ? null : area >= 50000 ? 100 : area >= 20000 ? 75 : area >= 10000 ? 55 : area >= 5000 ? 35 : 20;
  return {
    values: v,
    extra: { company: r.org?.display_name, title: r.title, urgency, attractiveness, verification: r.status },
    missing: [!areaN && "Area range", !(r.preferred_geography_ids ?? []).length && "Preferred micro-market", !hasBudget && "Budget", !when && "Move-in date", !tenureKnown && "Lease duration", !has("furnishing") && !has("fitout_standard") && "Furnishing / fit-out preference", !approvalBits.length && "Approval process / commercial authority", !sh.length && !r.confirmed_by_person_id && "Decision-maker"].filter(Boolean) as string[],
    recommended: r.status !== "client_confirmed" ? "Confirm the requirement with the client." : !when ? "Get the move-in date." : "Run property matching and shortlist.",
  };
}

/** Scores that other models reuse (company, contact, requirement, relationship) — read from the current result. */
async function current(db: Db, ws: string, model: ModelKey, id: string): Promise<number | null> {
  const { data } = await db.from("score_result").select("score").eq("workspace_id", ws).eq("model_key", model).eq("entity_id", id).eq("is_current", true).maybeSingle();
  return data ? Number(data.score) : null;
}
async function bestContact(db: Db, ws: string, emps: Row[]): Promise<{ v: number | null; why: string; ev: Evidence[] }> {
  let best: { v: number; why: string; ev: Evidence[] } | null = null;
  for (const e of emps) {
    const c = classifyRole(e.title);
    if (c.value !== null && (!best || c.value > best.v)) best = { v: c.value, why: `${e.person?.full_name ?? "Contact"} — ${c.why}`, ev: [{ type: "person", id: e.person_id, label: e.person?.full_name ?? "", tier: e.fact_status }] };
  }
  return best ?? { v: 0, why: emps.length ? "Contacts on record have no property-related role" : "No contacts on record", ev: [] };
}

export async function leadFeatures(db: Db, ws: string, orgId: string): Promise<Features> {
  const b = await orgBundle(db, ws, orgId);
  if (!b.org) throw new Error("Company not found");
  const needSig = b.sigs.filter((s) => NEED.has(s.kind) || s.category === "restructuring");
  const upcoming = b.events.filter((e) => { const d = days(e.event_date); return d !== null && d >= 0 && d <= 548; }).sort((x, y) => x.event_date.localeCompare(y.event_date));
  const v: Features["values"] = {};
  const needs = [b.reqs.length && (b.reqs.some((r) => r.status === "client_confirmed") ? "confirmed requirement" : "unverified requirement"), upcoming.length && "lease event within 18 months", needSig.length && `${needSig[0].kind.replace(/_/g, " ")} signal`].filter(Boolean) as string[];
  // A client-confirmed requirement is a real need; an unverified one (e.g. created from a signal) counts less.
  const confirmed = b.reqs.some((r) => r.status === "client_confirmed");
  v.need = fv(confirmed ? 1 : upcoming.length ? 0.85 : b.reqs.length ? 0.7 : needSig.length ? 0.6 : 0, needs.length ? `Need: ${needs.join(", ")}` : "No identifiable CRE need yet",
    [...b.reqs.slice(0, 1).map((r) => ({ type: "requirement", id: r.id, label: r.title, tier: "records" })), ...upcoming.slice(0, 1).map((e) => ({ type: "lease_event", id: e.id, label: `${e.event_type} ${e.event_date}`, tier: e.confirmed ? "documentary_current" : "records" })), ...needSig.slice(0, 2).map(sigEv)]);
  const dates = [...upcoming.map((e) => e.event_date), ...b.reqs.map((r) => r.decision_date ?? r.occupation_date).filter(Boolean), ...needSig.map((s) => s.event_date).filter(Boolean)].filter((d) => (days(d) ?? -1) >= 0).sort();
  const nd = dates.length ? days(dates[0]) : null;
  v.timing = nd === null ? fv(null, "No dated event (timing unknown)") : fv(nd <= 90 ? 1 : nd <= 180 ? 0.75 : nd <= 365 ? 0.45 : 0.2, `Nearest dated event in ${nd} days (${dates[0]})`);
  const budgeted = b.reqs.find((r) => r.budget_min != null || r.budget_max != null);
  const bc = await bestContact(db, ws, b.emps);
  v.authority = fv(bc.v, bc.why, bc.ev);
  // Commercial fit = company attractiveness (scored on demand by the service) + recorded budget evidence (never inferred).
  const cs = await current(db, ws, "company", orgId);
  const bv = budgeted ? (budgeted.status === "client_confirmed" ? 1 : 0.6) : null;
  const fitParts = [cs !== null && `company attractiveness ${cs}/100`, budgeted ? `budget recorded on “${budgeted.title}”${budgeted.status === "client_confirmed" ? " (client-confirmed)" : ""}` : "no budget evidence (not inferred)"].filter(Boolean);
  v.fit = cs === null && bv === null ? fv(null, "Company not scored and no budget evidence")
    : fv(cs === null ? (bv as number) : bv === null ? cs / 100 : 0.7 * (cs / 100) + 0.3 * bv, `Commercial fit: ${fitParts.join("; ")}`,
      budgeted ? [{ type: "requirement", id: budgeted.id, label: budgeted.title, tier: "records" }] : []);
  // Engagement counts interactions with the company AND with its current people (deduplicated).
  const pids = b.emps.map((e) => e.person_id);
  const pl = pids.length ? await rows(db.from("interaction_link").select("interaction:interaction_id(id, occurred_at, channel, is_meaningful)").eq("workspace_id", ws).eq("entity_type", "person").in("entity_id", pids).limit(1000)) : [];
  const allInt = new Map<string, Row>();
  for (const i of [...b.interactions, ...pl.map((l) => l.interaction).filter(Boolean) as Row[]]) allInt.set(i.id, i);
  const recent = [...allInt.values()].filter((i) => (ago(i.occurred_at) ?? 999) <= 180);
  v.engagement = fv(Math.min(1, recent.filter((i) => i.is_meaningful || ["meeting", "call", "visit"].includes(i.channel)).length * 0.35 + (recent.length ? 0.15 : 0)), recent.length ? `${recent.length} interaction(s) in 180 days` : "No recent engagement");
  const best = [...b.sigs].sort((x, y) => (y.confidence === "high" ? 3 : y.confidence === "medium" ? 2 : 1) - (x.confidence === "high" ? 3 : x.confidence === "medium" ? 2 : 1))[0];
  const bestAge = best ? ago(best.latest_evidence_on ?? best.detected_at) : null;
  const freshness = bestAge === null ? 0.5 : bestAge <= 30 ? 1 : bestAge <= 90 ? 0.8 : bestAge <= 180 ? 0.6 : bestAge <= 365 ? 0.4 : 0.2;
  v.evidence = best ? fv((best.confidence === "high" ? 1 : best.confidence === "medium" ? 0.8 : 0.6) * freshness, `Best evidence: ${best.title} (${best.confidence}${bestAge !== null ? `, ${bestAge} days old` : ", date unknown"})`, [sigEv(best)])
    : upcoming.length ? fv(upcoming[0].confirmed ? 1 : 0.6, "Lease record", [{ type: "lease_event", id: upcoming[0].id, label: upcoming[0].event_type, tier: upcoming[0].confirmed ? "documentary_current" : "records" }]) : fv(0, "No supporting evidence");
  return { values: v, extra: { company: b.org.display_name },
    missing: [!budgeted && "Budget", bc.v === 0 && "Decision-maker", nd === null && "Timing / dates", !b.leases.length && "Current occupancy"].filter(Boolean) as string[],
    recommended: !needs.length ? "Watch for a trigger before investing time." : (bc.v ?? 0) < 0.6 ? "Find the property decision-maker." : "Reach out with the specific trigger and propose a conversation." };
}

export async function opportunityFeatures(db: Db, ws: string, oppId: string): Promise<Features> {
  const { data: o } = await db.from("opportunity").select("*, org:org_id(display_name)").eq("workspace_id", ws).eq("id", oppId).maybeSingle();
  if (!o) throw new Error("Opportunity not found");
  const [req, emps, opts, links] = await Promise.all([
    o.requirement_id ? db.from("requirement").select("id, title, area_min_sf, area_target_sf, area_max_sf, decision_date, occupation_date").eq("id", o.requirement_id).maybeSingle().then((r) => r.data as Row | null) : Promise.resolve(null),
    rows(db.from("employment").select("person_id, title, fact_status, person:person_id(full_name)").eq("workspace_id", ws).eq("org_id", o.org_id).eq("is_current", true).is("archived_at", null).limit(50)),
    o.requirement_id ? rows(db.from("shortlist_option").select("id, eligible").eq("workspace_id", ws).eq("requirement_id", o.requirement_id).is("archived_at", null).limit(200)) : Promise.resolve([] as Row[]),
    rows(db.from("interaction").select("occurred_at, is_meaningful, channel").eq("workspace_id", ws).eq("opportunity_id", oppId).limit(200)),
  ]);
  const v: Features["values"] = {};
  const rs = req ? await current(db, ws, "requirement", req.id) : null;
  v.requirement = req ? (rs === null ? fv(null, "Requirement not scored yet") : fv(rs / 100, `Requirement quality ${rs}/100`, [{ type: "requirement", id: req.id, label: req.title, tier: "records" }])) : fv(0, "No requirement linked");
  const cs = await current(db, ws, "company", o.org_id);
  v.company = cs === null ? fv(null, "Company not scored yet") : fv(cs / 100, `Company attractiveness ${cs}/100`);
  const bc = await bestContact(db, ws, emps);
  v.access = fv(bc.v, bc.why, bc.ev);
  const rel = await current(db, ws, "relationship", o.org_id);
  v.relationship = rel === null ? fv(0, "Relationship not scored yet") : fv(rel / 100, `Relationship ${rel}/100`);
  const elig = opts.filter((x) => x.eligible).length;
  v.supply = req ? (opts.length ? fv(Math.min(1, elig / 3), `${elig} eligible option(s) of ${opts.length} matched`) : fv(null, "Property matching not run yet")) : fv(null, "No requirement to match");
  const area = req ? Number(req.area_max_sf ?? req.area_target_sf ?? req.area_min_sf) || null : null;
  v.value = o.expected_fee ? fv(Math.min(1, Number(o.expected_fee) / 5_000_000), `Expected fee ₹${Number(o.expected_fee).toLocaleString("en-IN")}`)
    : area ? fv(area >= 50000 ? 1 : area >= 20000 ? 0.7 : area >= 10000 ? 0.5 : 0.3, `Requirement ${area.toLocaleString("en-IN")} sq ft (fee not recorded)`) : fv(null, "Value unknown (fee and area not recorded)");
  const when = o.expected_close ?? req?.decision_date ?? req?.occupation_date;
  const dd = days(when);
  v.timing = dd === null ? fv(null, "No close or decision date") : fv(dd < 0 ? 0.2 : dd <= 90 ? 1 : dd <= 180 ? 0.7 : 0.4, `${o.expected_close ? "Expected close" : "Decision"} ${when}${dd < 0 ? " (passed)" : ` in ${dd} days`}`);
  v.mandate = fv(o.mandate_status === "exclusive" ? 1 : o.mandate_status === "non_exclusive" ? 0.55 : o.mandate_status === "support" ? 0.4 : o.mandate_status === "none" ? 0.1 : null, `Mandate: ${String(o.mandate_status ?? "unknown").replace(/_/g, " ")}`);
  const recent = links.filter((i) => (ago(i.occurred_at) ?? 999) <= 60);
  v.engagement = fv(Math.min(1, recent.length * 0.3), recent.length ? `${recent.length} interaction(s) in 60 days` : "No recent engagement on this deal");
  v.next_action = fv(o.next_action ? 1 : 0, o.next_action ? `Next: ${o.next_action}` : "No next action set");
  const health = await dealHealth(db, ws, o, links);
  // Revenue only when inputs exist; no win probability (no validated outcome history yet).
  const risks = [!req && "No requirement linked", (bc.v ?? 0) < 0.6 && "No clear decision-maker access", o.mandate_status !== "exclusive" && "No exclusive mandate", dd !== null && dd < 0 && "Close date has passed", o.risks].filter(Boolean) as string[];
  return { values: v, extra: { company: o.org?.display_name, name: o.name, stage: o.stage, risks, health, revenue: o.expected_fee ? Number(o.expected_fee) : null, probability: "Not estimated: not enough historical outcomes to validate a win probability." },
    missing: [!req && "Linked requirement", !o.expected_fee && "Expected fee", !when && "Expected close date", (o.mandate_status ?? "unknown") === "unknown" && "Mandate status"].filter(Boolean) as string[],
    recommended: health.blockers.length ? `Resolve the blocker: ${health.blockers[0]}` : health.pendingApprovals.length ? "Clear the pending approval in Approvals." : health.overdue.length ? `Overdue: ${health.overdue[0]}` : !o.next_action ? "Set the next action." : (bc.v ?? 0) < 0.6 ? "Get access to the decision-maker." : !opts.length && req ? "Run property matching." : "Advance to the next stage." };
}

/**
 * Deal health — kept SEPARATE from attractiveness: what is blocking the deal right now (unresolved objections, pending
 * approvals, overdue next action, no recent progress). Rules only; every item says why.
 */
export interface DealHealth { status: "healthy" | "at_risk" | "stalled"; blockers: string[]; pendingApprovals: string[]; overdue: string[]; stalled: string | null; daysSinceInteraction: number | null; daysInStage: number | null; reasons: string[] }
export async function dealHealth(db: Db, ws: string, o: Row, interactions: Row[]): Promise<DealHealth> {
  const [objs, props] = await Promise.all([
    rows(db.from("objection_log").select("id, category, objection, outcome, raised_on").eq("workspace_id", ws).eq("opportunity_id", o.id).is("archived_at", null).limit(50)),
    rows(db.from("change_proposal").select("id, reason, created_at").eq("workspace_id", ws).eq("target_type", "opportunity").eq("target_id", o.id).in("state", ["proposed", "clarify"]).limit(20)),
  ]);
  const open = objs.filter((x) => !["resolved", "overcome", "accepted", "withdrawn"].includes(String(x.outcome ?? "").toLowerCase()));
  const blockers = open.map((x) => `Unresolved objection (${String(x.category ?? "other").replace(/_/g, " ")}): ${x.objection}`);
  const pendingApprovals = props.map((p) => `Pending approval since ${String(p.created_at).slice(0, 10)}: ${p.reason ?? "change awaiting review"}`);
  const dueIn = days(o.next_action_due);
  const overdue = o.next_action && dueIn !== null && dueIn < 0 ? [`Next action "${o.next_action}" overdue by ${-dueIn} days (due ${o.next_action_due})`] : [];
  const last = interactions.map((i) => i.occurred_at).filter(Boolean).sort().pop();
  const since = ago(last);
  const inStage = ago(o.stage_entered_at);
  const closed = o.outcome && o.outcome !== "open";
  const stallBits = [since === null ? "no interaction logged on this deal" : since > 30 ? `no interaction for ${since} days` : null, overdue.length ? "next action overdue" : null, inStage !== null && inStage > 60 ? `${inStage} days in stage ${String(o.stage ?? "").replace(/_/g, " ")}` : null].filter(Boolean) as string[];
  const stalled = !closed && stallBits.length && (since === null || since > 30) ? `Stalled — no recent progress: ${stallBits.join("; ")}` : null;
  const status = stalled ? "stalled" : blockers.length || pendingApprovals.length || overdue.length ? "at_risk" : "healthy";
  return { status, blockers, pendingApprovals, overdue, stalled, daysSinceInteraction: since, daysInStage: inStage, reasons: [...blockers, ...pendingApprovals, ...overdue, ...(stalled ? [stalled] : [])] };
}

export const ENTITY_FOR: Record<ModelKey, string> = { company: "organisation", lead: "organisation", relationship: "organisation", contact: "person", requirement: "requirement", opportunity: "opportunity" };

export async function extract(db: Db, ws: string, model: ModelKey, id: string, config: Row): Promise<Features> {
  switch (model) {
    case "company": return companyFeatures(db, ws, id, config);
    case "lead": return leadFeatures(db, ws, id);
    case "contact": return contactFeatures(db, ws, id);
    case "relationship": return relationshipFeatures(db, ws, id);
    case "requirement": return requirementFeatures(db, ws, id);
    case "opportunity": return opportunityFeatures(db, ws, id);
  }
}

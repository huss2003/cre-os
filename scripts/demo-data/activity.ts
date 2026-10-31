/** Interactions (+links) in the last 60 days, tasks (some overdue), meetings/site visits today & tomorrow (IST), signal claims. */
import { Rng, addDays, base, did, edate, ist, OWNER_USER_ID, type GenContext, type Row } from "./core";
import { orgId, orgByKey } from "./organisations";
import { oppId, OPP_DEFS, reqId } from "./deals";
import type { AssetDef } from "./assets";
import type { PersonDef } from "./people";

export function buildActivity(ctx: GenContext, roster: PersonDef[], assets: AssetDef[], leases: Row[]) {
  const rng = new Rng("activity");
  const interactions: Row[] = [];
  const links: Row[] = [];
  const tasks: Row[] = [];
  const meetings: Row[] = [];
  const signals: Row[] = [];
  const contactable = roster.filter((p) => !p.suppressed);
  const oppForOrg = (org: string) => OPP_DEFS.find((o) => o.org === org && o.outcome === "open");
  const firstAt = (org: string) => roster.find((p) => p.orgKey === org)!;

  // ---------------------------------------------------------------- interactions
  const SUBJECTS: Record<string, string[]> = {
    email: ["Shortlist for your Pune requirement", "Revised commercials from landlord", "Site visit schedule", "Follow-up: space options in {loc}", "Market update — Pune office Q3", "Re: LOI mark-up comments"],
    call: ["Discovery call", "Commercials discussion", "Check-in on timelines", "Debrief after site visits"],
    meeting: ["Requirement workshop", "Options review", "LOI negotiation", "Quarterly account review"],
    whatsapp: ["Quick update on visit timing", "Sharing floor plan", "Landlord confirmed parking ratio"],
    visit: ["Site visit"],
  };
  const LOCS = ["Kharadi", "Hinjewadi", "Baner", "Viman Nagar", "Magarpatta"];
  const addInteraction = (n: number, p: PersonDef, daysAgo: number, channel: string, direction: string, extra: Row = {}) => {
    const id = did("interaction", `I-${n}`);
    const opp = oppForOrg(p.orgKey);
    const subject = rng.pick(SUBJECTS[channel]).replace("{loc}", rng.pick(LOCS));
    const meaningful = channel === "meeting" || channel === "visit" || (channel === "call" && rng.chance(0.8)) || (direction === "inbound" && rng.chance(0.5));
    interactions.push({
      ...base(), id, occurred_at: ist(addDays(ctx.today, -daysAgo), `${String(rng.int(9, 18)).padStart(2, "0")}:${rng.pick(["00", "15", "30", "45"])}`),
      channel, direction, subject,
      summary: `${subject} with ${p.name} (${orgByKey(p.orgKey).name}). Synthetic demo summary.`,
      promises: rng.chance(0.3) ? [{ by: rng.pick(["us", "them"]), what: rng.pick(["Send revised shortlist", "Share board-approved budget", "Confirm visit slots", "Send floor plans"]), due: addDays(ctx.today, -daysAgo + rng.int(2, 7)) }] : [],
      objections: rng.chance(0.2) ? [{ text: rng.pick(["Rent above budget", "Too far from talent pool", "Lock-in too long", "Parking ratio insufficient"]) }] : [],
      source_message_id: channel === "email" ? `<demo-${n}@mail.example.com>` : null,
      source_object_id: ctx.sourceObjectId, capture_id: null, recording_uri: null, transcript_uri: null,
      opportunity_id: opp ? oppId(opp.key) : null, is_meaningful: meaningful, ...extra,
    });
    links.push({ ...base(), id: did("interaction_link", `I-${n}:person`), interaction_id: id, entity_type: "person", entity_id: p.id, role: direction === "inbound" ? "from" : direction === "outbound" ? "to" : "participant" });
    links.push({ ...base(), id: did("interaction_link", `I-${n}:org`), interaction_id: id, entity_type: "organisation", entity_id: orgId(p.orgKey), role: "mentioned" });
  };
  // weighted towards people at orgs with open opportunities
  const hot = contactable.filter((p) => oppForOrg(p.orgKey));
  for (let n = 1; n <= 58; n++) {
    const p = rng.chance(0.65) ? rng.pick(hot) : rng.pick(contactable);
    const channel = rng.pick(["email", "email", "email", "email", "call", "call", "meeting", "whatsapp", "visit"]);
    const direction = channel === "meeting" || channel === "visit" ? "outbound" : rng.pick(["inbound", "outbound", "outbound"]);
    addInteraction(n, p, rng.int(1, 59), channel, direction); // never in the future
  }
  // the opt-out reply from the suppressed person (21 days ago) — nothing outbound after it
  const sup = roster.find((p) => p.suppressed)!;
  addInteraction(59, sup, 21, "email", "inbound", { subject: "Please remove me from your mailing list", summary: `${sup.name} asked not to be contacted again. Synthetic demo record; consent suppressed.`, promises: [], objections: [], is_meaningful: true, opportunity_id: null });

  // ---------------------------------------------------------------- meetings & site visits (IST)
  const T = ctx.today;
  const T1 = addDays(T, 1);
  const T2 = addDays(T, 2);
  const asset = (k: string) => assets.find((a) => a.key === k)!;
  const mv = (key: string, date: string, from: string, to: string, kind: string, title: string, o: { assetKey?: string; opp?: string; route?: string; status?: string; location?: string }) => {
    const a = o.assetKey ? asset(o.assetKey) : null;
    const id = did("meeting_visit", key);
    const startAt = ist(date, from);
    meetings.push({
      ...base(), id, external_calendar_id: null, provider: "manual", title,
      start_at: startAt, end_at: ist(date, to), timezone: "Asia/Kolkata",
      location: a ? `${a.name} (synthetic)` : o.location ?? null, lat: a?.lat ?? null, lon: a?.lon ?? null,
      kind, route_group: o.route ?? null, status: o.status ?? "confirmed",
      opportunity_id: o.opp ? oppId(o.opp) : null,
      linked_entity_type: a ? "asset" : o.opp ? "opportunity" : null, linked_entity_id: a ? a.id : o.opp ? oppId(o.opp) : null,
      version_key: `manual:${key}:${startAt}`,
    });
  };
  const nw = firstAt("northwind_gcc");
  mv("M-today-1", T, "09:30", "10:00", "call", `Call — ${nw.name} (Northwind GCC) on revised commercials`, { opp: "O1", location: "Phone" });
  mv("M-today-2", T, "11:00", "12:00", "meeting", "Banyan Helix — LOI review", { opp: "O3", assetKey: "kalyani_crescent:A" });
  mv("M-today-3", T, "14:00", "14:45", "site_visit", "Site visit — Glasswing (Kharadi loop) #1", { opp: "O2", assetKey: "riverstone_tp:A", route: `kharadi-${T}` });
  mv("M-today-4", T, "15:00", "15:45", "site_visit", "Site visit — Glasswing (Kharadi loop) #2", { opp: "O2", assetKey: "riverstone_eg:B", route: `kharadi-${T}` });
  mv("M-today-5", T, "16:15", "17:00", "site_visit", "Site visit — Glasswing (Kharadi loop) #3", { opp: "O2", assetKey: "kharadi_pinnacle", route: `kharadi-${T}` });
  mv("M-tmrw-1", T1, "10:00", "10:45", "site_visit", "Site visit — Cobaltfern (Hinjewadi loop) #1", { opp: "O5", assetKey: "kalpa_gardens:B", route: `hinjewadi-${T1}` });
  mv("M-tmrw-2", T1, "11:15", "12:00", "site_visit", "Site visit — Cobaltfern (Hinjewadi loop) #2", { opp: "O5", assetKey: "bluecairn_kc:A", route: `hinjewadi-${T1}` });
  mv("M-tmrw-3", T1, "12:30", "13:15", "site_visit", "Site visit — Cobaltfern (Hinjewadi loop) #3", { opp: "O5", assetKey: "tarangan_meadows:A", route: `hinjewadi-${T1}` });
  mv("M-tmrw-4", T1, "15:30", "16:30", "meeting", "Orchard Lumen GCC — lease deed clause review", { opp: "O6", assetKey: "westgate_cp:A" });
  mv("M-tmrw-5", T1, "18:00", "18:30", "internal", "Weekly pipeline review", { status: "provisional", location: "Office" });
  mv("M-later-1", T2, "11:00", "12:00", "meeting", "Kestrelbay — managed space options", { opp: "O4", status: "provisional", location: "Koregaon Park (synthetic)" });
  mv("M-past-1", addDays(T, -6), "10:00", "10:45", "site_visit", "Site visit — Banyan Helix (Magarpatta) #1", { opp: "O3", assetKey: "amberline_square:A", route: `magarpatta-${addDays(T, -6)}`, status: "completed" });
  mv("M-past-2", addDays(T, -6), "11:15", "12:00", "site_visit", "Site visit — Banyan Helix (Magarpatta) #2", { opp: "O3", assetKey: "magarpatta_annex", route: `magarpatta-${addDays(T, -6)}`, status: "completed" });
  mv("M-past-3", addDays(T, -1), "16:00", "16:30", "meeting", "Saffron Abacus — intro meeting", { opp: "O9", status: "cancelled", location: "Shivajinagar (synthetic)" });

  // ---------------------------------------------------------------- tasks
  const leaseSoon = leases.filter((l) => l.contractual_expiry && (l.contractual_expiry as string) > T && (l.contractual_expiry as string) < edate(T, 12));
  type TaskSpec = [title: string, dueOffsetDays: number | null, status: string, linkType: string | null, linkId: string | null, priority: number, source: string];
  const specs: TaskSpec[] = [
    ["Send revised commercial comparison to Northwind GCC", -1, "open", "opportunity", oppId("O1"), 90, "manual"],
    ["Chase landlord on Banyan Helix LOI mark-up", -2, "open", "opportunity", oppId("O3"), 85, "brief"],
    ["Review Orchard lease deed draft — escalation & lock-in clauses", -5, "open", "opportunity", oppId("O6"), 80, "manual"],
    ["Raise invoice for Lotuscore signing milestone", -8, "open", "opportunity", oppId("O13"), 75, "manual"],
    ["Follow up on intro email to Quokka Grid", -1, "open", "opportunity", oppId("O8"), 40, "brief"],
    ["Verify stale availability at Cantonment House", -12, "open", "asset", assets.find((a) => a.key === "cantonment_house")!.id, 35, "brief"],
    ["Confirm Kharadi visit access passes for Glasswing team", 0, "open", "opportunity", oppId("O2"), 70, "manual"],
    ["Prepare visit pack (floor plans + specs) for Hinjewadi loop", 0, "open", "opportunity", oppId("O5"), 65, "manual"],
    ["Update Kestrelbay seat count after finance call", 0, "open", "requirement", reqId("R4"), 50, "capture"],
    ["Call landlord re fit-out contribution — Riverstone Tech Park", 0, "open", "opportunity", oppId("O1"), 60, "manual"],
    ["Book discovery meeting with Saffron Abacus", 5, "open", "opportunity", oppId("O9"), 45, "manual"],
    ["Map decision-makers at Marigold Loop", 7, "open", "opportunity", oppId("O7"), 30, "manual"],
    ["Draft market note: SBD East Q3 absorption", 3, "open", null, null, 35, "manual"],
    ["Shortlist v2 for Cobaltfern after visits", 2, "open", "requirement", reqId("R5"), 55, "manual"],
    ["Confirm Glasswing budget band with sponsor", 4, "open", "requirement", reqId("R2"), 50, "brief"],
    ["Check notice period wording for upcoming expiry", 10, "open", "lease", (leaseSoon[0]?.id as string) ?? null, 60, "brief"],
    ["Confirm tenure from lease deed (fractional tenure flagged)", 6, "open", "lease", did("lease", "L-fractional-1"), 55, "brief"],
    ["Re-engage Velvetbyte after hiring freeze", 30, "snoozed", "opportunity", oppId("O14"), 20, "manual"],
    ["Send Q3 market update to warm contacts", 9, "snoozed", null, null, 25, "manual"],
    ["Send site-visit feedback form to Banyan Helix", -5, "done", "opportunity", oppId("O3"), 50, "manual"],
    ["Collect board approval letter from Northwind", -9, "done", "requirement", reqId("R1"), 70, "manual"],
    ["Share Orchard renewal TCO comparison", -14, "done", "opportunity", oppId("O6"), 65, "manual"],
    ["Log lost reason for Gearwell", -20, "done", "opportunity", oppId("O10"), 30, "manual"],
    ["Update Peacock Ridge collection status", -40, "done", "opportunity", oppId("O12"), 40, "manual"],
    ["Old reminder: chase 2025 landlord brochure", -75, "stale", null, null, 10, "manual"],
  ];
  specs.forEach(([title, due, status, lt, lid, prio, source], i) => {
    const dueAt = due == null ? null : ist(addDays(T, due), due === 0 ? "17:00" : "18:00");
    tasks.push({
      ...base(), id: did("task", `T-${i + 1}`), title, description: "Synthetic demo task.",
      due_at: dueAt, status,
      snoozed_until: status === "snoozed" ? ist(addDays(T, Math.max(1, (due ?? 3) - 2)), "09:00") : null,
      priority: prio, assigned_user_id: OWNER_USER_ID, linked_entity_type: lid ? lt : null, linked_entity_id: lid,
      depends_on: null, completion_evidence: status === "done" ? "Marked done by user (synthetic)" : null,
      completed_at: status === "done" ? ist(addDays(T, (due ?? 0) + 1), "12:30") : null,
      source, idempotency_key: `demo:task:${i + 1}`,
    });
  });
  // one dependency: visit pack depends on access passes
  tasks[7].depends_on = tasks[6].id;

  // ---------------------------------------------------------------- signal claims
  let sn = 0;
  const sig = (subjectType: string, subjectId: string, claimType: string, predicate: string, value: Row, o: { status?: string; tier: string; excerpt: string; published: number; expires: number | null; approved?: boolean; contradicts?: string[] }) => {
    sn++;
    const id = did("signal_claim", `S-${sn}`);
    signals.push({
      ...base(), id, subject_type: subjectType, subject_id: subjectId, claim_type: claimType, predicate, value_json: { ...value, synthetic: true },
      status: o.status ?? "reported", evidence_tier: o.tier, evidence_excerpt: `${o.excerpt} (synthetic excerpt)`,
      source_url: `https://news.example.com/demo/${claimType}-${sn}`, source_locator: null, source_object_id: ctx.sourceObjectId,
      published_on: addDays(T, -o.published), observed_on: addDays(T, -o.published + 1), effective_on: null,
      expires_on: o.expires == null ? null : addDays(T, o.expires), contradicts: o.contradicts ?? [], approved_canonical: o.approved ?? false,
    });
    return id;
  };
  roster.filter((p) => p.moveDate && p.moveDate > addDays(T, -130)).forEach((p) =>
    sig("person", p.id, "job_move", "joined", { from_org: orgByKey(p.movedFromOrgKey!).name, to_org: orgByKey(p.orgKey).name, title: p.title.title }, { tier: "credible_reported", excerpt: `${p.name} has joined ${orgByKey(p.orgKey).name} as ${p.title.title}`, published: 10 + sn * 4, expires: 150 }),
  );
  const hiringId = sig("organisation", orgId("northwind_gcc"), "hiring", "hiring_in_pune", { roles: 320, function: "engineering", city: "Pune" }, { tier: "corroborated_public", excerpt: "Northwind Halberd GCC lists 300+ open Pune roles", published: 12, expires: 78 });
  sig("organisation", orgId("northwind_gcc"), "hiring", "hiring_slowdown", { roles: 40 }, { status: "ai_inference", tier: "inference", excerpt: "Job-board count fell this month — may indicate slowdown", published: 3, expires: 30, contradicts: [hiringId] });
  sig("organisation", orgId("glasswing_gcc"), "expansion", "plans_new_centre", { additional_seats: 800, city: "Pune" }, { tier: "credible_reported", excerpt: "Glasswing Retail plans second India technology centre", published: 40, expires: 140 });
  sig("organisation", orgId("kestrelbay"), "funding", "raised_round", { amount_usd_m: 45, round: "Series C" }, { status: "currently_confirmed", tier: "documentary_current", excerpt: "Kestrelbay Payments closes USD 45m Series C", published: 25, expires: 340, approved: true });
  sig("organisation", orgId("cobaltfern"), "expansion", "consolidation_plan", { sites_to_merge: 3 }, { tier: "single_unverified", excerpt: "Cobaltfern exploring single Pune campus", published: 55, expires: 35 });
  sig("organisation", orgId("saffron_abacus"), "rto", "return_to_office", { days_per_week: 4, effective_on: edate(T, 2) }, { tier: "credible_reported", excerpt: "Saffron Abacus Bank mandates four office days a week", published: 18, expires: 120 });
  sig("organisation", orgId("ironmonsoon"), "rto", "return_to_office", { days_per_week: 5 }, { tier: "corroborated_public", excerpt: "Ironmonsoon Capital returns to five-day office week", published: 200, expires: -20 });
  sig("organisation", orgId("fjordline"), "gcc_plan", "considering_india_gcc_expansion", { cities: ["Pune", "Bengaluru"] }, { status: "ai_inference", tier: "inference", excerpt: "Parent filings mention India engineering scale-up", published: 30, expires: 60 });
  sig("organisation", orgId("lotuscore"), "funding", "raised_round", { amount_usd_m: 18, round: "Series B" }, { status: "historical_observed", tier: "documentary_current", excerpt: "Lotuscore Therapeutics raised USD 18m", published: 400, expires: -35, approved: true });
  sig("organisation", orgId("pebblewick"), "hiring", "hiring_in_pune", { roles: 120 }, { tier: "single_unverified", excerpt: "Pebblewick Software hiring drive in Pune", published: 150, expires: -60 });
  sig("organisation", orgId("tamarind_stack"), "expansion", "new_floor", { additional_sf: 20000 }, { tier: "credible_reported", excerpt: "Tamarind Stack Labs taking an extra floor in Baner", published: 8, expires: 170 });
  sig("organisation", orgId("banyan_helix"), "expansion", "relocation_plan", { from: "Camp", to: "Magarpatta–Hadapsar" }, { status: "currently_confirmed", tier: "documentary_current", excerpt: "Banyan Helix confirms HQ move (board minutes)", published: 60, expires: 200 });
  sig("organisation", orgId("gearwell"), "hiring", "hiring_in_pune", { roles: 60 }, { tier: "corroborated_public", excerpt: "Gearwell Engineering hiring design engineers", published: 35, expires: 55 });

  return { interactions, links, tasks, meetings, signals };
}

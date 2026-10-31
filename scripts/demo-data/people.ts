/**
 * ~80 fictional people with Indian names, employment history (incl. job moves with closed old employment),
 * fake contact methods (example.com emails, +91-90000-xxxxx phones), relationship edges and consent records.
 */
import { Rng, addDays, base, did, edate, firstOfMonth, OWNER_USER_ID, SYNTHETIC_NOTE, type GenContext, type Row } from "./core";
import { ORGS, orgDomain, orgId, type OrgDef } from "./organisations";

const FIRST = [
  "Aarav", "Ananya", "Rohan", "Priya", "Vikram", "Sneha", "Arjun", "Kavya", "Siddharth", "Meera", "Aditya", "Neha",
  "Rahul", "Pooja", "Nikhil", "Isha", "Karan", "Divya", "Varun", "Shruti", "Manish", "Tanvi", "Harsh", "Riya",
  "Omkar", "Gauri", "Sameer", "Aparna", "Yash", "Radhika", "Kunal", "Madhura", "Abhishek", "Swati", "Pranav", "Ketaki",
  "Farhan", "Zoya", "Gurpreet", "Lakshmi",
] as const;
const LAST = [
  "Kulkarni", "Deshpande", "Joshi", "Patil", "Sharma", "Iyer", "Menon", "Gokhale", "Bhosale", "Reddy", "Nair", "Chavan",
  "Shah", "Mehta", "Agarwal", "Banerjee", "Rao", "Pawar", "Kapoor", "Sinha", "Thakur", "Pillai", "Desai", "Khan",
  "Gill", "Fernandes", "Naik", "Apte", "Shinde", "Bhattacharya",
] as const;

interface TitleDef { title: string; fn: string; seniority: string }
const OCCUPIER_TITLES: TitleDef[] = [
  { title: "Head – Real Estate & Workplace", fn: "real_estate", seniority: "head" },
  { title: "Director – Administration & Facilities", fn: "facilities", seniority: "director" },
  { title: "Chief Financial Officer", fn: "finance", seniority: "cxo" },
  { title: "Senior Manager – Procurement", fn: "procurement", seniority: "manager" },
  { title: "Site Leader, Pune", fn: "general_management", seniority: "director" },
  { title: "Associate General Counsel", fn: "legal", seniority: "director" },
  { title: "Head – IT Infrastructure", fn: "technology", seniority: "head" },
  { title: "HR Director", fn: "hr", seniority: "director" },
];
const DEVELOPER_TITLES: TitleDef[] = [
  { title: "VP – Leasing", fn: "leasing", seniority: "vp" },
  { title: "Asset Manager", fn: "asset_management", seniority: "manager" },
];
const OTHER_TITLES: TitleDef[] = [{ title: "City Head – Pune", fn: "business_development", seniority: "head" }];

export interface PersonDef {
  key: string;
  id: string;
  name: string;
  orgKey: string;
  title: TitleDef;
  employmentId: string;
  movedFromOrgKey: string | null;
  moveDate: string | null;
  suppressed: boolean;
}

export const personId = (key: string) => did("person", key);

/** Deterministic roster — computed once, shared by other generators. */
export function personRoster(today: string): PersonDef[] {
  const rng = new Rng("people:roster");
  const used = new Set<string>();
  const nextName = () => {
    for (;;) {
      const n = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
  const roster: PersonDef[] = [];
  let occIdx = 0;
  const add = (o: OrgDef, t: TitleDef) => {
    const key = `p${String(roster.length + 1).padStart(3, "0")}`;
    roster.push({ key, id: personId(key), name: nextName(), orgKey: o.key, title: t, employmentId: did("employment", `${key}:current`), movedFromOrgKey: null, moveDate: null, suppressed: false });
  };
  for (const o of ORGS) {
    if (o.role === "occupier") {
      const n = occIdx++ % 2 === 0 ? 3 : 2;
      const titles = rng.sample(OCCUPIER_TITLES.slice(1), n - 1);
      add(o, OCCUPIER_TITLES[0]); // every occupier has a real-estate decision-maker
      titles.forEach((t) => add(o, t));
    } else if (o.role === "developer") {
      DEVELOPER_TITLES.forEach((t) => add(o, t));
    } else if (o.role === "operator" || o.role === "broker") {
      add(o, OTHER_TITLES[0]);
    }
  }
  // Job moves: 8 people previously worked elsewhere; 3 of the moves are recent (signal-worthy).
  const occupierKeys = ORGS.filter((o) => o.role === "occupier").map((o) => o.key);
  const movers = rng.sample(roster.filter((p) => ORGS.find((o) => o.key === p.orgKey)!.role === "occupier"), 8);
  movers.forEach((p, i) => {
    p.movedFromOrgKey = rng.pick(occupierKeys.filter((k) => k !== p.orgKey));
    p.moveDate = i < 3 ? firstOfMonth(addDays(today, -rng.int(20, 120))) : firstOfMonth(edate(today, -rng.int(14, 48)));
  });
  // One person has opted out: suppressed everywhere.
  roster[17].suppressed = true;
  return roster;
}

export function buildPeople(ctx: GenContext, roster: PersonDef[]) {
  const rng = new Rng("people:rows");
  const persons: Row[] = [];
  const contacts: Row[] = [];
  const employment: Row[] = [];
  const edges: Row[] = [];
  const consents: Row[] = [];

  roster.forEach((p, i) => {
    const [first, last] = p.name.split(" ");
    persons.push({
      ...base("permitted_personal"),
      id: p.id,
      full_name: p.name,
      aliases: rng.chance(0.3) ? [`${first} ${last[0]}.`] : [],
      public_profile_url: null, // unknown — never invent profiles
      preferred_language: rng.pick(["en", "en", "en", "hinglish", "hi", "mr"]),
      preferred_channel: rng.chance(0.15) ? null : rng.pick(["email", "email", "phone", "whatsapp"]),
      contact_restrictions: p.suppressed ? "Opted out of outreach — do not contact (synthetic demo record)" : null,
      personal_notes: SYNTHETIC_NOTE,
    });

    // contact methods (fake, reserved): email at the org's example.com subdomain, +91-90000-1xxxx phones
    const handle = `${first}.${last}`.toLowerCase();
    if (!rng.chance(0.08)) {
      contacts.push({
        ...base("permitted_personal"), id: did("contact_method", `${p.key}:email`), person_id: p.id, method_type: "email",
        value: `${handle}@${orgDomain(p.orgKey)}`, verified_on: rng.chance(0.5) ? addDays(ctx.today, -rng.int(5, 400)) : null,
        preferred: true, suppressed: p.suppressed,
      });
    }
    if (rng.chance(0.7)) {
      const phone = `+91-90000-1${String(i + 1).padStart(4, "0")}`;
      contacts.push({
        ...base("permitted_personal"), id: did("contact_method", `${p.key}:phone`), person_id: p.id, method_type: "phone",
        value: phone, verified_on: rng.chance(0.4) ? addDays(ctx.today, -rng.int(5, 400)) : null, preferred: false, suppressed: p.suppressed,
      });
      if (rng.chance(0.4)) {
        contacts.push({
          ...base("permitted_personal"), id: did("contact_method", `${p.key}:whatsapp`), person_id: p.id, method_type: "whatsapp",
          value: phone, verified_on: null, preferred: false, suppressed: p.suppressed,
        });
      }
    }

    // employment: current (+ closed previous for movers)
    const start = p.moveDate ?? `${rng.int(2012, 2023)}-${String(rng.int(1, 12)).padStart(2, "0")}-01`;
    employment.push({
      ...base("permitted_personal"), id: p.employmentId, person_id: p.id, org_id: orgId(p.orgKey),
      title: p.title.title, function: p.title.fn, seniority: p.title.seniority,
      start_date: start, start_precision: p.moveDate ? "month" : rng.pick(["month", "year"]),
      end_date: null, end_precision: "unknown", is_current: true,
      fact_status: p.moveDate && p.moveDate > addDays(ctx.today, -120) ? "reported" : rng.pick(["currently_confirmed", "reported"]),
      source_object_id: ctx.sourceObjectId,
    });
    if (p.movedFromOrgKey && p.moveDate) {
      const prevEnd = addDays(p.moveDate, -1);
      employment.push({
        ...base("permitted_personal"), id: did("employment", `${p.key}:previous`), person_id: p.id, org_id: orgId(p.movedFromOrgKey),
        title: rng.pick(["Manager – Administration", "Senior Manager – Facilities", "AVP – Corporate Real Estate", "Finance Controller"]),
        function: "facilities", seniority: "manager",
        start_date: `${rng.int(2010, 2018)}-${String(rng.int(1, 12)).padStart(2, "0")}-01`, start_precision: "year",
        end_date: firstOfMonth(prevEnd), end_precision: "month", is_current: false,
        fact_status: "historical_observed", source_object_id: ctx.sourceObjectId,
      });
    }
  });

  // relationship edges: the demo owner (user) -> ~45 people
  const warmthPick = ["cold", "warm", "warm", "hot", "trusted"] as const;
  rng.sample(roster, 46).forEach((p, i) => {
    const warmth = rng.pick(warmthPick);
    edges.push({
      ...base("permitted_personal"), id: did("relationship_edge", `owner>${p.key}`),
      from_user_id: OWNER_USER_ID, from_person_id: null, to_person_id: p.id,
      edge_type: rng.pick(["client_of", "worked_with", "introduced_by", "met_at_event"]),
      warmth,
      strength_basis: warmth === "cold" ? "One exchange only" : rng.pick(["Closed a deal together", "Regular calls", "Met at industry event", "Former colleague of a client"]),
      intro_permission: i < 3, // explicitly recorded for three people only — never set automatically
      last_meaningful_contact: warmth === "cold" ? null : addDays(ctx.today, -rng.int(3, 300)),
      relationship_owner_user_id: OWNER_USER_ID, valid_from: null, valid_to: null,
    });
  });
  // person -> person: movers worked with someone at their former employer
  roster.filter((p) => p.movedFromOrgKey).forEach((p) => {
    const formerColleague = roster.find((q) => q.orgKey === p.movedFromOrgKey && q.key !== p.key);
    if (!formerColleague) return;
    edges.push({
      ...base("permitted_personal"), id: did("relationship_edge", `${p.key}>${formerColleague.key}`),
      from_user_id: null, from_person_id: p.id, to_person_id: formerColleague.id,
      edge_type: "worked_with", warmth: rng.pick(["warm", "hot"]), strength_basis: "Overlapping employment at former employer",
      intro_permission: false, last_meaningful_contact: null, relationship_owner_user_id: OWNER_USER_ID,
      valid_from: null, valid_to: p.moveDate,
    });
  });

  // consent / permission records (one suppressed)
  rng.sample(roster.filter((p) => !p.suppressed), 11).concat(roster.filter((p) => p.suppressed)).forEach((p) => {
    consents.push({
      ...base("permitted_personal"), id: did("consent_permission", p.key), person_id: p.id,
      source_label: p.suppressed ? "Reply to outreach email (demo)" : rng.pick(["Business card at demo event", "Inbound enquiry (demo)", "Referral (demo)"]),
      purpose: "property_advisory_outreach", channel: p.suppressed ? null : "email",
      legal_basis_as_advised: "Legitimate interest — B2B contact (as advised)",
      evidence: p.suppressed ? "Person asked not to be contacted again (synthetic)" : "Synthetic consent evidence for demo",
      expires_on: p.suppressed ? null : edate(ctx.today, 12),
      revoked_at: p.suppressed ? new Date(`${addDays(ctx.today, -21)}T05:30:00Z`).toISOString() : null,
      suppressed: p.suppressed,
    });
  });

  return { persons, contacts, employment, edges, consents };
}

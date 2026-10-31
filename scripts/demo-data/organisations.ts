/**
 * ~40 fictional organisations. Names are deliberately whimsical compounds so they cannot be mistaken
 * for real companies; every domain is a subdomain of example.com (RFC 2606 reserved).
 */
import { Rng, base, did, SYNTHETIC_NOTE, type Row } from "./core";

export type OrgRole = "occupier" | "parent" | "developer" | "operator" | "broker";
export interface OrgDef {
  key: string;
  name: string;
  sector: string;
  role: OrgRole;
  hq: string;
  gcc?: boolean;
  legalSuffix?: string | null; // null => legal name unknown
}

export const ORGS: OrgDef[] = [
  // IT services / product
  { key: "pebblewick", name: "Pebblewick Software", sector: "IT", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "marigold_loop", name: "Marigold Loop Technologies", sector: "IT", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  { key: "cobaltfern", name: "Cobaltfern Systems", sector: "IT", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "quokka_grid", name: "Quokka Grid Infotech", sector: "IT", role: "occupier", hq: "India", legalSuffix: null },
  { key: "tamarind_stack", name: "Tamarind Stack Labs", sector: "IT", role: "occupier", hq: "India", legalSuffix: "LLP" },
  { key: "velvetbyte", name: "Velvetbyte Digital", sector: "IT", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "lanternfish", name: "Lanternfish Analytics", sector: "IT", role: "occupier", hq: "India", legalSuffix: null },
  { key: "nilgiri_cloud", name: "Nilgiri Cloudworks", sector: "IT", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  // BFSI
  { key: "ironmonsoon", name: "Ironmonsoon Capital", sector: "BFSI", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  { key: "peacock_ridge", name: "Peacock Ridge Insurance", sector: "BFSI", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  { key: "rupeeleaf", name: "Rupeeleaf Finserv", sector: "BFSI", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  { key: "rupeeleaf_tech", name: "Rupeeleaf Tech Services", sector: "BFSI", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "kestrelbay", name: "Kestrelbay Payments", sector: "BFSI", role: "occupier", hq: "Singapore", legalSuffix: null },
  { key: "saffron_abacus", name: "Saffron Abacus Bank", sector: "BFSI", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  // Global parents + their India GCCs
  { key: "northwind_halberd", name: "Northwind Halberd Inc", sector: "Industrial tech", role: "parent", hq: "United States", legalSuffix: null },
  { key: "northwind_gcc", name: "Northwind Halberd GCC India", sector: "GCC", role: "occupier", hq: "United States", gcc: true, legalSuffix: "Pvt Ltd" },
  { key: "glasswing", name: "Glasswing Retail Corp", sector: "Retail", role: "parent", hq: "United States", legalSuffix: null },
  { key: "glasswing_gcc", name: "Glasswing Retail Technology Centre", sector: "GCC", role: "occupier", hq: "United States", gcc: true, legalSuffix: "Pvt Ltd" },
  { key: "orchard_lumen", name: "Orchard Lumen plc", sector: "BFSI", role: "parent", hq: "United Kingdom", legalSuffix: null },
  { key: "orchard_gcc", name: "Orchard Lumen Global Capability Centre", sector: "GCC", role: "occupier", hq: "United Kingdom", gcc: true, legalSuffix: "Pvt Ltd" },
  { key: "fjordline", name: "Fjordline Automotive AG", sector: "Automotive", role: "parent", hq: "Germany", legalSuffix: null },
  { key: "fjordline_gcc", name: "Fjordline Automotive Engineering Centre", sector: "GCC", role: "occupier", hq: "Germany", gcc: true, legalSuffix: "Pvt Ltd" },
  { key: "pebblewick_holdings", name: "Pebblewick Holdings", sector: "IT", role: "parent", hq: "India", legalSuffix: "Ltd" },
  // Pharma / life sciences
  { key: "banyan_helix", name: "Banyan Helix Pharma", sector: "Pharma", role: "occupier", hq: "India", legalSuffix: "Ltd" },
  { key: "cardamom_bio", name: "Cardamom Biosciences", sector: "Pharma", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "lotuscore", name: "Lotuscore Therapeutics", sector: "Pharma", role: "occupier", hq: "Switzerland", legalSuffix: null },
  // Engineering / industrial
  { key: "gearwell", name: "Gearwell Engineering Services", sector: "Engineering", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "tundra_forge", name: "Tundra Forge Engineering", sector: "Engineering", role: "occupier", hq: "Finland", legalSuffix: null },
  { key: "monsoonmill", name: "Monsoonmill Industrial Design", sector: "Engineering", role: "occupier", hq: "India", legalSuffix: "LLP" },
  { key: "pinecrest_freight", name: "Pinecrest Freight Logistics", sector: "Logistics", role: "occupier", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "ambergate", name: "Ambergate Consulting", sector: "Professional services", role: "occupier", hq: "India", legalSuffix: "LLP" },
  // Developers / landlords
  { key: "riverstone", name: "Riverstone Parklands Developers", sector: "Real estate", role: "developer", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "sahyadri_arc", name: "Sahyadri Arc Realty", sector: "Real estate", role: "developer", hq: "India", legalSuffix: "Ltd" },
  { key: "kalpavriksha", name: "Kalpavriksha Estates", sector: "Real estate", role: "developer", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "bluecairn", name: "Bluecairn Office Trust", sector: "Real estate", role: "developer", hq: "India", legalSuffix: null },
  { key: "tarangan", name: "Tarangan Infra Developers", sector: "Real estate", role: "developer", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "westgate_spire", name: "Westgate Spire Properties", sector: "Real estate", role: "developer", hq: "India", legalSuffix: "Pvt Ltd" },
  // Flex operators / other brokers
  { key: "hexacove", name: "Hexacove Flexspaces", sector: "Flex workspace", role: "operator", hq: "India", legalSuffix: "Pvt Ltd" },
  { key: "lilypad", name: "Lilypad Cowork", sector: "Flex workspace", role: "operator", hq: "India", legalSuffix: null },
  { key: "meridian_ashlar", name: "Meridian Ashlar Advisors", sector: "Real estate services", role: "broker", hq: "India", legalSuffix: "Pvt Ltd" },
];

export const orgId = (key: string) => did("organisation", key);
export const orgByKey = (key: string) => {
  const o = ORGS.find((x) => x.key === key);
  if (!o) throw new Error(`unknown org ${key}`);
  return o;
};
export const orgDomain = (key: string) => `${key.replace(/_/g, "-")}.example.com`;
export const OCCUPIERS = ORGS.filter((o) => o.role === "occupier");
export const DEVELOPERS = ORGS.filter((o) => o.role === "developer");

const RELATIONS: Array<[string, string, string]> = [
  // [from, to, relation_type]
  ["northwind_halberd", "northwind_gcc", "parent_of"],
  ["glasswing", "glasswing_gcc", "parent_of"],
  ["orchard_lumen", "orchard_gcc", "parent_of"],
  ["fjordline", "fjordline_gcc", "parent_of"],
  ["pebblewick_holdings", "pebblewick", "parent_of"],
  ["rupeeleaf_tech", "rupeeleaf", "subsidiary_of"],
  ["bluecairn", "riverstone", "affiliate"],
  ["hexacove", "tarangan", "affiliate"],
];

export function buildOrganisations(): { organisations: Row[]; relations: Row[] } {
  const rng = new Rng("organisations");
  const organisations = ORGS.map((o) => {
    const big = o.role === "parent" || o.gcc;
    const hcKnown = o.role !== "developer" && rng.chance(0.8);
    const hcMin = big ? rng.step(1500, 6000, 500) : rng.step(150, 2500, 50);
    return {
      ...base(),
      id: orgId(o.key),
      display_name: o.name,
      legal_name: o.legalSuffix ? `${o.name} ${o.legalSuffix}` : null,
      domain: orgDomain(o.key),
      cin: null, // unknown — never invent registry identifiers
      gstin: null,
      sector: o.sector,
      hq_country: o.hq,
      headcount_min: hcKnown ? hcMin : null,
      headcount_max: hcKnown ? Math.round(hcMin * rng.float(1.3, 2.2)) : null,
      is_gcc: o.gcc ? true : o.role === "occupier" && rng.chance(0.2) ? null : false,
      source_confidence: "synthetic_demo",
      crm_external_id: null,
      account_owner_note: SYNTHETIC_NOTE,
      contact_restrictions: null,
    };
  });
  const relations = RELATIONS.map(([from, to, type]) => ({
    ...base(),
    id: did("organisation_relation", `${from}>${to}`),
    from_org_id: orgId(from),
    to_org_id: orgId(to),
    relation_type: type,
    valid_from: type === "parent_of" || type === "subsidiary_of" ? `${rng.int(2008, 2021)}-04-01` : null,
    valid_to: null,
  }));
  return { organisations, relations };
}

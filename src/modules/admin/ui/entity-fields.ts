import type { EntityTable } from "../entities";

export interface FieldDef {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "textarea" | "select" | "url";
  options?: [string, string][];
  required?: boolean;
  hint?: string;
  /** Changes to this field need approval (mirrors MATERIAL_FIELDS in services/changes). */
  material?: boolean;
}

const CLASSIFICATION: FieldDef = {
  name: "classification", label: "Classification", type: "select",
  options: [["public", "Public"], ["permitted_personal", "Permitted personal"], ["corporate_confidential", "Corporate confidential"], ["licensed_restricted", "Licensed restricted"]],
  hint: "Who may see this record. Licensed-restricted data is hidden from members without that allowance.",
};

export const ENTITY_FIELDS: Record<EntityTable, FieldDef[]> = {
  organisation: [
    { name: "display_name", label: "Display name", required: true },
    { name: "legal_name", label: "Legal name", material: true },
    { name: "domain", label: "Website domain", material: true, hint: "e.g. example.com" },
    { name: "cin", label: "CIN", material: true },
    { name: "gstin", label: "GSTIN", material: true },
    { name: "sector", label: "Sector" },
    { name: "hq_country", label: "HQ country" },
    { name: "headcount_min", label: "Headcount (min)", type: "number", hint: "Leave blank if unknown — never 0." },
    { name: "headcount_max", label: "Headcount (max)", type: "number" },
    { name: "is_gcc", label: "Global capability centre?", type: "select", options: [["", "Unknown"], ["true", "Yes"], ["false", "No"]] },
    { name: "crm_external_id", label: "CRM account id", material: true, hint: "The official CRM owns account ownership." },
    { name: "account_owner_note", label: "Account owner note", type: "textarea" },
    { name: "contact_restrictions", label: "Contact restrictions", type: "textarea", hint: "e.g. 'Do not approach — existing landlord mandate'." },
    CLASSIFICATION,
  ],
  person: [
    { name: "full_name", label: "Full name", required: true, material: true },
    { name: "aliases", label: "Other names / spellings", hint: "Comma separated." },
    { name: "public_profile_url", label: "Public profile URL", type: "url" },
    { name: "preferred_language", label: "Preferred language", type: "select", options: [["", "Unknown"], ["en", "English"], ["hi", "Hindi"], ["hinglish", "Hinglish"], ["mr", "Marathi"]] },
    { name: "preferred_channel", label: "Preferred channel", type: "select", options: [["", "Unknown"], ["email", "Email"], ["phone", "Phone"], ["whatsapp", "WhatsApp"], ["linkedin", "LinkedIn"], ["in_person", "In person"]] },
    { name: "contact_restrictions", label: "Contact restrictions", type: "textarea" },
    { name: "personal_notes", label: "Notes", type: "textarea", hint: "Only what the person volunteered and is appropriate to keep. No sensitive profiling." },
    CLASSIFICATION,
  ],
  asset: [
    { name: "name", label: "Name", required: true },
    { name: "asset_kind", label: "Kind", type: "select", options: [["building", "Building"], ["tower", "Tower"], ["campus", "Campus"], ["project", "Project"]],
      hint: "Towers in one campus stay separate records — never collapse them." },
    { name: "parent_asset_id", label: "Part of campus / project", type: "select" },
    { name: "address", label: "Address", type: "textarea" },
    { name: "status", label: "Status (source wording)", hint: "e.g. ready, under construction, planned" },
    { name: "grade", label: "Grade" },
    { name: "total_area_sf", label: "Total area (sf)", type: "number", hint: "Blank = unknown." },
    { name: "floors", label: "Floors", type: "number" },
    { name: "floor_size_text", label: "Floor plate (as stated)" },
    { name: "completion_date", label: "Completion date", type: "date" },
    { name: "completion_precision", label: "Completion date precision", type: "select", options: [["unknown", "Unknown"], ["day", "Day"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"]] },
    { name: "lat", label: "Latitude", type: "number" },
    { name: "lon", label: "Longitude", type: "number" },
    CLASSIFICATION,
  ],
};

export const ENTITY_ROUTE: Record<EntityTable, string> = { organisation: "/companies", person: "/people", asset: "/buildings" };
export const ENTITY_LABEL: Record<EntityTable, string> = { organisation: "company", person: "person", asset: "building" };

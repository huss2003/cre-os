/** Document model shared by the PPTX / DOCX / XLSX builders. Everything here is already-computed data (S5). */
import type { FinanceResult } from "../finance/types";
import type { ComparisonRow } from "../finance/engine";
import type { MapModel } from "./visuals";

export interface Brand {
  name: string;               // tenant/brand display name (from template_asset / workspace) — never hardcoded
  primary: string;            // hex without '#'
  accent: string;
  font: string;
  headingFont?: string | null;
  disclaimer?: string | null;
  /** Logo extracted from the uploaded master template (base64, no data: prefix). */
  logo?: { data: string; type: "png" | "jpg" | "gif"; width: number; height: number } | null;
}
export const DEFAULT_BRAND: Brand = { name: "CRE OS", primary: "1F3A5F", accent: "C8102E", font: "Calibri", disclaimer: null };

/**
 * Brand precedence: explicit brand_json values (admin settings) > theme extracted from the uploaded master file >
 * built-in defaults. `theme` comes from documents/theme.ts.
 */
export function brandFrom(json: Record<string, unknown> | null | undefined, fallbackName: string, theme?: Partial<Pick<Brand, "primary" | "accent" | "font" | "headingFont" | "logo">> | null): Brand {
  const hex = (v: unknown, d: string) => (typeof v === "string" && /^#?[0-9a-fA-F]{6}$/.test(v) ? v.replace("#", "").toUpperCase() : d);
  return {
    name: typeof json?.name === "string" && json.name ? json.name : fallbackName,
    primary: hex(json?.primary, theme?.primary ?? DEFAULT_BRAND.primary),
    accent: hex(json?.accent, theme?.accent ?? DEFAULT_BRAND.accent),
    font: typeof json?.font === "string" && json.font ? json.font : theme?.font ?? DEFAULT_BRAND.font,
    headingFont: typeof json?.heading_font === "string" && json.heading_font ? json.heading_font : theme?.headingFont ?? null,
    disclaimer: typeof json?.disclaimer === "string" ? json.disclaimer : null,
    logo: theme?.logo ?? null,
  };
}

export interface OptionLine {
  rank: number; label: string; eligibility: string; fitScore: number | null; completenessScore: number | null;
  area: string; cost: string; availability: string; flags: string[]; disqualifiers: string[]; verification: string[];
  /** Numeric values for charts (space snapshot area, all-in cost per unit); null = unknown, never 0. */
  areaSf?: number | null; costPerUnit?: number | null;
  lat?: number | null; lon?: number | null; locality?: string | null;
}

export interface RequirementTargets {
  areaMinSf: number | null; areaTargetSf: number | null; areaMaxSf: number | null; areaBasis: string | null;
  budgetMin: number | null; budgetMax: number | null; budgetBasis: string | null;
}

/** Market note inputs (approved/stored facts only, each with its as-of date and fact status). */
export interface MarketSection {
  geographies: string[];
  availabilitySummary: { status: string; count: number }[];
  askingRent: { min: number | null; max: number | null; basis: string | null; observations: number; asOfRange: string | null };
  observations: { metric: string; geography: string; period: string; value: string; unit: string; source: string }[];
}

export interface DocModel {
  purpose: "shortlist_deck" | "proposal" | "market_note" | "comparison_xlsx";
  title: string;
  clientName: string;
  preparedFor?: string | null;
  generatedAt: string;          // ISO
  brand: Brand;
  template: { id: string | null; version: number | null; name: string };
  requirement?: { title: string; status: string; lines: [string, string][]; missing: string[] } | null;
  options: OptionLine[];
  scenarios: FinanceResult[];
  /** Annual discount rate (percent) per scenario output hash — the workbook recomputes r_m from it. */
  annualRatePct: Record<string, string>;
  comparison: ComparisonRow[];
  assumptions: string[];
  freshness: string[];          // dated data-freshness statements
  notes?: string[];
  watermark: string;            // "Confidential — prepared for …"
  /** Source data and calculation versions used (requirement/shortlist/availability/quotes/scenarios/template). */
  sources?: string[];
  targets?: RequirementTargets | null;
  map?: MapModel | null;
  /** What the uploaded master template contributed (and what it did not). */
  templateCarryOver?: string[];
  market?: MarketSection | null;
  version?: { no: number; familyId: string | null; parentId: string | null } | null;
}

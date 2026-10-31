/** Document model shared by the PPTX / DOCX / XLSX builders. Everything here is already-computed data (S5). */
import type { FinanceResult } from "../finance/types";
import type { ComparisonRow } from "../finance/engine";

export interface Brand {
  name: string;               // tenant/brand display name (from template_asset / workspace) — never hardcoded
  primary: string;            // hex without '#'
  accent: string;
  font: string;
  disclaimer?: string | null;
}
export const DEFAULT_BRAND: Brand = { name: "CRE OS", primary: "1F3A5F", accent: "C8102E", font: "Calibri", disclaimer: null };

export function brandFrom(json: Record<string, unknown> | null | undefined, fallbackName: string): Brand {
  const hex = (v: unknown, d: string) => (typeof v === "string" && /^#?[0-9a-fA-F]{6}$/.test(v) ? v.replace("#", "").toUpperCase() : d);
  return {
    name: typeof json?.name === "string" && json.name ? json.name : fallbackName,
    primary: hex(json?.primary, DEFAULT_BRAND.primary),
    accent: hex(json?.accent, DEFAULT_BRAND.accent),
    font: typeof json?.font === "string" && json.font ? json.font : DEFAULT_BRAND.font,
    disclaimer: typeof json?.disclaimer === "string" ? json.disclaimer : null,
  };
}

export interface OptionLine {
  rank: number; label: string; eligibility: string; fitScore: number | null; completenessScore: number | null;
  area: string; cost: string; availability: string; flags: string[]; disqualifiers: string[]; verification: string[];
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
}

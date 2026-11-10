import type { PropertyRating } from "@/modules/toolkit/calc/rating";

export const COMPARE_STEPS = ["Pick the requirement", "Add buildings", "Review the ranking", "Use in a client document"];

/** One plain sentence per building that did not win, built only from computed results. */
export function whyLost(p: PropertyRating, best: PropertyRating | undefined): string {
  if (p.eligibility === "not_eligible") {
    const r = p.rules.find((x) => x.outcome === "fail");
    return `${p.name} is not eligible: fails “${r?.label ?? "a mandatory rule"}”${r ? ` (${r.detail})` : ""}.`;
  }
  if (p.eligibility === "unconfirmed") {
    const r = p.rules.find((x) => x.outcome === "unknown" && x.kind === "mandatory");
    return `${p.name} cannot be confirmed yet: ${r ? `“${r.label}” — ${r.detail}` : "mandatory data is missing"}.`;
  }
  if (p.score === null) return `${p.name} has no score — not enough data.`;
  if (best?.score != null) return `${p.name} scored ${p.score} out of 100, below ${best.name}'s ${best.score}.`;
  return `${p.name} scored ${p.score} out of 100.`;
}

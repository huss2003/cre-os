import type { NegotiationAnalysis } from "./calc/negotiation";

/**
 * Diff-based negotiation talking points (AI policy "off" path for toolkit.negotiation_points). Pure. Every number is
 * copied from the calculator output (S5); nothing is accepted, rejected or recommended beyond the computed strategy.
 */
export function codeTalkingPoints(a: Pick<NegotiationAnalysis, "diffs" | "strategy" | "packages" | "offers">): string[] {
  const pts: string[] = [];
  const last = a.diffs[a.diffs.length - 1];
  if (last && last.from !== null) {
    const fromLabel = a.offers.find((o) => o.no === last.from)?.label ?? `Offer ${last.from}`;
    const toLabel = a.offers.find((o) => o.no === last.to)?.label ?? `Offer ${last.to}`;
    const improved = last.terms.filter((t) => t.status === "improved");
    const worse = last.terms.filter((t) => t.status === "worse");
    if (improved.length) pts.push(`Acknowledge the movement in ${toLabel}: ${improved.slice(0, 3).map((t) => `${t.label} ${t.previous ?? "—"} → ${t.current ?? "—"}`).join("; ")}.`);
    if (worse.length) pts.push(`Push back — ${toLabel} is weaker than ${fromLabel} on ${worse.slice(0, 3).map((t) => `${t.label} (${t.previous ?? "—"} → ${t.current ?? "—"})`).join(", ")}.`);
    if (last.financial) {
      const f = last.financial;
      pts.push(f.better === "equal" ? `Overall cost is unchanged between ${fromLabel} and ${toLabel} (NPV change ${f.npvChange}).`
        : `On the computed numbers ${f.better === "to" ? toLabel : fromLabel} is better for the occupier: NPV change ${f.npvChange}, nominal change ${f.nominalChange}.`);
    }
  }
  pts.push(`Ask for: ${a.strategy.preferredOutcome}`);
  if (a.strategy.acceptableAlternative) pts.push(`Fallback if needed: ${a.strategy.acceptableAlternative}`);
  const bestPkg = [...a.packages].filter((p) => p.npvValue !== null).sort((x, y) => Number(y.npvValue) - Number(x.npvValue))[0];
  if (bestPkg) pts.push(`Highest-value concession package on the numbers: ${bestPkg.name} (NPV value ${bestPkg.npvValue}).`);
  for (const u of a.strategy.unresolved.slice(0, 2)) pts.push(`Still to agree: ${u}`);
  for (const r of a.strategy.risks.slice(0, 2)) pts.push(`Watch: ${r}`);
  return [...new Set(pts)].slice(0, 8);
}

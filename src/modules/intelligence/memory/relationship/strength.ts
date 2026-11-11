/**
 * Relationship strength (spec §4.2) — pure, deterministic, explained.
 * Frequency is deliberately capped (max 10/100): frequent contact alone never makes a relationship "strong".
 * Without any trust signal (meetings, replies, voluntary information, introductions, kept commitments, past wins)
 * the level is capped at "weak" and the explanation says so.
 */
export interface RelationshipEvidence {
  interactions: number;
  meaningful: number;
  firstAt: string | null;
  lastAt: string | null;
  meetings: number;
  outbound: number;
  inbound: number;
  /** Inbound, meaningful interactions — they told us something without being chased. */
  voluntaryInfo: number;
  /** Introductions this person made / permitted (relationship_edge). */
  introductions: number;
  /** Won opportunities where this person was a stakeholder. */
  wins: number;
  commitmentsKept: number;
  commitmentsOverdue: number;
  /** User's own assessment (contact_relationship_level), shown but not scored. */
  userLevel: string | null;
  today: string; // YYYY-MM-DD
}

export type RelationshipLevel = "unknown" | "none" | "weak" | "developing" | "good" | "strong";
export interface RelationshipFactor { key: string; label: string; points: number; max: number; note: string }
export interface RelationshipAssessment { level: RelationshipLevel; score: number | null; factors: RelationshipFactor[]; explanation: string[]; caveats: string[] }

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a.slice(0, 10))) / 86_400_000);

export function relationshipStrength(e: RelationshipEvidence | null): RelationshipAssessment {
  if (!e) return { level: "unknown", score: null, factors: [], explanation: ["No relationship data could be loaded."], caveats: ["Unknown — not assessed."] };
  if (e.interactions === 0 && e.meetings === 0 && e.introductions === 0 && e.wins === 0) {
    return { level: "none", score: 0, factors: [], explanation: ["No recorded interactions, meetings or introductions with this contact."],
      caveats: e.userLevel ? [`Your own assessment says "${e.userLevel}" — not backed by recorded interactions.`] : [] };
  }
  const f: RelationshipFactor[] = [];
  const add = (key: string, label: string, points: number, max: number, note: string) => f.push({ key, label, points: Math.max(0, Math.min(max, Math.round(points))), max, note });

  add("frequency", "How often you talk", e.interactions * 2, 10, `${e.interactions} recorded interaction(s). Counts for little on its own.`);
  const ago = e.lastAt ? days(e.lastAt, e.today) : null;
  add("recency", "How recently", ago === null ? 0 : ago <= 30 ? 15 : ago <= 90 ? 10 : ago <= 180 ? 5 : 0, 15, ago === null ? "Last contact date unknown." : `Last contact ${ago} day(s) ago.`);
  add("meetings", "Meetings held", e.meetings * 5, 15, `${e.meetings} meeting(s) or visit(s).`);
  const ratio = e.outbound ? e.inbound / e.outbound : null;
  add("responsiveness", "Replies / reaches out", ratio === null ? (e.inbound ? 8 : 0) : ratio >= 0.5 ? 15 : ratio >= 0.2 ? 8 : 0, 15,
    ratio === null ? (e.inbound ? `${e.inbound} message(s) from them; none from you recorded.` : "No outbound messages recorded — responsiveness unknown.") : `${e.inbound} from them vs ${e.outbound} from you.`);
  add("voluntary", "Shares information unprompted", e.voluntaryInfo * 5, 10, `${e.voluntaryInfo} meaningful message(s) they started.`);
  add("introductions", "Introduced other people", e.introductions * 15, 15, e.introductions ? `${e.introductions} introduction(s) recorded.` : "No introductions recorded.");
  add("collaboration", "Past successful work", e.wins ? 10 : 0, 10, e.wins ? `${e.wins} won deal(s) together.` : "No completed deal together recorded.");
  const tracked = e.commitmentsKept + e.commitmentsOverdue;
  add("commitments", "Commitments kept", tracked ? (e.commitmentsKept / tracked) * 10 : 0, 10, tracked ? `${e.commitmentsKept} kept, ${e.commitmentsOverdue} overdue.` : "No commitments tracked.");

  const score = f.reduce((a, x) => a + x.points, 0);
  const trust = f.filter((x) => !["frequency", "recency"].includes(x.key)).reduce((a, x) => a + x.points, 0);
  let level: RelationshipLevel = score < 25 ? "weak" : score < 50 ? "developing" : score < 75 ? "good" : "strong";
  const caveats: string[] = [];
  if (trust === 0 && level !== "weak") { level = "weak"; caveats.push("Frequent or recent contact, but no sign of trust yet (no meetings, replies, introductions or kept commitments) — rated weak."); }
  if (e.userLevel) caveats.push(`Your own assessment: "${e.userLevel}" (shown, not scored).`);
  if (ago !== null && ago > 180) caveats.push("No contact for over 6 months — the relationship may have gone cold.");
  const strongest = [...f].filter((x) => x.points > 0).sort((a, b) => b.points / b.max - a.points / a.max).slice(0, 3).map((x) => x.label.toLowerCase());
  const missing = f.filter((x) => x.points === 0).map((x) => x.label.toLowerCase());
  const explanation = [
    `Rated ${level} (${score}/100) from recorded evidence only.`,
    strongest.length ? `Strongest evidence: ${strongest.join(", ")}.` : "No strong evidence yet.",
    missing.length ? `No evidence of: ${missing.join(", ")}.` : "Evidence found for every factor.",
  ];
  return { level, score, factors: f, explanation, caveats };
}

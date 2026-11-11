import type { TutorialVideo } from "./videos";

/** Topic order on /tutorials. Unknown categories from the manifest are appended after these. */
export const TOPICS = [
  "Start here", "Records & data", "Signals, scores & contacts", "Outreach & meetings",
  "Deal toolkit", "Ask AI & automation", "Review & settings",
] as const;

export const LOCAL_BASE = "/tutorials/videos";
export const localVideoSrc = (slug: string) => `${LOCAL_BASE}/${slug}.mp4`;
export const localPosterSrc = (slug: string) => `${LOCAL_BASE}/${slug}.jpg`;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Topics present in `videos`, in canonical order. */
export function topicsOf(videos: TutorialVideo[]): string[] {
  const present = new Set(videos.map((v) => v.category || "Other"));
  const known = TOPICS.filter((t) => present.has(t)) as string[];
  return [...known, ...[...present].filter((t) => !known.includes(t))];
}

/** Return the topic exactly as named in the catalogue (case-insensitive match), or "" if unknown/blank. */
export function resolveTopic(videos: TutorialVideo[], topic: string | null | undefined): string {
  if (!topic) return "";
  const t = norm(topic);
  return topicsOf(videos).find((x) => norm(x) === t) ?? "";
}

/** True when every word of `q` appears in the title, learn line or a step caption. */
export function matches(v: TutorialVideo, q: string): boolean {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = norm([v.title, v.learn, v.category, ...v.steps.map((s) => s.caption)].join(" "));
  return words.every((w) => hay.includes(w));
}

/** Filter by topic + search; title hits rank above learn/step-only hits, otherwise manifest order is kept. */
export function filterVideos(videos: TutorialVideo[], opts: { topic?: string; q?: string }): TutorialVideo[] {
  const topic = resolveTopic(videos, opts.topic);
  const q = opts.q?.trim() ?? "";
  const out = videos.filter((v) => (!topic || (v.category || "Other") === topic) && matches(v, q));
  if (!q) return out;
  const words = norm(q).split(" ").filter(Boolean);
  const inTitle = (v: TutorialVideo) => words.every((w) => norm(v.title).includes(w));
  return [...out.filter(inTitle), ...out.filter((v) => !inTitle(v))];
}

/** Count of videos per topic for the search text (ignores the topic filter, so chips show what each topic would give). */
export function countByTopic(videos: TutorialVideo[], q = ""): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of topicsOf(videos)) counts[t] = 0;
  for (const v of videos) if (matches(v, q)) counts[v.category || "Other"] += 1;
  return counts;
}

export function groupByTopic(videos: TutorialVideo[]): { topic: string; videos: TutorialVideo[] }[] {
  return topicsOf(videos)
    .map((topic) => ({ topic, videos: videos.filter((v) => (v.category || "Other") === topic) }))
    .filter((g) => g.videos.length);
}

/** Previous/next video inside the same topic (no wrap-around). */
export function neighbours(videos: TutorialVideo[], slug: string) {
  const v = videos.find((x) => x.slug === slug);
  if (!v) return { prev: undefined, next: undefined };
  const same = videos.filter((x) => (x.category || "Other") === (v.category || "Other"));
  const i = same.findIndex((x) => x.slug === slug);
  return { prev: same[i - 1], next: same[i + 1] };
}

/** Shareable /tutorials URL for a topic + query. */
export function tutorialsHref(topic?: string, q?: string) {
  const p = new URLSearchParams();
  if (topic) p.set("topic", topic);
  if (q?.trim()) p.set("q", q.trim());
  const s = p.toString();
  return s ? `/tutorials?${s}#watch` : "/tutorials#watch";
}

export const WATCHED_KEY = "creos.tutorials.watched";
export function readWatched(): Set<string> {
  try { const raw = window.localStorage.getItem(WATCHED_KEY); const a = raw ? JSON.parse(raw) : []; return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []); }
  catch { return new Set(); }
}
export function markWatched(slug: string) {
  try { const s = readWatched(); s.add(slug); window.localStorage.setItem(WATCHED_KEY, JSON.stringify([...s])); } catch { /* storage unavailable */ }
}

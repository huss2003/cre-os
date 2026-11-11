"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { EmptyState } from "@/components/ui";
import { VIDEOS, fmtDuration, type TutorialVideo } from "./videos";
import { countByTopic, filterVideos, groupByTopic, readWatched, resolveTopic, topicsOf } from "./catalog";
import { Poster } from "./poster";

const FLOW = ["Capture & signals", "Review", "Records", "Act from Today, Outreach, Meetings, Toolkit or Ask AI"];

/** "Watch" section on /tutorials: featured start video, topic chips + search (synced to ?topic=&q=), grouped cards. */
export function WatchSection({ initialTopic = "", initialQ = "" }: { initialTopic?: string; initialQ?: string }) {
  const [topic, setTopic] = useState(resolveTopic(VIDEOS, initialTopic));
  const [q, setQ] = useState(initialQ);
  const [watched, setWatched] = useState<Set<string>>(new Set());
  useEffect(() => { setWatched(readWatched()); }, []);

  // Keep the URL shareable without a navigation/re-render of the server page.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (topic) url.searchParams.set("topic", topic); else url.searchParams.delete("topic");
    if (q.trim()) url.searchParams.set("q", q.trim()); else url.searchParams.delete("q");
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [topic, q]);

  const topics = useMemo(() => topicsOf(VIDEOS), []);
  const counts = useMemo(() => countByTopic(VIDEOS, q), [q]);
  const results = useMemo(() => filterVideos(VIDEOS, { topic, q }), [topic, q]);
  if (!VIDEOS.length) return null;

  const featured = VIDEOS.find((v) => v.featured) ?? VIDEOS[0];
  const filtering = !!topic || !!q.trim();
  const watchedCount = VIDEOS.filter((v) => watched.has(v.slug)).length;

  return (
    <section id="watch" aria-labelledby="watch-h" className="space-y-5 scroll-mt-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="watch-h" className="text-lg font-semibold tracking-tight">Watch</h2>
          <p className="mt-0.5 text-sm text-ink-soft">{VIDEOS.length} short videos recorded in the real app. Pick the task you want to learn.</p>
        </div>
        {watchedCount ? <p className="text-xs text-ink-soft">{watchedCount} of {VIDEOS.length} watched</p> : null}
      </div>

      {!filtering ? (
        <Link href={`/tutorials/videos/${featured.slug}`}
          className="group grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Poster slug={featured.slug} seconds={featured.seconds} large watched={watched.has(featured.slug)} />
          <div className="flex flex-col justify-center gap-2 p-5">
            <span className="self-start rounded-md bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">Start here</span>
            <h3 className="text-xl font-semibold tracking-tight">{featured.title}</h3>
            <p className="text-sm text-ink-soft">{featured.learn}</p>
            <ol aria-label="How the app flows" className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink">
              {FLOW.map((f, i) => (
                <li key={f} className="flex items-center gap-1">
                  {i ? <span aria-hidden className="text-ink-soft">→</span> : null}
                  <span className="rounded border border-line bg-canvas px-1.5 py-0.5">{f}</span>
                </li>
              ))}
            </ol>
            <span className="mt-2 inline-flex self-start rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white group-hover:bg-brand-strong">Watch · {fmtDuration(featured.seconds)}</span>
          </div>
        </Link>
      ) : null}

      <div className="space-y-3">
        <label className="block">
          <span className="sr-only">Search tutorials</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="What do you want to do? e.g. import, draft email, lease date"
            className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm shadow-sm placeholder:text-ink-soft focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 sm:h-10" />
        </label>
        <div role="group" aria-label="Filter by topic" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
          <Chip active={!topic} onClick={() => setTopic("")} label="All" count={q.trim() ? Object.values(counts).reduce((a, b) => a + b, 0) : VIDEOS.length} />
          {topics.map((t) => <Chip key={t} active={topic === t} onClick={() => setTopic(topic === t ? "" : t)} label={t} count={counts[t] ?? 0} />)}
        </div>
      </div>

      {results.length === 0 ? (
        <EmptyState title="No videos match">
          <p>Try a shorter word (e.g. “lease”, “draft”, “import”) or another topic.</p>
          <button type="button" onClick={() => { setQ(""); setTopic(""); }} className="mt-3 inline-flex min-h-11 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas sm:min-h-8">Clear filters</button>
        </EmptyState>
      ) : filtering ? (
        <div aria-live="polite">
          <p className="mb-2 text-xs text-ink-soft">{results.length} video{results.length === 1 ? "" : "s"}{topic ? ` in ${topic}` : ""}{q.trim() ? ` for “${q.trim()}”` : ""}</p>
          <Grid videos={results} watched={watched} />
        </div>
      ) : (
        groupByTopic(VIDEOS.filter((v) => v.slug !== featured.slug)).map((g) => (
          <section key={g.topic} aria-labelledby={`t-${slugify(g.topic)}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1.5">
              <h3 id={`t-${slugify(g.topic)}`} className="text-sm font-semibold">{g.topic} <span className="font-normal text-ink-soft">· {g.videos.length}</span></h3>
              <button type="button" onClick={() => setTopic(g.topic)} className="min-h-11 text-xs font-medium text-brand hover:underline sm:min-h-0">Only this topic</button>
            </div>
            <Grid videos={g.videos} watched={watched} />
          </section>
        ))
      )}
    </section>
  );
}

function Chip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={clsx("inline-flex min-h-11 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition-colors sm:min-h-8",
        active ? "border-brand bg-brand-soft font-medium text-brand" : "border-line bg-surface text-ink hover:bg-canvas",
        count === 0 && !active && "opacity-60")}>
      {label}<span className={clsx("text-xs tabular-nums", active ? "text-brand" : "text-ink-soft")}>{count}</span>
    </button>
  );
}

function Grid({ videos, watched }: { videos: TutorialVideo[]; watched: Set<string> }) {
  return (
    <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {videos.map((v) => (
        <li key={v.slug}>
          <Link href={`/tutorials/videos/${v.slug}`}
            className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-sm transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <Poster slug={v.slug} seconds={v.seconds} watched={watched.has(v.slug)} />
            <div className="flex flex-1 flex-col gap-0.5 p-3">
              <h4 className="text-sm font-semibold leading-snug">{v.title}</h4>
              <p className="line-clamp-1 text-xs text-ink-soft">{v.learn}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

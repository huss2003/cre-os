import Link from "next/link";
import { VIDEOS, fmtDuration, posterSrc, type TutorialVideo } from "./videos";

/** "Watch" section at the top of /tutorials: the featured start-here video, then a grid of the others. */
export function WatchSection() {
  if (!VIDEOS.length) return null;
  const featured = VIDEOS.find((v) => v.featured) ?? VIDEOS[0];
  const rest = VIDEOS.filter((v) => v.slug !== featured.slug);
  return (
    <section aria-labelledby="watch-h" className="space-y-4">
      <div>
        <h2 id="watch-h" className="text-lg font-semibold tracking-tight">Watch</h2>
        <p className="mt-0.5 text-sm text-ink-soft">Short videos recorded in the real app. Each shows one task, step by step, in plain words.</p>
      </div>
      <Link href={`/tutorials/videos/${featured.slug}`}
        className="group grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition hover:border-brand/40 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Poster v={featured} large />
        <div className="flex flex-col justify-center gap-2 p-5">
          <span className="self-start rounded-md bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">Start here</span>
          <h3 className="text-xl font-semibold tracking-tight">{featured.title}</h3>
          <p className="text-sm text-ink-soft">{featured.learn}</p>
          <p className="text-xs text-ink-soft">{fmtDuration(featured.seconds)} · {featured.steps.length} steps</p>
          <span className="mt-1 inline-flex self-start rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white group-hover:bg-brand-strong">Watch</span>
        </div>
      </Link>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((v) => (
          <li key={v.slug}>
            <Link href={`/tutorials/videos/${v.slug}`} className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition hover:border-brand/40">
              <Poster v={v} />
              <div className="flex flex-1 flex-col gap-1 p-4">
                <h3 className="font-semibold leading-snug">{v.title}</h3>
                <p className="line-clamp-2 flex-1 text-sm text-ink-soft">{v.learn}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Poster({ v, large }: { v: TutorialVideo; large?: boolean }) {
  return (
    <div className="relative aspect-[16/10] bg-canvas">
      {/* eslint-disable-next-line @next/next/no-img-element -- static poster from /public */}
      <img src={posterSrc(v.slug)} alt="" loading={large ? "eager" : "lazy"} className="h-full w-full object-cover" />
      <span aria-hidden className="absolute inset-0 grid place-items-center">
        <span className={`grid place-items-center rounded-full bg-ink/75 text-white shadow-lg ${large ? "h-16 w-16" : "h-11 w-11"}`}>
          <svg viewBox="0 0 24 24" className={large ? "h-7 w-7" : "h-5 w-5"} fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
        </span>
      </span>
      <span className="absolute bottom-2 right-2 rounded bg-ink/80 px-1.5 py-0.5 text-xs font-medium text-white">{fmtDuration(v.seconds)}</span>
    </div>
  );
}

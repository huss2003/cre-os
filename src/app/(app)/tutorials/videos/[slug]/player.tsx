"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { markWatched } from "../../catalog";

type Step = { caption: string; ms: number };

/**
 * Native video player + clickable step list (seeks to each step's start). Never autoplays.
 * If the Storage URL fails, switches once to the bundled /public copy. Marks the video watched at 80% or on end.
 */
export function VideoPlayer({ slug, src, poster, fallbackSrc, fallbackPoster, title, steps }:
  { slug: string; src: string; poster: string; fallbackSrc: string; fallbackPoster: string; title: string; steps: Step[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(-1);
  const [source, setSource] = useState({ src, poster, fellBack: false });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let done = false;
    const onTime = () => {
      const ms = v.currentTime * 1000;
      let i = -1;
      steps.forEach((s, k) => { if (ms >= s.ms) i = k; });
      setActive(i);
      if (!done && v.duration && v.currentTime / v.duration >= 0.8) { done = true; markWatched(slug); }
    };
    const onEnded = () => markWatched(slug);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    return () => { v.removeEventListener("timeupdate", onTime); v.removeEventListener("ended", onEnded); };
  }, [steps, slug]);

  const onError = () => {
    if (!source.fellBack) setSource({ src: fallbackSrc, poster: fallbackPoster, fellBack: true });
    else setFailed(true);
  };

  const seek = (ms: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) void v.play().catch(() => {});
    v.focus({ preventScroll: true });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-2">
        <div className="overflow-hidden rounded-xl border border-line bg-ink">
          <video ref={ref} key={source.src} src={source.src} poster={source.poster} onError={onError} controls preload="metadata" playsInline
            aria-label={title} className="aspect-[16/10] w-full" />
        </div>
        {failed ? <p role="alert" className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink-soft">This video couldn’t load right now. Use the steps list or “Try it yourself” instead.</p> : null}
      </div>
      <section aria-labelledby="steps-h" className="rounded-xl border border-line bg-surface p-4 lg:max-h-[32rem] lg:overflow-y-auto">
        <h2 id="steps-h" className="text-sm font-semibold">Steps <span className="font-normal text-ink-soft">— tap one to jump there</span></h2>
        <ol className="mt-2 space-y-0.5">
          {steps.map((s, i) => (
            <li key={i}>
              <button type="button" onClick={() => seek(s.ms)} aria-current={i === active ? "step" : undefined}
                className={clsx("flex min-h-11 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-brand lg:min-h-0",
                  i === active ? "bg-brand-soft text-ink" : "hover:bg-canvas")}>
                <span className={clsx("mt-px inline-grid h-5 w-5 flex-none place-items-center rounded-full text-[11px] font-semibold",
                  i === active ? "bg-brand text-white" : "bg-canvas text-ink-soft")}>{i + 1}</span>
                <span className="flex-1">{s.caption}</span>
                <span className="flex-none text-xs tabular-nums text-ink-soft">{fmt(s.ms)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";

/** Native video player + clickable step list (seeks to each step's start). Never autoplays. */
export function VideoPlayer({ src, poster, title, steps }: { src: string; poster: string; title: string; steps: { caption: string; ms: number }[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onTime = () => {
      const ms = v.currentTime * 1000;
      let i = -1;
      steps.forEach((s, k) => { if (ms >= s.ms) i = k; });
      setActive(i);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [steps]);
  const seek = (ms: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    void v.play().catch(() => {});
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="overflow-hidden rounded-xl border border-line bg-ink">
        <video ref={ref} src={src} poster={poster} controls preload="metadata" playsInline aria-label={title} className="aspect-[16/10] w-full" />
      </div>
      <section aria-labelledby="steps-h" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="steps-h" className="text-sm font-semibold">Steps <span className="font-normal text-ink-soft">— tap one to jump there</span></h2>
        <ol className="mt-2 space-y-0.5">
          {steps.map((s, i) => (
            <li key={i}>
              <button type="button" onClick={() => seek(s.ms)} aria-current={i === active ? "step" : undefined}
                className={clsx("flex min-h-11 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors lg:min-h-0",
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

"use client";
import { useState } from "react";
import { fmtDuration, posterSrc } from "./videos";
import { localPosterSrc } from "./catalog";

/** Poster image from Storage; falls back once to the bundled /public copy if it fails to load. */
export function Poster({ slug, seconds, large, watched }: { slug: string; seconds: number; large?: boolean; watched?: boolean }) {
  const [src, setSrc] = useState(posterSrc(slug));
  const local = localPosterSrc(slug);
  return (
    <div className="relative aspect-[16/10] bg-canvas">
      {/* eslint-disable-next-line @next/next/no-img-element -- remote/static poster */}
      <img src={src} alt="" loading={large ? "eager" : "lazy"} onError={() => { if (src !== local) setSrc(local); }} className="h-full w-full object-cover" />
      <span aria-hidden className="absolute inset-0 grid place-items-center">
        <span className={`grid place-items-center rounded-full bg-ink/75 text-white shadow-lg ${large ? "h-14 w-14" : "h-9 w-9"}`}>
          <svg viewBox="0 0 24 24" className={large ? "h-6 w-6" : "h-4 w-4"} fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>
        </span>
      </span>
      <span className="absolute bottom-1.5 right-1.5 rounded bg-ink/80 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">{fmtDuration(seconds)}</span>
      {watched ? (
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-surface/95 px-1.5 py-0.5 text-[11px] font-semibold text-ok shadow-sm">
          <svg aria-hidden viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor"><path d="M7.7 13.3 4.4 10l-1.1 1.1 4.4 4.4 9-9-1.1-1.1z" /></svg>Watched
        </span>
      ) : null}
    </div>
  );
}

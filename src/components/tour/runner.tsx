"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Tour } from "./types";
import { tourByKey } from "./tours";

type State = { key: string; index: number } | null;
type Ctx = { active: Tour | null; index: number; startTour: (key: string) => void; exit: () => void };
const STORE = "cre-os.tour";
const TourCtx = createContext<Ctx>({ active: null, index: 0, startTour: () => {}, exit: () => {} });
export const useTour = () => useContext(TourCtx);

function load(): State {
  try { const v = JSON.parse(sessionStorage.getItem(STORE) ?? "null"); return v && typeof v.key === "string" && tourByKey(v.key) ? { key: v.key, index: Number(v.index) || 0 } : null; } catch { return null; }
}
function save(s: State) {
  try { if (s) sessionStorage.setItem(STORE, JSON.stringify(s)); else sessionStorage.removeItem(STORE); } catch { /* storage unavailable */ }
}
function routeMatches(route: string, pathname: string, search: string): boolean {
  const u = new URL(route, "http://x");
  if (u.pathname !== pathname) return false;
  const cur = new URLSearchParams(search);
  for (const [k, v] of u.searchParams) if (cur.get(k) !== v) return false;
  return true;
}
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Starts a tour from `?tour=<key>` on any page, then removes the param. Wrap in <Suspense>. */
export function TourUrlStarter() {
  const params = useSearchParams();
  const { startTour } = useTour();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const key = params.get("tour");
    if (!key) return;
    const rest = new URLSearchParams(params.toString());
    rest.delete("tour");
    const qs = rest.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    if (tourByKey(key)) startTour(key);
  }, [params, pathname, router, startTour]);
  return null;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [done, setDone] = useState(false);
  useEffect(() => { setState(load()); }, []);
  const update = useCallback((s: State) => { save(s); setState(s); }, []);
  const startTour = useCallback((key: string) => { if (tourByKey(key)) { setDone(false); update({ key, index: 0 }); } }, [update]);
  const exit = useCallback(() => update(null), [update]);
  const active = state ? tourByKey(state.key) ?? null : null;
  const index = active ? Math.min(state!.index, active.steps.length - 1) : 0;

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 4000);
    return () => clearTimeout(t);
  }, [done]);

  const go = (i: number) => {
    if (!active) return;
    if (i < 0) return;
    if (i >= active.steps.length) { update(null); setDone(true); return; }
    update({ key: active.key, index: i });
  };

  return (
    <TourCtx.Provider value={{ active, index, startTour, exit }}>
      {children}
      {active && active.steps.length > 0 && <TourRunner tour={active} index={index} onGo={go} onExit={exit} />}
      {done && (
        <div role="status" className="fixed inset-x-4 bottom-20 z-[1001] mx-auto max-w-sm rounded-2xl border border-line bg-surface p-4 shadow-xl sm:bottom-6 sm:left-auto sm:right-6 sm:mx-0">
          <p className="font-semibold">Tutorial complete</p>
          <p className="mt-1 text-sm text-ink-soft">Nice work. <Link href="/tutorials" className="font-semibold text-brand hover:underline" onClick={() => setDone(false)}>Back to tutorials</Link></p>
        </div>
      )}
    </TourCtx.Provider>
  );
}

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 6;

function TourRunner({ tour, index, onGo, onExit }: { tour: Tour; index: number; onGo: (i: number) => void; onExit: () => void }) {
  const step = tour.steps[index];
  const router = useRouter();
  const pathname = usePathname();
  const [el, setEl] = useState<Element | null>(null);
  const [searching, setSearching] = useState(true);
  const [rect, setRect] = useState<Rect | null>(null);
  const [vw, setVw] = useState(1024);
  const [vh, setVh] = useState(768);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  const titleId = useId();
  const motion = !reducedMotion();

  // Navigate to the step's route, then poll for its target.
  useEffect(() => {
    setEl(null); setRect(null); setSearching(true);
    if (!routeMatches(step.route, pathname, window.location.search)) router.push(step.route);
    if (!step.target) { setSearching(false); return; }
    const sel = `[data-tour="${CSS.escape(step.target)}"]`;
    const started = Date.now();
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const found = routeMatches(step.route, window.location.pathname, window.location.search) ? document.querySelector(sel) : null;
      if (found) {
        found.scrollIntoView({ block: "center", behavior: motion ? "smooth" : "auto" });
        setEl(found); setSearching(false); return;
      }
      if (Date.now() - started > 6000) { setSearching(false); return; }
      setTimeout(tick, 150);
    };
    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.key, index, pathname]);

  // Follow the element on scroll/resize.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      setVw(window.innerWidth); setVh(window.innerHeight);
      if (el && el.isConnected) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); }
      else setRect(null);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const iv = setInterval(schedule, 500); // layout shifts from late-loading content
    return () => { window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); clearInterval(iv); if (raf) cancelAnimationFrame(raf); };
  }, [el]);

  useLayoutEffect(() => { if (cardRef.current) setCardH(cardRef.current.offsetHeight); });
  useEffect(() => { cardRef.current?.focus({ preventScroll: true }); }, [index, tour.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && e.key !== "Escape") return;
      if (e.key === "Escape") onExit();
      else if (e.key === "ArrowRight") onGo(index + 1);
      else if (e.key === "ArrowLeft") onGo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onGo, onExit]);

  const last = index === tour.steps.length - 1;
  const mobile = vw < 640;
  const ring = rect && { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };

  let cardStyle: React.CSSProperties;
  if (mobile) cardStyle = { left: 0, right: 0, bottom: 0 };
  else if (ring) {
    const width = Math.min(384, vw - 32);
    const left = Math.max(16, Math.min(ring.left, vw - width - 16));
    const below = ring.top + ring.height + 12;
    const wantTop = step.placement === "top" || (step.placement !== "bottom" && below + cardH > vh - 16);
    const top = wantTop ? Math.max(16, ring.top - cardH - 12) : Math.min(below, vh - cardH - 16);
    cardStyle = { top, left, width };
  } else cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: Math.min(384, vw - 32) };

  const transition = motion ? "all 200ms ease" : "none";

  return (
    <>
      {/* Dim layer: a full-screen backdrop when there's no highlight, otherwise the ring's giant box-shadow. */}
      {!ring && <div aria-hidden className="pointer-events-none fixed inset-0 z-[1000]" style={{ background: "rgba(15,15,30,.55)" }} />}
      {ring && (
        <div aria-hidden className="pointer-events-none fixed z-[1000] rounded-xl ring-2 ring-brand"
          style={{ ...ring, boxShadow: "0 0 0 9999px rgba(15,15,30,.55)", transition }} />
      )}
      <div ref={cardRef} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}
        className={`fixed z-[1001] bg-surface p-4 shadow-xl outline-none ${mobile ? "rounded-t-2xl border-t border-line pb-6" : "max-w-sm rounded-2xl border border-line"}`}
        style={{ ...cardStyle, transition }}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-brand">{tour.module} · {tour.title}</p>
          <button type="button" onClick={onExit} aria-label="Exit tutorial" className="-mr-1 -mt-1 rounded-lg px-2 text-lg leading-none text-ink-soft hover:bg-canvas">×</button>
        </div>
        <div className="mt-2 flex items-center gap-1" aria-label={`Step ${index + 1} of ${tour.steps.length}`}>
          {tour.steps.map((_, i) => <span key={i} className={`h-1.5 rounded-full ${i === index ? "w-4 bg-brand" : i < index ? "w-1.5 bg-brand/60" : "w-1.5 bg-line"}`} />)}
          <span className="ml-2 text-xs text-ink-soft">{index + 1} / {tour.steps.length}</span>
        </div>
        <h2 id={titleId} className="mt-2 font-semibold">{step.title}</h2>
        <p className="mt-1 text-sm text-ink-soft">{step.body}</p>
        {step.target && !el && (
          <p className="mt-2 text-xs text-ink-soft">{searching ? "Finding this on the page…" : "This part isn't on the screen right now — it may appear once you have data."}</p>
        )}
        <div className="mt-4 flex items-center justify-between gap-2">
          <button type="button" onClick={onExit} className="text-sm text-ink-soft hover:underline">Exit</button>
          <div className="flex gap-2">
            <button type="button" onClick={() => onGo(index - 1)} disabled={index === 0} className="rounded-xl border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-40">Back</button>
            <button type="button" onClick={() => onGo(index + 1)} className="rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-white">{last ? "Finish" : "Next"}</button>
          </div>
        </div>
      </div>
    </>
  );
}

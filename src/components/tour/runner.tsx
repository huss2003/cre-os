"use client";
import Link from "next/link";
import { createContext, Suspense, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Tour, TourStep } from "./types";
import { tourByKey } from "./tours";

type Vars = Record<string, string | undefined>;
type State = { key: string; index: number; done: number[]; vars: Vars } | null;
type Ended = { tour: Tour; done: number[] } | null;
type Ctx = { active: Tour | null; index: number; startTour: (key: string, vars?: Vars) => void; exit: () => void };
const STORE = "cre-os.tour";
const TourCtx = createContext<Ctx>({ active: null, index: 0, startTour: () => {}, exit: () => {} });
export const useTour = () => useContext(TourCtx);

function load(): State {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? "null");
    return v && typeof v.key === "string" && tourByKey(v.key)
      ? { key: v.key, index: Number(v.index) || 0, done: Array.isArray(v.done) ? v.done.filter((n: unknown) => typeof n === "number") : [], vars: v.vars && typeof v.vars === "object" ? v.vars : {} }
      : null;
  } catch { return null; }
}
function save(s: State) {
  try { if (s) sessionStorage.setItem(STORE, JSON.stringify(s)); else sessionStorage.removeItem(STORE); } catch { /* storage unavailable */ }
}
/** Path match with "*" = one segment; query params in `route` must be present with the same value. */
function routeMatches(route: string, pathname: string, search: string): boolean {
  const u = new URL(route, "http://x");
  const want = u.pathname.split("/"), have = pathname.split("/");
  if (want.length !== have.length || want.some((w, i) => w !== "*" && w !== have[i])) return false;
  const cur = new URLSearchParams(search);
  for (const [k, v] of u.searchParams) if (cur.get(k) !== v) return false;
  return true;
}
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const isDo = (s: TourStep) => s.kind === "do";

/** The tour's practice record URL, with {tokens} filled from practice data, or the fallback. */
export function practiceHref(tour: Tour, vars: Vars): string | null {
  if (!tour.practice) return null;
  let missing = false;
  const href = tour.practice.href.replace(/\{(\w+)\}/g, (_, k: string) => { const v = vars[k]; if (!v) missing = true; return v ?? ""; });
  return missing ? tour.practice.fallback ?? tour.practice.href.replace(/\/?\{\w+\}.*$/, "") ?? "/" : href;
}
/** Where a step lives: a real route, the practice record, or null for "@current" (stay put). */
function stepRoute(step: TourStep, tour: Tour, vars: Vars): string | null {
  if (step.route === "@current") return null;
  if (step.route === "@practice") return practiceHref(tour, vars);
  return step.route;
}

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
  const [ended, setEnded] = useState<Ended>(null);
  useEffect(() => { setState(load()); }, []);
  const update = useCallback((s: State) => { save(s); setState(s); }, []);
  const startTour = useCallback((key: string, vars: Vars = {}) => { if (tourByKey(key)) { setEnded(null); update({ key, index: 0, done: [], vars }); } }, [update]);
  const exit = useCallback(() => update(null), [update]);
  const active = state ? tourByKey(state.key) ?? null : null;
  const index = active ? Math.min(state!.index, active.steps.length - 1) : 0;

  const go = useCallback((i: number, markDone?: number) => {
    setState((cur) => {
      if (!cur) return cur;
      const t = tourByKey(cur.key); if (!t) return cur;
      const done = markDone !== undefined && !cur.done.includes(markDone) ? [...cur.done, markDone] : cur.done;
      if (i < 0) return cur;
      if (i >= t.steps.length) { save(null); setEnded({ tour: t, done }); return null; }
      const next = { ...cur, index: i, done };
      save(next);
      return next;
    });
  }, []);

  return (
    <TourCtx.Provider value={{ active, index, startTour, exit }}>
      {children}
      {active && state && active.steps.length > 0 && (
        <Suspense fallback={null}>
          <TourRunner tour={active} index={index} done={state.done} vars={state.vars} onGo={go} onExit={exit} />
        </Suspense>
      )}
      {ended && <EndScreen ended={ended} onClose={() => setEnded(null)} onRestart={() => startTour(ended.tour.key, {})} />}
    </TourCtx.Provider>
  );
}

const KEYFRAMES = `
@keyframes tour-pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.15);opacity:1}100%{transform:scale(1)}}
@keyframes tour-pulse{0%{box-shadow:0 0 0 0 rgba(99,102,241,.7)}100%{box-shadow:0 0 0 16px rgba(99,102,241,0)}}
@media (prefers-reduced-motion: reduce){.tour-anim{animation:none!important}}`;

function Tick({ size = 40 }: { size?: number }) {
  return (
    <span aria-hidden className="tour-anim inline-flex shrink-0 items-center justify-center rounded-full bg-ok text-white" style={{ width: size, height: size, animation: "tour-pop 420ms ease-out both" }}>
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
    </span>
  );
}

function EndScreen({ ended, onClose, onRestart }: { ended: NonNullable<Ended>; onClose: () => void; onRestart: () => void }) {
  const { tour, done } = ended;
  const tasks = tour.steps.map((s, i) => ({ s, i })).filter((x) => isDo(x.s));
  const did = tasks.filter((x) => done.includes(x.i)).length;
  const learned = tour.learned?.length ? tour.learned : tasks.map((x) => x.s.task ?? x.s.title);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1002] flex items-end justify-center sm:items-center" style={{ background: "rgba(15,15,30,.55)" }}>
      <style>{KEYFRAMES}</style>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="tour-end-title" className="max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl outline-none sm:max-w-md sm:rounded-2xl">
        <div className="flex items-center gap-3"><Tick /><div><p className="text-xs font-semibold uppercase tracking-wide text-brand">{tour.module} · {tour.title}</p><h2 id="tour-end-title" className="text-lg font-semibold">Tutorial complete</h2></div></div>
        {tasks.length ? <p className="mt-3 text-sm text-ink-soft">You did <b className="text-ink">{did} of {tasks.length}</b> tasks yourself{did < tasks.length ? " — skipped ones are worth trying for real next time" : ""}.</p> : null}
        <h3 className="mt-4 text-sm font-semibold">What you learned</h3>
        <ul className="mt-2 space-y-1.5 text-sm">{learned.map((l, i) => <li key={i} className="flex gap-2"><span aria-hidden className="text-ok">✓</span><span>{l}</span></li>)}</ul>
        <p className="mt-4 rounded-xl bg-canvas px-3 py-2 text-xs text-ink-soft">Practice records are labelled “(tutorial)”. Remove them any time from the Tutorials page — they are archived, not deleted.</p>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onRestart} className="mr-auto text-sm text-ink-soft hover:underline">Do it again</button>
          <button type="button" onClick={onClose} className="rounded-xl border border-line px-3 py-1.5 text-sm font-medium">Close</button>
          <Link href="/tutorials" onClick={onClose} className="rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-white">Back to tutorials</Link>
        </div>
      </div>
    </div>
  );
}

type Rect = { top: number; left: number; width: number; height: number };
const PAD = 6;
const DIM = "rgba(15,15,30,.55)";

function findVisible(sel: string): Element | null {
  for (const n of document.querySelectorAll(sel)) { const r = n.getBoundingClientRect(); if (r.width > 0 || r.height > 0) return n; }
  return null;
}

function TourRunner({ tour, index, done, vars, onGo, onExit }: { tour: Tour; index: number; done: number[]; vars: Vars; onGo: (i: number, markDone?: number) => void; onExit: () => void }) {
  const step = tour.steps[index];
  const doStep = isDo(step);
  const route = stepRoute(step, tour, vars);
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [el, setEl] = useState<Element | null>(null);
  const [searching, setSearching] = useState(true);
  const [rect, setRect] = useState<Rect | null>(null);
  const [vw, setVw] = useState(1024);
  const [vh, setVh] = useState(768);
  const [celebrate, setCelebrate] = useState(false);
  const [pulse, setPulse] = useState(0);
  const [findNonce, setFindNonce] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(220);
  const titleId = useId();
  const motion = !reducedMotion();
  const tasks = tour.steps.map((s, i) => ({ s, i })).filter((x) => isDo(x.s));
  const taskNo = tasks.findIndex((x) => x.i === index);

  // Warm up every route in this tour once, so moving between screens is instant.
  useEffect(() => {
    const rs = new Set<string>();
    for (const st of tour.steps) { const r = stepRoute(st, tour, vars); if (r && !r.includes("*")) rs.add(r); }
    for (const r of rs) router.prefetch(r);
  }, [tour, vars, router]);

  // Go to the step's route — only when the step changes, so a do-step can let the user navigate freely.
  useEffect(() => {
    setCelebrate(false);
    if (route && !routeMatches(route, window.location.pathname, window.location.search)) router.push(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.key, index]);

  // Find the target: check now, then on DOM changes (MutationObserver) with a slow backup check, until timeout.
  useEffect(() => {
    setEl(null); setRect(null); setSearching(!!step.target);
    if (!step.target) return;
    const sel = `[data-tour="${CSS.escape(step.target)}"]`;
    let stopped = false;
    const check = () => {
      if (stopped) return true;
      if (route && !routeMatches(route, window.location.pathname, window.location.search)) return false;
      let found = findVisible(sel);
      if (!found) return false;
      // A target that wraps a whole page would light up everything — point at its heading instead.
      if (found.getBoundingClientRect().height > window.innerHeight * 0.6) found = found.querySelector("header, h1, h2") ?? found;
      const r0 = found.getBoundingClientRect();
      if (r0.top < 80 || r0.bottom > window.innerHeight - 80) found.scrollIntoView({ block: "center", behavior: "auto" });
      setEl(found); setSearching(false); return true;
    };
    if (check()) return;
    const mo = new MutationObserver(() => { if (check()) cleanup(); });
    mo.observe(document.body, { childList: true, subtree: true });
    const backup = setInterval(() => { if (check()) cleanup(); }, 500);
    const limit = setTimeout(() => { cleanup(); setSearching(false); }, doStep || step.route === "@current" ? 15000 : 6000);
    function cleanup() { stopped = true; mo.disconnect(); clearInterval(backup); clearTimeout(limit); }
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.key, index, pathname, search, findNonce]);

  // Follow the element on scroll/resize.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      setVw((v) => (v === window.innerWidth ? v : window.innerWidth)); setVh((v) => (v === window.innerHeight ? v : window.innerHeight));
      if (el && el.isConnected) {
        const r = el.getBoundingClientRect();
        setRect((p) => (p && Math.abs(p.top - r.top) < 0.5 && Math.abs(p.left - r.left) < 0.5 && Math.abs(p.width - r.width) < 0.5 && Math.abs(p.height - r.height) < 0.5 ? p : { top: r.top, left: r.left, width: r.width, height: r.height }));
      } else {
        setRect((p) => (p === null ? p : null));
        if (el) setFindNonce((n) => n + 1); // element was replaced (e.g. after a server action re-render) — look again
      }
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null; // late-loading content shifts layout
    if (ro) { ro.observe(document.body); if (el) ro.observe(el); }
    return () => { window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [el]);

  // Hands-on completion: tick, record, move on.
  const completedRef = useRef(false);
  useEffect(() => { completedRef.current = false; }, [tour.key, index]);
  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    setCelebrate(true);
    setTimeout(() => onGo(index + 1, index), reducedMotion() ? 350 : 800);
  }, [index, onGo]);

  // click / input / element listeners for do-steps.
  useEffect(() => {
    const w = step.waitFor;
    if (!doStep || !w) return;
    const t = w.target ?? step.target;
    const tsel = t ? `[data-tour="${CSS.escape(t)}"]` : null;
    if (w.type === "click" && tsel) {
      const h = (e: MouseEvent) => { const n = e.target as Element | null; if (n?.closest?.(tsel)) complete(); };
      document.addEventListener("click", h, true);
      return () => document.removeEventListener("click", h, true);
    }
    if (w.type === "input" && tsel) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const h = (e: Event) => {
        const n = e.target as HTMLInputElement | HTMLTextAreaElement | null;
        if (!n?.closest?.(tsel)) return;
        clearTimeout(timer);
        if (String(n.value ?? "").trim().length >= 3) timer = setTimeout(complete, 900);
      };
      document.addEventListener("input", h, true);
      return () => { document.removeEventListener("input", h, true); clearTimeout(timer); };
    }
    if (w.type === "element") {
      const sel = w.selector ?? tsel; if (!sel) return;
      const check = () => { if (findVisible(sel)) { complete(); return true; } return false; };
      if (check()) return;
      const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
      return () => mo.disconnect();
    }
  }, [doStep, step, complete]);

  // route waits: react to navigation (pathname or query).
  useEffect(() => {
    const w = step.waitFor;
    if (!doStep || w?.type !== "route") return;
    const want = w.route === "@practice" ? practiceHref(tour, vars) : w.route;
    if (want && routeMatches(want, pathname, search ? `?${search}` : "")) complete();
  }, [doStep, step, pathname, search, tour, vars, complete]);

  useLayoutEffect(() => { if (cardRef.current) { const h = cardRef.current.offsetHeight; setCardH((p) => (p === h ? p : h)); } }, [index, tour.key, vw, celebrate, el, searching]);
  useEffect(() => { cardRef.current?.focus({ preventScroll: true }); }, [index, tour.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && e.key !== "Escape") return;
      if (e.key === "Escape") onExit();
      else if (e.key === "ArrowRight" && !doStep) onGo(index + 1);
      else if (e.key === "ArrowLeft") onGo(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onGo, onExit, doStep]);

  const showMe = () => {
    if (el && el.isConnected) { el.scrollIntoView({ block: "center", behavior: motion ? "smooth" : "auto" }); setPulse((p) => p + 1); }
    else { if (route && !routeMatches(route, window.location.pathname, window.location.search)) router.push(route); setFindNonce((n) => n + 1); }
  };

  const last = index === tour.steps.length - 1;
  const mobile = vw < 640;
  const ring = rect && { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
  // During a click/input task only the highlighted element is usable; route/element tasks leave the page free.
  const block = doStep && !!ring && !celebrate && (step.waitFor?.type === "click" || step.waitFor?.type === "input");

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

  const transition = motion ? "top 140ms ease-out, left 140ms ease-out, width 140ms ease-out, height 140ms ease-out" : "none";
  const dimCls = `fixed z-[1000] ${block ? "pointer-events-auto cursor-not-allowed" : "pointer-events-none"}`;
  const onDimClick = block ? () => setPulse((p) => p + 1) : undefined;

  return (
    <>
      <style>{KEYFRAMES}</style>
      {/* Dim layer: four rectangles around the ring, so the hole stays clickable. */}
      {!ring && <div aria-hidden className="pointer-events-none fixed inset-0 z-[1000]" style={{ background: DIM }} />}
      {ring && (
        <>
          <div aria-hidden className={dimCls} onClick={onDimClick} style={{ top: 0, left: 0, right: 0, height: Math.max(0, ring.top), background: DIM }} />
          <div aria-hidden className={dimCls} onClick={onDimClick} style={{ top: ring.top + ring.height, left: 0, right: 0, bottom: 0, background: DIM }} />
          <div aria-hidden className={dimCls} onClick={onDimClick} style={{ top: ring.top, left: 0, width: Math.max(0, ring.left), height: ring.height, background: DIM }} />
          <div aria-hidden className={dimCls} onClick={onDimClick} style={{ top: ring.top, left: ring.left + ring.width, right: 0, height: ring.height, background: DIM }} />
          <div key={pulse} aria-hidden className={`tour-anim pointer-events-none fixed z-[1000] rounded-xl ring-2 ${celebrate ? "ring-ok" : "ring-brand"}`}
            style={{ ...ring, willChange: "top, left, width, height", animation: pulse ? "tour-pulse 700ms ease-out 2" : undefined }} />
        </>
      )}
      <div ref={cardRef} role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}
        className={`fixed z-[1001] max-h-[70vh] overflow-y-auto bg-surface p-4 shadow-xl outline-none ${mobile ? "rounded-t-2xl border-t border-line pb-6" : "max-w-sm rounded-2xl border border-line"}`}
        style={{ ...cardStyle, transition, willChange: "top, left" }}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-brand">{tour.module} · {tour.title}</p>
          <button type="button" onClick={onExit} aria-label="Exit tutorial" className="-mr-1 -mt-1 rounded-lg px-2 text-lg leading-none text-ink-soft hover:bg-canvas">×</button>
        </div>
        <div className="mt-2" aria-label={`Step ${index + 1} of ${tour.steps.length}`}>
          <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-brand" style={{ width: `${((index + (celebrate ? 1 : 0)) / tour.steps.length) * 100}%`, transition: motion ? "width 300ms ease-out" : "none" }} /></div>
          <p className="mt-1.5 text-xs text-ink-soft">Step {index + 1} of {tour.steps.length} · <span className={doStep ? "font-semibold text-brand" : ""}>{doStep ? "Do it" : "Read"}</span></p>
        </div>
        <h2 id={titleId} className="mt-2 font-semibold">{step.title}</h2>
        <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{step.body}</p>
        {doStep ? (
          <div className={`mt-3 flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm ${celebrate ? "bg-ok/10" : "bg-brand-soft"}`} role="status" aria-live="polite">
            {celebrate ? <Tick size={28} /> : <span aria-hidden className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-brand text-[10px] font-bold text-brand">{taskNo + 1}</span>}
            <span><span className="block font-semibold">{celebrate ? "Done!" : "Your task"}</span><span className="block">{step.task ?? step.title}</span></span>
          </div>
        ) : null}
        {step.target && !el && !celebrate && (
          <p className="mt-2 text-xs text-ink-soft">{searching ? "Finding this on the page…" : doStep ? "Can't see it yet — press Show me, or Skip this step." : "This part isn't on the screen right now — it may appear once you have data."}</p>
        )}
        {tasks.length ? (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-ink-soft">Tasks {tasks.filter((x) => done.includes(x.i)).length} / {tasks.length} done</summary>
            <ol className="mt-2 space-y-1">{tasks.map((x, n) => {
              const ok = done.includes(x.i) || (celebrate && x.i === index);
              return <li key={x.i} className={`flex gap-2 text-xs ${x.i === index ? "font-semibold text-ink" : "text-ink-soft"}`}><span aria-hidden className={ok ? "text-ok" : ""}>{ok ? "✓" : `${n + 1}.`}</span><span>{x.s.task ?? x.s.title}</span></li>;
            })}</ol>
          </details>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2">
          {doStep
            ? <button type="button" onClick={() => onGo(index + 1)} disabled={celebrate} className="text-sm text-ink-soft hover:underline">Skip this step</button>
            : <button type="button" onClick={onExit} className="text-sm text-ink-soft hover:underline">Exit</button>}
          <div className="flex gap-2">
            <button type="button" onClick={() => onGo(index - 1)} disabled={index === 0 || celebrate} className="rounded-xl border border-line px-3 py-1.5 text-sm font-medium disabled:opacity-40">Back</button>
            {doStep
              ? <button type="button" onClick={showMe} disabled={celebrate} className="rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">Show me</button>
              : <button type="button" onClick={() => onGo(index + 1)} className="rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-white">{last ? "Finish" : "Next"}</button>}
          </div>
        </div>
      </div>
    </>
  );
}

"use client";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { focusFromPath } from "./focus";

const Panel = dynamic(() => import("./panel"), { ssr: false });

export function SparkIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

/** "Ask AI" trigger for the app shell. variant "bar" = top bar button; "fab" = floating on mobile. Panel code loads on first open. */
export function AskAiButton({ variant }: { variant: "bar" | "fab" }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => !o); } };
    if (variant === "bar") document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [variant]);
  if (path === "/assistant" || path.startsWith("/assistant/")) return null;
  // On phones the bottom bar already has Ask AI; the floating button only appears on a record, where it adds that record as context.
  if (variant === "fab" && !focusFromPath(path)) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} title="Ask AI (Ctrl+J)"
        className={clsx(variant === "bar"
          ? "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-sm font-medium text-ink hover:bg-canvas [&>svg]:text-brand"
          : "fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-ink text-white shadow-lg hover:bg-brand-strong lg:hidden")}>
        <SparkIcon className={variant === "fab" ? "h-5 w-5" : "h-4 w-4"} />
        {variant === "bar" ? <span className="hidden sm:inline">Ask AI</span> : null}<span className={variant === "bar" ? "sm:hidden sr-only" : "sr-only"}>Ask AI</span>
      </button>
      {open ? <Panel focus={focusFromPath(path)} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

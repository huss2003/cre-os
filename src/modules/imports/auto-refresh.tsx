"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the server page every few seconds while background work is running (the user can navigate away at any time). */
export function AutoRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}

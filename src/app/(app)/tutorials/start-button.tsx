"use client";
import { useTour } from "@/components/tour/runner";

export function StartTourButton({ tourKey }: { tourKey: string }) {
  const { startTour } = useTour();
  return (
    <button type="button" onClick={() => startTour(tourKey)} className="mt-4 w-full rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
      Start tutorial
    </button>
  );
}

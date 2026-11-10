import { TOURS } from "@/components/tour/tours";
import { HelpFor } from "@/components/ui";
import { StartTourButton } from "./start-button";

export const metadata = { title: "Tutorials" };

export default function TutorialsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center text-2xl font-bold tracking-tight">Tutorials<HelpFor k="Tutorials" /></h1>
        <p className="mt-1 text-sm text-ink-soft">Pick a module for a guided walk-through. It moves you between screens and points at each part.</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOURS.map((t) => (
          <li key={t.key} className="flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm">
            <span className="self-start rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">{t.module}</span>
            <h2 className="mt-3 font-semibold">{t.title}</h2>
            <p className="mt-1 flex-1 text-sm text-ink-soft">{t.summary}</p>
            <p className="mt-3 text-xs text-ink-soft">~{t.minutes} min · {t.steps.length} steps</p>
            <StartTourButton tourKey={t.key} />
          </li>
        ))}
      </ul>
    </div>
  );
}

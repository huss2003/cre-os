import { TOURS } from "@/components/tour/tours";
import { HelpFor } from "@/components/ui";
import { StartTourButton, PracticePanel } from "./start-button";
import { practiceStatus } from "./practice";
import { WatchSection } from "./watch";

export const metadata = { title: "Tutorials" };

export default async function TutorialsPage({ searchParams }: { searchParams: Promise<{ topic?: string | string[]; q?: string | string[] }> }) {
  const sp = await searchParams;
  const one = (x?: string | string[]) => (Array.isArray(x) ? x[0] : x) ?? "";
  const practice = await practiceStatus();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center text-2xl font-bold tracking-tight">Tutorials<HelpFor k="Tutorials" /></h1>
        <p className="mt-1 text-sm text-ink-soft">Watch a short video of each task, then try it yourself with guidance. Nothing is ever sent to anyone.</p>
      </header>
      <WatchSection initialTopic={one(sp.topic)} initialQ={one(sp.q)} />
      <section aria-labelledby="guided-h" className="space-y-4">
      <div>
        <h2 id="guided-h" className="text-lg font-semibold tracking-tight">Try it with guidance</h2>
        <p className="mt-0.5 text-sm text-ink-soft">Hands-on practice: each tutorial gives you real tasks on clearly-labelled practice records and moves on when you do them.</p>
      </div>
      <PracticePanel status={practice} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOURS.map((t) => {
          const tasks = t.steps.filter((s) => s.kind === "do").length;
          return (
            <li key={t.key} className="flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <span className="self-start rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">{t.module}</span>
              <h2 className="mt-3 font-semibold">{t.title}</h2>
              <p className="mt-1 flex-1 text-sm text-ink-soft">{t.summary}</p>
              <p className="mt-3 text-xs font-medium text-ink">{tasks ? `Hands-on · ${tasks} task${tasks === 1 ? "" : "s"}` : "Walk-through"} · ~{t.minutes} min</p>
              {t.practice ? (
                <p className={`mt-1 text-xs ${practice.complete ? "text-ok" : "text-ink-soft"}`}>
                  {practice.complete ? "✓ Practice record ready: " : "Uses practice record: "}{t.practice.label}
                </p>
              ) : null}
              <StartTourButton tourKey={t.key} ids={practice.ids} needsPractice={!!t.practice && !practice.complete} />
            </li>
          );
        })}
      </ul>
      </section>
    </div>
  );
}

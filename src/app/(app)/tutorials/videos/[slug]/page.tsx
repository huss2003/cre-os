import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui";
import { VIDEOS, fmtDuration, posterSrc, videoSrc } from "../../videos";
import { localPosterSrc, localVideoSrc, neighbours, tutorialsHref } from "../../catalog";
import { VideoPlayer } from "./player";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return { title: VIDEOS.find((v) => v.slug === slug)?.title ?? "Tutorial video" };
}

export default async function TutorialVideoPage({ params }: Props) {
  const { slug } = await params;
  const v = VIDEOS.find((x) => x.slug === slug);
  if (!v) notFound();
  const topic = v.category || "Other";
  const { prev, next } = neighbours(VIDEOS, slug);
  const inTopic = VIDEOS.filter((x) => (x.category || "Other") === topic);
  const pos = inTopic.findIndex((x) => x.slug === slug) + 1;
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-ink-soft">
          <li><Link href="/tutorials#watch" className="hover:text-ink hover:underline">Tutorials</Link></li>
          <li aria-hidden>/</li>
          <li><Link href={tutorialsHref(topic)} className="hover:text-ink hover:underline">{topic}</Link></li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="truncate text-ink">{pos} of {inTopic.length}</li>
        </ol>
      </nav>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{v.learn} · {fmtDuration(v.seconds)}</p>
      </header>
      <VideoPlayer key={v.slug} slug={v.slug} src={videoSrc(v.slug)} poster={posterSrc(v.slug)}
        fallbackSrc={localVideoSrc(v.slug)} fallbackPoster={localPosterSrc(v.slug)} title={v.title} steps={v.steps} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ButtonLink href={v.tryRoute}>Try it yourself →</ButtonLink>
        <div className="grid gap-2 sm:flex">
          {prev ? (
            <Link href={`/tutorials/videos/${prev.slug}`} rel="prev" className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-canvas sm:min-h-8">
              <span className="text-ink-soft">← Previous:</span><span className="line-clamp-1 font-medium">{prev.title}</span>
            </Link>
          ) : null}
          {next ? (
            <Link href={`/tutorials/videos/${next.slug}`} rel="next" className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-canvas sm:min-h-8">
              <span className="text-ink-soft">Next in this topic:</span><span className="line-clamp-1 font-medium">{next.title}</span><span aria-hidden>→</span>
            </Link>
          ) : (
            <Link href="/tutorials#watch" className="flex min-h-11 items-center rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-canvas sm:min-h-8">
              Last one in {topic} — pick another topic →
            </Link>
          )}
        </div>
      </div>
      <p className="text-xs text-ink-soft">Recorded on synthetic demo data. Nothing in these videos was sent to anyone.</p>
    </div>
  );
}

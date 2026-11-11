import Link from "next/link";
import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui";
import { VIDEOS, fmtDuration, posterSrc, videoSrc } from "../../videos";
import { VideoPlayer } from "./player";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return { title: VIDEOS.find((v) => v.slug === slug)?.title ?? "Tutorial video" };
}

export default async function TutorialVideoPage({ params }: Props) {
  const { slug } = await params;
  const i = VIDEOS.findIndex((v) => v.slug === slug);
  if (i < 0) notFound();
  const v = VIDEOS[i];
  const next = VIDEOS[(i + 1) % VIDEOS.length];
  return (
    <div className="space-y-4">
      <Link href="/tutorials" className="text-sm text-ink-soft hover:text-ink">← Tutorials</Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{v.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">{v.learn} · {fmtDuration(v.seconds)}</p>
      </header>
      <VideoPlayer src={videoSrc(v.slug)} poster={posterSrc(v.slug)} title={v.title} steps={v.steps} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ButtonLink href={v.tryRoute}>Try it yourself →</ButtonLink>
        {next.slug !== v.slug ? (
          <Link href={`/tutorials/videos/${next.slug}`} className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:bg-canvas sm:min-h-8">
            <span className="text-ink-soft">Next video:</span><span className="font-medium">{next.title}</span>
          </Link>
        ) : null}
      </div>
      <p className="text-xs text-ink-soft">Recorded on synthetic demo data. Nothing in these videos was sent to anyone.</p>
    </div>
  );
}

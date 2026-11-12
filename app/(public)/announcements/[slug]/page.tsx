import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Notice } from "@/components/site/notice";
import { announcements, getAnnouncement } from "@/lib/announcements";
import { pageMetadata } from "@/lib/metadata";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return announcements.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const entry = getAnnouncement(slug);
  if (!entry) {
    return pageMetadata({
      title: "Announcement not found",
      description: "",
      path: "/announcements",
      noIndex: true,
    });
  }

  return pageMetadata({
    title: entry.title,
    description: entry.summary,
    path: `/announcements/${entry.slug}`,
    noIndex: entry.sample,
  });
}

export default async function AnnouncementPage({ params }: PageProps) {
  const { slug } = await params;
  const entry = getAnnouncement(slug);
  if (!entry) notFound();

  return (
    <>
      <div className="border-b border-border-subtle bg-bg-secondary">
        <div className="shell py-12 sm:py-16">
          <Link
            href="/announcements"
            className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Announcements
          </Link>
          <p className="mt-5 font-mono text-xs text-text-muted">
            <time dateTime={entry.date}>{entry.date}</time>
          </p>
          <h1 className="mt-3 max-w-[26ch] text-balance text-3xl font-semibold tracking-[-0.025em] text-text-primary sm:text-4xl">
            {entry.title}
          </h1>
          <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-text-secondary">
            {entry.summary}
          </p>
        </div>
      </div>

      <div className="shell py-12 sm:py-16">
        <div className="max-w-[760px]">
          {entry.sample ? (
            <Notice tone="accent" label="Sample content" title="This is a layout sample">
              The text below is not a published announcement. It exists to demonstrate the
              announcement page structure.
            </Notice>
          ) : null}

          <div className="mt-6 space-y-4">
            {entry.body.map((paragraph) => (
              <p key={paragraph} className="text-[15px] leading-7 text-text-secondary">
                {paragraph}
              </p>
            ))}
          </div>

          <p className="mt-8 text-xs leading-relaxed text-text-muted">
            For current availability, see{" "}
            <Link
              href="/docs/platform-status"
              className="rounded-sm text-purple-text underline decoration-border-strong underline-offset-4 hover:decoration-purple-text"
            >
              Platform status
            </Link>
            .
          </p>
        </div>
      </div>
    </>
  );
}

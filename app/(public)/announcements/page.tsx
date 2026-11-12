import { ArrowRight, Megaphone } from "lucide-react";
import Link from "next/link";

import { Notice } from "@/components/site/notice";
import { PageHeader } from "@/components/site/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { announcements, hasPublishedAnnouncements } from "@/lib/announcements";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Announcements",
  description:
    "Announcements from BOYFINITY Hub. This section currently contains sample layout content, clearly labeled.",
  path: "/announcements",
  noIndex: !hasPublishedAnnouncements,
});

export default function AnnouncementsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Announcements"
        title="Announcements"
        description="Product and platform announcements will be published here. This section is ready for content, but no real announcement has been issued."
      />

      <div className="shell py-12 sm:py-16">
        <Notice tone="accent" label="Sample content" title="The entries below are layout samples">
          They exist to verify the announcement layout. They are not published announcements,
          commitments, or release dates.
        </Notice>

        {announcements.length > 0 ? (
          <ol className="mt-10 border-t border-border-subtle">
            {announcements.map((entry) => (
              <li key={entry.slug} className="border-b border-border-subtle py-8">
                <article>
                  <div className="flex flex-wrap items-center gap-3">
                    <time dateTime={entry.date} className="font-mono text-xs text-text-muted">
                      {entry.date}
                    </time>
                    {entry.sample ? <Badge tone="neutral">Sample</Badge> : null}
                  </div>
                  <h2 className="mt-3 text-xl font-semibold tracking-[-0.01em] text-text-primary">
                    <Link
                      href={`/announcements/${entry.slug}`}
                      className="rounded-sm transition-colors hover:text-purple-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                    >
                      {entry.title}
                    </Link>
                  </h2>
                  <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-text-secondary">
                    {entry.summary}
                  </p>
                  <Link
                    href={`/announcements/${entry.slug}`}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-purple-text transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                  >
                    Read announcement
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-10">
            <EmptyState
              icon={Megaphone}
              title="No announcements yet"
              description="Nothing has been announced. Real announcements will appear here when the project has something verified to publish."
            />
          </div>
        )}
      </div>
    </>
  );
}

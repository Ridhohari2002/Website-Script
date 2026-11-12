import { ArrowRight, ScrollText } from "lucide-react";
import Link from "next/link";

import { Notice } from "@/components/site/notice";
import { PageHeader } from "@/components/site/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { changelogEntries } from "@/lib/changelog";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Changelog",
  description:
    "Development changelog for BOYFINITY Hub. Entries record work present in the repository, not a deployed release feed.",
  path: "/changelog",
});

export default function ChangelogPage() {
  return (
    <>
      <PageHeader
        eyebrow="Changelog"
        title="Development changelog"
        description="What changed in the repository, in order. These entries describe development progress. They are not marketing releases for a deployed service."
      />

      <div className="shell py-12 sm:py-16">
        <Notice title="Development entries, not release notes">
          The platform is a preview. An entry can describe frontend or backend work that has no
          deployed counterpart yet.
        </Notice>

        {changelogEntries.length > 0 ? (
          <ol className="mt-10 border-t border-border-subtle">
            {changelogEntries.map((entry) => (
              <li key={entry.slug} className="border-b border-border-subtle py-8">
                <article>
                  <div className="flex flex-wrap items-center gap-3">
                    <time dateTime={entry.date} className="font-mono text-xs text-text-muted">
                      {entry.date}
                    </time>
                    <Badge tone="accent">{entry.label}</Badge>
                  </div>
                  <h2 className="mt-3 text-xl font-semibold tracking-[-0.01em] text-text-primary">
                    <Link
                      href={`/changelog/${entry.slug}`}
                      className="rounded-sm transition-colors hover:text-purple-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                    >
                      {entry.title}
                    </Link>
                  </h2>
                  <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-text-secondary">
                    {entry.summary}
                  </p>
                  <Link
                    href={`/changelog/${entry.slug}`}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-purple-text transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                  >
                    Read entry
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-10">
            <EmptyState
              icon={ScrollText}
              title="No entries yet"
              description="The changelog is published by hand for now. No entry has been written for this repository."
            />
          </div>
        )}
      </div>
    </>
  );
}

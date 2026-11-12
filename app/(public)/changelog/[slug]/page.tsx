import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { changelogEntries, getChangelogEntry, type ChangeKind } from "@/lib/changelog";
import { pageMetadata } from "@/lib/metadata";

const KIND_META: Record<ChangeKind, { label: string; tone: BadgeTone }> = {
  added: { label: "Added", tone: "success" },
  changed: { label: "Changed", tone: "info" },
  fixed: { label: "Fixed", tone: "accent" },
  security: { label: "Security", tone: "warning" },
  notes: { label: "Notes", tone: "neutral" },
};

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return changelogEntries.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry)
    return pageMetadata({
      title: "Entry not found",
      description: "",
      path: "/changelog",
      noIndex: true,
    });

  return pageMetadata({
    title: entry.title,
    description: entry.summary,
    path: `/changelog/${entry.slug}`,
  });
}

export default async function ChangelogEntryPage({ params }: PageProps) {
  const { slug } = await params;
  const entry = getChangelogEntry(slug);
  if (!entry) notFound();

  return (
    <>
      <div className="border-b border-border-subtle bg-bg-secondary">
        <div className="shell py-12 sm:py-16">
          <Link
            href="/changelog"
            className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            Changelog
          </Link>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <time dateTime={entry.date} className="font-mono text-xs text-text-muted">
              {entry.date}
            </time>
            <Badge tone="accent">{entry.label}</Badge>
          </div>
          <h1 className="mt-3 max-w-[24ch] text-balance text-3xl font-semibold tracking-[-0.025em] text-text-primary sm:text-4xl">
            {entry.title}
          </h1>
          <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-text-secondary">
            {entry.summary}
          </p>
        </div>
      </div>

      <div className="shell py-12 sm:py-16">
        <div className="max-w-[760px]">
          <h2 className="text-sm font-semibold text-text-primary">Changes</h2>
          <ul className="mt-4 border-t border-border-subtle">
            {entry.changes.map((change) => {
              const meta = KIND_META[change.kind];
              return (
                <li
                  key={`${change.kind}-${change.text}`}
                  className="flex flex-col gap-2 border-b border-border-subtle py-4 sm:flex-row sm:items-start sm:gap-6"
                >
                  <span className="w-24 shrink-0">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </span>
                  <p className="text-sm leading-relaxed text-text-secondary">{change.text}</p>
                </li>
              );
            })}
          </ul>

          <p className="mt-8 text-xs leading-relaxed text-text-muted">
            Changelog entries are written by hand. For the current availability of every surface,
            see{" "}
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

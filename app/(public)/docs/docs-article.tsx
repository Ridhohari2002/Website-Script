import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { getAdjacentDocs } from "@/lib/docs";

export function DocsArticle({
  title,
  description,
  slug,
  children,
}: {
  title: string;
  description: string;
  slug: string;
  children: ReactNode;
}) {
  const { previous, next } = getAdjacentDocs(slug);

  return (
    <article>
      <header className="border-b border-border-subtle pb-8">
        <p className="text-[11px] font-medium tracking-[0.14em] text-purple-text">Documentation</p>
        <h1 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.025em] text-text-primary sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 max-w-[68ch] text-sm leading-relaxed text-text-secondary">
          {description}
        </p>
      </header>

      <div className="mt-8">{children}</div>

      {previous || next ? (
        <nav
          aria-label="Documentation pagination"
          className="mt-14 grid gap-3 border-t border-border-subtle pt-6 sm:grid-cols-2"
        >
          {previous ? (
            <Link
              href={previous.href}
              className="group rounded-md border border-border-default px-4 py-3 transition-colors hover:border-border-strong hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            >
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <ArrowLeft aria-hidden="true" className="size-3.5" />
                Previous
              </span>
              <span className="mt-1.5 block text-sm font-medium text-text-primary">
                {previous.title}
              </span>
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          {next ? (
            <Link
              href={next.href}
              className="rounded-md border border-border-default px-4 py-3 text-right transition-colors hover:border-border-strong hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus sm:col-start-2"
            >
              <span className="flex items-center justify-end gap-1.5 text-xs text-text-muted">
                Next
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </span>
              <span className="mt-1.5 block text-sm font-medium text-text-primary">
                {next.title}
              </span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}

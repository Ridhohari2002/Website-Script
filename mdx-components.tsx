import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ReactNode } from "react";

function Callout({ children }: { children?: ReactNode }) {
  return (
    <aside className="my-6 border-l-2 border-purple-border bg-bg-surface px-4 py-3 text-sm text-text-secondary">
      {children}
    </aside>
  );
}

/**
 * Documentation typography. Uses the same tokens as the rest of the site so MDX
 * never introduces a second visual language.
 */
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: ({ children }) => (
      <h1 className="text-balance text-3xl font-semibold tracking-[-0.02em] text-text-primary">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-12 border-b border-border-subtle pb-3 text-xl font-semibold text-text-primary">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-8 text-base font-semibold text-text-primary">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="mt-4 text-[15px] leading-7 text-text-secondary">{children}</p>
    ),
    a: ({ href = "", children }) => (
      <Link
        href={href}
        className="rounded-sm text-purple-text underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-purple-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        {children}
      </Link>
    ),
    ul: ({ children }) => (
      <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-7 text-text-secondary">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-[15px] leading-7 text-text-secondary">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-1 marker:text-text-muted">{children}</li>,
    code: ({ children }) => (
      <code className="rounded-xs border border-border-default bg-bg-surface px-1.5 py-0.5 font-mono text-[0.85em] text-text-primary">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="mt-5 overflow-x-auto rounded-md border border-border-default bg-bg-input p-4 font-mono text-xs leading-6 text-text-primary">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div
        role="region"
        aria-label="Scrollable documentation table"
        tabIndex={0}
        className="mt-5 w-full overflow-x-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
      >
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border-default">{children}</thead>,
    th: ({ children }) => (
      <th scope="col" className="px-3 py-2.5 text-[11px] font-medium tracking-wide text-text-muted">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-border-subtle px-3 py-3 text-text-secondary">{children}</td>
    ),
    hr: () => <hr className="my-8 border-border-subtle" />,
    blockquote: ({ children }) => (
      <blockquote className="mt-4 border-l-2 border-border-strong pl-4 italic text-text-secondary">
        {children}
      </blockquote>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-text-primary">{children}</strong>
    ),
    Callout,
    ...components,
  };
}

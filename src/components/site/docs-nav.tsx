"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { docs } from "@/lib/docs";
import { cn } from "@/lib/cn";

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="lg:sticky lg:top-24">
      <p className="text-[11px] font-medium tracking-[0.14em] text-text-muted">Documentation</p>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 lg:flex-col lg:gap-1">
        {docs.map((doc) => {
          const active = pathname === doc.href;
          return (
            <li key={doc.slug}>
              <Link
                href={doc.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-sm py-1.5 text-sm transition-colors lg:border-l lg:pl-3",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
                  active
                    ? "text-text-primary lg:border-purple-border"
                    : "text-text-secondary hover:text-text-primary lg:border-border-subtle",
                )}
              >
                {doc.title}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 hidden border-t border-border-subtle pt-4 text-xs leading-relaxed text-text-muted lg:block">
        Docs describe the repository as it exists, not the planned product.
      </p>
    </nav>
  );
}

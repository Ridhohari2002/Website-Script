import Link from "next/link";

import { SITE_NAME } from "@/lib/site";

import { Wordmark } from "./wordmark";

const PRODUCT_LINKS = [
  { href: "/catalog", label: "Catalog" },
  { href: "/pricing", label: "Pricing" },
] as const;

const RESOURCE_LINKS = [
  { href: "/docs", label: "Documentation" },
  { href: "/changelog", label: "Changelog" },
  { href: "/announcements", label: "Announcements" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border-subtle bg-bg-secondary">
      <div className="shell grid gap-10 py-12 md:grid-cols-[1.4fr_1fr_1fr] md:gap-8">
        <div>
          <Wordmark />
          <p className="mt-4 max-w-[36ch] text-sm leading-relaxed text-text-secondary">
            A development preview of a script catalog and access-control platform. Discord sign-in
            is available; access keys, subscriptions, and payments are not.
          </p>
        </div>

        <nav aria-label="Footer product" className="text-sm">
          <h2 className="text-[11px] font-medium tracking-wide text-text-muted">Product</h2>
          <ul className="mt-4 space-y-2.5">
            {PRODUCT_LINKS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-8 items-center rounded-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Footer resources" className="text-sm">
          <h2 className="text-[11px] font-medium tracking-wide text-text-muted">Resources</h2>
          <ul className="mt-4 space-y-2.5">
            {RESOURCE_LINKS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-8 items-center rounded-sm text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="border-t border-border-subtle">
        <div className="shell flex flex-col gap-2 py-5 text-xs text-text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>{SITE_NAME} · Development preview</p>
          <p className="font-mono">No production deployment</p>
        </div>
      </div>
    </footer>
  );
}

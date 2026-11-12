"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { publicNavigation } from "@/lib/site";
import { cn } from "@/lib/cn";

import { AuthNavView, useAuthNav } from "./auth-nav";
import { Wordmark } from "./wordmark";

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const auth = useAuthNav();

  return (
    <header className="sticky top-0 z-40 border-b border-border-subtle bg-bg-primary">
      <div className="shell flex h-16 items-center justify-between gap-6 lg:h-[72px]">
        <Wordmark />

        <nav aria-label="Primary" className="hidden items-center gap-6 lg:flex">
          {publicNavigation.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-sm py-2 text-sm transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-4 focus-visible:ring-offset-bg-primary",
                  active ? "text-text-primary" : "text-text-secondary hover:text-text-primary",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <AuthNavView
            state={auth.state}
            pathname={pathname}
            signingOut={auth.signingOut}
            error={auth.error}
            onSignOut={auth.signOut}
          />
          <Link
            href="/catalog"
            className={cn(
              "inline-flex h-10 items-center rounded-md border border-border-strong px-3.5 text-sm font-semibold text-text-primary",
              "transition-colors duration-150 hover:bg-bg-hover",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary",
            )}
          >
            Browse catalog
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
          aria-controls="site-navigation-dialog"
          className="inline-flex size-11 items-center justify-center rounded-sm border border-border-default text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus lg:hidden"
        >
          <Menu aria-hidden="true" className="size-4" />
        </button>
      </div>

      <Dialog
        id="site-navigation-dialog"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title="Navigation"
      >
        <nav aria-label="Mobile" className="flex flex-col">
          {publicNavigation.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-sm border-b border-border-subtle py-3 text-sm transition-colors hover:text-text-primary",
                  active ? "text-text-primary" : "text-text-secondary",
                )}
              >
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/catalog"
            onClick={() => setMenuOpen(false)}
            className="mt-4 inline-flex h-11 items-center justify-center rounded-md border border-purple-border bg-purple-primary px-4 text-sm font-semibold text-white"
          >
            Browse catalog
          </Link>
        </nav>

        <div className="mt-4 border-t border-border-subtle pt-4">
          <AuthNavView
            state={auth.state}
            pathname={pathname}
            signingOut={auth.signingOut}
            error={auth.error}
            onSignOut={async () => {
              const signedOut = await auth.signOut();
              if (signedOut) setMenuOpen(false);
            }}
            onNavigate={() => setMenuOpen(false)}
            variant="mobile"
          />
        </div>
      </Dialog>
    </header>
  );
}

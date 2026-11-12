import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { pageSessionGate } from "@/modules/auth/page-access";
import { getPageSession } from "@/modules/auth/page-session.server";

/**
 * Protected route group. The layout is the first server-side gate; each page
 * also re-checks before rendering account data.
 *
 * `cookies()` already makes this segment dynamic. The explicit exports keep the
 * authenticated surface out of static generation and shared caches.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AuthenticatedLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getPageSession();
  const gate = pageSessionGate(session, "/dashboard");
  if (gate.status === "login") redirect(gate.location);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only rounded-md border border-border-strong bg-bg-elevated px-4 py-2 text-sm text-text-primary focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

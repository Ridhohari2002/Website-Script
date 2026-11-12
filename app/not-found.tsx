import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="shell flex flex-1 flex-col justify-center py-24">
        <p className="font-mono text-[11px] tracking-[0.14em] text-purple-text">404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-text-primary sm:text-4xl">
          Page not found
        </h1>
        <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-secondary">
          The page you asked for does not exist. It may have moved, or it may be part of a section
          that has not been published yet.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/" className={buttonVariants()}>
            Back to home
          </Link>
          <Link href="/docs" className={buttonVariants({ variant: "secondary" })}>
            Read the docs
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

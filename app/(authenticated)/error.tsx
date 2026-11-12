"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button, buttonVariants } from "@/components/ui/button";

export default function AuthenticatedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep the digest in the console; never render database or stack details.
    console.error("Authenticated page failed", error);
  }, [error]);

  return (
    <section
      aria-labelledby="authenticated-error-title"
      className="shell flex min-h-[60vh] flex-col justify-center py-20"
    >
      <p className="font-mono text-[11px] tracking-[0.14em] text-text-muted">Account</p>
      <h1
        id="authenticated-error-title"
        className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-text-primary"
      >
        The account page could not be loaded
      </h1>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-secondary">
        The session check did not complete. This is not treated as a successful sign-in. Try again,
        or return to the home page.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link href="/" className={buttonVariants({ variant: "secondary" })}>
          Go home
        </Link>
      </div>
    </section>
  );
}

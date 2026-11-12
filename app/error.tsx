"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the digest in the console; the UI stays calm and non-technical.
    console.error("Unhandled application error", error);
  }, [error]);

  return (
    <main className="shell flex min-h-screen flex-col justify-center py-20">
      <p className="font-mono text-[11px] tracking-[0.14em] text-text-muted">Error</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-text-primary">
        Something went wrong
      </h1>
      <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-secondary">
        The page could not be rendered. Try again, or return to the home page if the problem
        continues.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}

import Link from "next/link";

import { cn } from "@/lib/cn";

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="BOYFINITY Hub home"
      className={cn(
        "inline-flex items-baseline gap-1.5 rounded-sm text-sm font-semibold tracking-tight text-text-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-4 focus-visible:ring-offset-bg-primary",
        className,
      )}
    >
      <span className="tracking-[0.08em]">BOYFINITY</span>
      <span className="font-normal tracking-normal text-text-muted">Hub</span>
    </Link>
  );
}

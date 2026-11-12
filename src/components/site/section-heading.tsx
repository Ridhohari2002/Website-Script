import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type SectionHeadingProps = {
  index?: string;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  className?: string;
};

export function SectionHeading({
  index,
  eyebrow,
  title,
  description,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("max-w-[62ch]", className)}>
      {index || eyebrow ? (
        <p className="flex items-center gap-3 text-[11px] font-medium tracking-[0.14em] text-text-muted">
          {index ? <span className="font-mono text-purple-text">{index}</span> : null}
          {eyebrow ? <span>{eyebrow}</span> : null}
        </p>
      ) : null}
      <h2 className="mt-3 text-balance text-2xl font-semibold leading-snug tracking-[-0.015em] text-text-primary sm:text-3xl">
        {title}
      </h2>
      {description ? (
        <div className="mt-3 text-base leading-relaxed text-text-secondary">{description}</div>
      ) : null}
    </div>
  );
}

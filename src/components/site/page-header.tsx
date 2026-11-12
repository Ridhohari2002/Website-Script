import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("border-b border-border-subtle bg-bg-secondary", className)}>
      <div className="shell py-14 sm:py-16">
        {eyebrow ? (
          <p className="text-[11px] font-medium tracking-[0.14em] text-purple-text">{eyebrow}</p>
        ) : null}
        <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-[62ch]">
            <h1 className="text-balance text-3xl font-semibold leading-tight tracking-[-0.02em] text-text-primary sm:text-4xl">
              {title}
            </h1>
            {description ? (
              <div className="mt-4 text-base leading-relaxed text-text-secondary">
                {description}
              </div>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

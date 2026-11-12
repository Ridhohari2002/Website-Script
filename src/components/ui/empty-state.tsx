import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed border-border-default bg-bg-secondary px-6 py-12 text-center",
        className,
      )}
    >
      <Icon aria-hidden="true" className="mx-auto size-5 text-text-muted" strokeWidth={1.75} />
      <h2 className="mt-4 text-base font-semibold text-text-primary">{title}</h2>
      <div className="mx-auto mt-2 max-w-[52ch] text-sm leading-relaxed text-text-secondary">
        {description}
      </div>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

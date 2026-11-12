import type { ReactNode } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export type NoticeTone = "neutral" | "warning" | "accent";

const TONE_BADGE: Record<NoticeTone, { tone: BadgeTone; label: string }> = {
  neutral: { tone: "neutral", label: "Note" },
  warning: { tone: "warning", label: "Not yet available" },
  accent: { tone: "accent", label: "Preview" },
};

export type NoticeProps = {
  tone?: NoticeTone;
  title: string;
  children: ReactNode;
  className?: string;
  label?: string;
};

export function Notice({ tone = "neutral", title, children, className, label }: NoticeProps) {
  const badge = TONE_BADGE[tone];
  return (
    <div
      role="note"
      className={cn(
        "rounded-md border border-border-default bg-bg-secondary px-5 py-4",
        tone === "warning" && "border-warning/30",
        tone === "accent" && "border-purple-border/60",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{label ?? badge.label}</Badge>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="mt-2 text-sm leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

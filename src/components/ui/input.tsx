import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, type = "text", ...props }: InputProps) {
  return (
    <input
      type={type}
      className={cn(
        "h-11 w-full rounded-sm border border-border-default bg-bg-input px-3 text-sm text-text-primary",
        "placeholder:text-text-muted",
        "transition-colors duration-150 hover:border-border-strong",
        "focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus/40",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/30",
        className,
      )}
      {...props}
    />
  );
}

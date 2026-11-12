"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  id?: string;
};

/**
 * Thin wrapper over the native dialog element: the browser supplies focus
 * trapping, Escape handling, and an inert background for free.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  id,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      id={id}
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        if (event.target === dialogRef.current) onOpenChange(false);
      }}
      className={cn(
        "m-auto w-[min(92vw,28rem)] rounded-lg border border-border-strong bg-bg-elevated p-0 text-text-primary",
        "backdrop:bg-black/70",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-sm text-text-secondary">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close dialog"
          className="-m-2 inline-flex size-11 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer ? <div className="border-t border-border-subtle px-5 py-3">{footer}</div> : null}
    </dialog>
  );
}

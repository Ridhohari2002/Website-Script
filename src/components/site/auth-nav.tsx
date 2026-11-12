"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  accountLabel,
  loadAuthState,
  logoutOutcome,
  submitLogout,
  type AuthNavState,
} from "@/lib/auth-client";
import { loginPathFor } from "@/modules/auth/page-access";

/**
 * One session fetch per header mount. The public pages stay static because the
 * personalized state arrives after hydration.
 */
export function useAuthNav() {
  const [state, setState] = useState<AuthNavState>({ status: "loading" });
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void loadAuthState(fetch, controller.signal).then((next) => {
      if (active) setState(next);
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const signOut = useCallback(async (): Promise<boolean> => {
    if (signingOut) return false;
    setSigningOut(true);
    setError(null);

    const result = await submitLogout();
    const outcome = logoutOutcome(result);
    if (outcome.navigate) {
      setState({ status: "anonymous" });
      setSigningOut(false);
      router.push("/");
      router.refresh();
      return true;
    }

    setSigningOut(false);
    setError(outcome.message);
    return false;
  }, [router, signingOut]);

  return { state, signingOut, error, signOut };
}

export type AuthNavViewProps = {
  state: AuthNavState;
  pathname: string;
  signingOut: boolean;
  error: string | null;
  onSignOut: () => void | Promise<unknown>;
  onNavigate?: () => void;
  variant?: "desktop" | "mobile";
};

function Avatar({ avatarUrl, label }: { avatarUrl: string | null; label: string }) {
  if (avatarUrl) {
    return (
      // Discord's CDN URL is built server-side from a validated hash.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        width={24}
        height={24}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="size-6 shrink-0 rounded-full border border-border-default"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-bg-elevated text-[11px] font-semibold text-text-secondary"
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

export function AuthNavView({
  state,
  pathname,
  signingOut,
  error,
  onSignOut,
  onNavigate,
  variant = "desktop",
}: AuthNavViewProps) {
  const mobile = variant === "mobile";
  const controlClass = mobile ? "w-full justify-center" : "";

  if (state.status === "loading") {
    return (
      <div className={cn("flex items-center", mobile ? "w-full" : "")} aria-busy="true">
        <span
          className={cn("h-10 animate-pulse rounded-md bg-bg-elevated", mobile ? "w-full" : "w-24")}
        />
        <span className="sr-only">Checking account status</span>
      </div>
    );
  }

  if (state.status === "anonymous") {
    return (
      <a
        href={loginPathFor(pathname)}
        onClick={onNavigate}
        className={cn(buttonVariants({ variant: "secondary", size: "md" }), controlClass)}
      >
        {mobile ? "Sign in with Discord" : "Sign in"}
      </a>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className={cn(buttonVariants({ variant: "secondary", size: "md" }), controlClass)}
      >
        Account
      </Link>
    );
  }

  const label = accountLabel(state.user.username);

  return (
    <div className={cn("flex items-center gap-2", mobile && "flex-col items-stretch gap-3")}>
      <div className={cn("flex items-center gap-2", mobile && "flex-col items-stretch gap-2")}>
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-current={pathname === "/dashboard" ? "page" : undefined}
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-md border border-border-default px-2.5 text-sm text-text-primary",
            "transition-colors duration-150 hover:border-border-strong hover:bg-bg-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary",
            mobile && "justify-start",
          )}
        >
          <Avatar avatarUrl={state.user.avatarUrl} label={label} />
          <span className="max-w-[9rem] truncate">{label}</span>
        </Link>
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className={cn(
            buttonVariants({ variant: "ghost", size: "md" }),
            "gap-2 text-text-secondary",
            controlClass,
          )}
        >
          <LogOut aria-hidden="true" className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          className={cn("text-xs leading-snug text-danger", mobile ? "" : "max-w-[15rem]")}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

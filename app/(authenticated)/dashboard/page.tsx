import { CreditCard, KeyRound } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/site/page-header";
import { SectionHeading } from "@/components/site/section-heading";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { pageMetadata } from "@/lib/metadata";
import { accountLabel } from "@/lib/auth-client";
import { pageSessionGate } from "@/modules/auth/page-access";
import { getPageSession } from "@/modules/auth/page-session.server";

export const metadata = pageMetadata({
  title: "Dashboard",
  description:
    "The authenticated BOYFINITY Hub account shell. It shows the current Discord session and honest empty states for features that are not implemented yet.",
  path: "/dashboard",
  noIndex: true,
});

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const AVAILABLE_NOW = [
  "Discord sign-in through the existing OAuth callback.",
  "A server-verified session on every protected page render.",
  "Sign-out from any page using the existing logout endpoint.",
] as const;

export default async function DashboardPage() {
  const session = await getPageSession();
  const gate = pageSessionGate(session, "/dashboard");
  if (gate.status === "login") redirect(gate.location);

  const label = accountLabel(gate.session.user.username);

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title={`Welcome, ${label}`}
        description="You are signed in with Discord. This page is the authentication foundation for the account area; key and subscription management arrive in later phases."
        actions={
          <Link href="/docs/platform-status" className={buttonVariants({ variant: "secondary" })}>
            Platform status
          </Link>
        }
      />

      <div className="shell py-12 sm:py-16">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Account</CardTitle>
                  <CardDescription>
                    Identity comes from the server session, not from client state.
                  </CardDescription>
                </div>
                <Badge tone="success">Authenticated</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-5 sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] font-medium tracking-wide text-text-muted">
                    Display name
                  </dt>
                  <dd className="mt-1 text-sm text-text-primary">{label}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium tracking-wide text-text-muted">
                    Sign-in method
                  </dt>
                  <dd className="mt-1 text-sm text-text-primary">Discord OAuth</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium tracking-wide text-text-muted">
                    Account status
                  </dt>
                  <dd className="mt-1 text-sm text-text-primary">Active</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium tracking-wide text-text-muted">
                    Session idle expiry
                  </dt>
                  <dd className="mt-1 font-mono text-xs text-text-secondary">
                    {formatExpiry(gate.session.expiresAt)}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Available now</CardTitle>
              <CardDescription>
                This shell proves the session boundary. It does not expose account data that does
                not exist yet.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {AVAILABLE_NOW.map((item) => (
                  <li key={item} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                    <span
                      aria-hidden="true"
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-purple-text"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        <section className="mt-14">
          <SectionHeading
            eyebrow="Not implemented"
            title="Keys and subscriptions"
            description="These surfaces are reserved for later phases. They show empty states because no key, subscription, or purchase API is connected."
          />
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <EmptyState
              icon={KeyRound}
              title="No access keys"
              description="Key issuance, device binding, and activation are not built. Nothing is listed here, and no key counts are invented."
            />
            <EmptyState
              icon={CreditCard}
              title="No subscription"
              description="No plan is for sale and no payment provider is integrated. Subscription and purchase history will appear here when those systems exist."
            />
          </div>
        </section>

        <p className="mt-12 border-t border-border-subtle pt-6 text-xs leading-relaxed text-text-muted">
          An authenticated session check counts as activity, so loading the site while signed in can
          extend the idle session window. Checks are throttled, and the absolute session expiration
          is always enforced. The expiry above reflects the value verified during page rendering and
          may update after the next session check.
        </p>
      </div>
    </>
  );
}

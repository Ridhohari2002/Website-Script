import { ArrowRight, CircleSlash2 } from "lucide-react";
import Link from "next/link";

import { Notice } from "@/components/site/notice";
import { PageHeader } from "@/components/site/page-header";
import { SectionHeading } from "@/components/site/section-heading";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { pageMetadata } from "@/lib/metadata";
import { plans, plannedPricingFields } from "@/lib/plans";

export const metadata = pageMetadata({
  title: "Pricing",
  description:
    "Pricing for BOYFINITY Hub. No plans or prices have been published, and no checkout is available.",
  path: "/pricing",
});

export default function PricingPage() {
  const hasPlans = plans.length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Pricing"
        title="Pricing"
        description="Plans will be published from verified plan records. Until then, this page states what is missing instead of presenting placeholder prices as real."
        actions={
          <Link href="/changelog" className={buttonVariants({ variant: "secondary" })}>
            View changelog
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
      />

      <div className="shell py-12 sm:py-16">
        <Notice tone="warning" title="Pricing has not been published">
          No plan, price, billing interval, or entitlement has been approved for display. There is
          no checkout, and nothing on this page can be purchased.
        </Notice>

        <div className="mt-10">
          {hasPlans ? (
            <div className="grid gap-6 md:grid-cols-3">
              {plans.map((plan) => (
                <div
                  key={plan.slug}
                  className="rounded-md border border-border-default bg-bg-surface p-6"
                >
                  <h2 className="text-base font-semibold text-text-primary">{plan.name}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    {plan.description}
                  </p>
                  <p className="mt-6 text-2xl font-semibold text-text-primary">{plan.priceLabel}</p>
                  <p className="mt-1 text-xs text-text-muted">{plan.billingInterval}</p>
                  <ul className="mt-6 space-y-2 border-t border-border-subtle pt-4 text-sm text-text-secondary">
                    {plan.entitlements.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p className="mt-6 text-xs text-text-muted">
                    {plan.available ? "Available" : "Not available"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={CircleSlash2}
              title="No plans are available"
              description="The plans table is the approved pricing source. It has no published records yet, so there are no tiers to show and no purchase action to take."
              action={
                <Link
                  href="/docs/platform-status"
                  className={buttonVariants({ variant: "secondary" })}
                >
                  Check platform status
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              }
            />
          )}
        </div>

        <section className="mt-16 border-t border-border-subtle pt-10">
          <SectionHeading
            eyebrow="What will be shown"
            title="The fields behind a plan"
            description="When verified plan data exists, the pricing page will render these fields directly from the plans table. No values are invented here."
          />
          <div className="mt-6">
            <Table scrollLabel="Planned pricing fields">
              <TableCaption>
                Field reference only. No plan values are published in this preview.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Meaning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plannedPricingFields.map((item) => (
                  <TableRow key={item.field}>
                    <TableCell className="w-48 font-medium text-text-primary">
                      {item.field}
                    </TableCell>
                    <TableCell>{item.description}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="mt-12 border-t border-border-subtle pt-8">
          <h2 className="text-base font-semibold text-text-primary">Payments</h2>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-text-secondary">
            Payment provider integration is deferred. No provider is available in the public site,
            no credentials are used in the browser, and no transaction can be started. Pricing will
            remain an information page until that work is separately approved.
          </p>
        </section>
      </div>
    </>
  );
}

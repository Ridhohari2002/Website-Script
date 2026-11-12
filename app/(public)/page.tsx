import {
  ArrowRight,
  BookOpen,
  CreditCard,
  KeyRound,
  Layers,
  ListChecks,
  MonitorSmartphone,
  Plus,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import Link from "next/link";

import { SectionHeading } from "@/components/site/section-heading";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { platformSurfaces } from "@/lib/catalog";
import { pageMetadata } from "@/lib/metadata";
import { SITE_DESCRIPTION } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Script catalog and access platform",
  description: SITE_DESCRIPTION,
  path: "/",
});

const FOUNDATION_FACTS = [
  { label: "Runtime", value: "Next.js 16" },
  { label: "Database", value: "PostgreSQL" },
  { label: "Identity", value: "Discord OAuth" },
  { label: "API surface", value: "One entry point" },
];

const FEATURES = [
  {
    icon: ShieldCheck,
    title: "Discord identity",
    description:
      "Accounts are anchored to Discord. Sessions are opaque, hashed on the server, and revocable. The backend exists; the account interface does not.",
    status: "Backend ready",
  },
  {
    icon: KeyRound,
    title: "Device-bound access",
    description:
      "The planned key model binds one key to one device at a time. Activation, validation, and reset are specified but not implemented.",
    status: "Planned",
  },
  {
    icon: CreditCard,
    title: "Subscriptions",
    description:
      "Plans will come from a `plans` table and grant access through the key system. No plan is published and no payment provider is connected.",
    status: "Planned",
  },
  {
    icon: Layers,
    title: "Catalog",
    description:
      "Published scripts will appear as structured listings with game, access type, and update metadata. No catalog data exists yet.",
    status: "Not connected",
  },
  {
    icon: ListChecks,
    title: "Auditable moderation",
    description:
      "Ban, reversal, and reactivation actions are designed around explicit permissions and audit rows written with server-derived identity.",
    status: "Specified",
  },
  {
    icon: MonitorSmartphone,
    title: "Responsive by default",
    description:
      "The public site is built from one set of tokens and primitives, with keyboard focus states and reduced-motion support.",
    status: "In preview",
  },
];

const FAQ_ITEMS = [
  {
    question: "Is the catalog live?",
    answer:
      "No. The catalog page exists, but no scripts have been published and no catalog API is connected. The page shows an explicit empty state instead of sample products.",
  },
  {
    question: "Can I create an account or sign in?",
    answer:
      "Yes, sign-in is available through Discord. Signed-in users can open a minimal dashboard shell that confirms the current session. Key, subscription, and profile management are not available yet.",
  },
  {
    question: "Can I buy a subscription?",
    answer:
      "No. Pricing has not been published, no plan is for sale, and no payment provider is integrated. The pricing page explains what will be shown once real data exists.",
  },
  {
    question: "What can I use today?",
    answer:
      "The public pages and the documentation. The platform status page lists every surface and its real state.",
  },
];

export default function HomePage() {
  return (
    <>
      <section className="border-b border-border-subtle">
        <div className="shell grid gap-12 py-16 sm:py-20 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end lg:gap-16 lg:py-28">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-medium tracking-[0.14em] text-purple-text">
              <span
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full bg-purple-text"
              />
              Development preview
            </p>
            <h1 className="mt-5 max-w-[18ch] text-balance text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.035em] text-text-primary sm:text-6xl lg:text-[4rem]">
              A controlled catalog for game scripts.
            </h1>
            <p className="mt-6 max-w-[56ch] text-base leading-relaxed text-text-secondary sm:text-lg">
              BOYFINITY Hub is being built as one place to publish scripts, bind access to a device,
              and manage subscriptions — with Discord identity and an auditable moderation workflow.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/catalog" className={buttonVariants({ size: "lg" })}>
                Browse the catalog
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
              <Link
                href="/docs/platform-status"
                className={buttonVariants({ variant: "secondary", size: "lg" })}
              >
                <ListChecks aria-hidden="true" className="size-4" />
                See what works
              </Link>
            </div>
            <p className="mt-6 text-xs leading-relaxed text-text-muted">
              Public preview only. Accounts, access keys, subscriptions, and checkout are not
              available.
            </p>
          </div>

          <aside
            aria-label="Platform surfaces"
            className="rounded-md border border-border-default bg-bg-surface"
          >
            <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-5 py-3.5">
              <h2 className="text-sm font-semibold text-text-primary">Platform surfaces</h2>
              <Badge tone="accent">Preview</Badge>
            </div>
            <ul className="divide-y divide-border-subtle">
              {platformSurfaces.map((surface) => (
                <li key={surface.name} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-text-primary">{surface.name}</span>
                    <Badge tone={surface.tone}>{surface.status}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                    {surface.description}
                  </p>
                </li>
              ))}
            </ul>
            <div className="border-t border-border-subtle px-5 py-3">
              <Link
                href="/docs/platform-status"
                className="inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-purple-text transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                Full status table
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            </div>
          </aside>
        </div>
      </section>

      <section
        aria-label="Foundation facts"
        className="border-b border-border-subtle bg-bg-secondary"
      >
        <dl className="shell grid grid-cols-2 gap-y-6 py-8 sm:grid-cols-4 sm:divide-x sm:divide-border-subtle sm:py-0">
          {FOUNDATION_FACTS.map((fact) => (
            <div key={fact.label} className="sm:px-6 sm:py-7 sm:first:pl-0 sm:last:pr-0">
              <dt className="text-[11px] tracking-wide text-text-muted">{fact.label}</dt>
              <dd className="mt-1.5 text-sm font-medium text-text-primary">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="border-b border-border-subtle">
        <div className="shell grid gap-10 py-16 sm:py-20 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-16">
          <p className="text-[11px] font-medium tracking-[0.14em] text-text-muted">The platform</p>
          <div>
            <p className="max-w-[62ch] text-balance text-2xl font-medium leading-snug tracking-[-0.015em] text-text-primary sm:text-[1.75rem]">
              Script distribution, device-bound access, and licensing belong in one system — not
              spread across a storefront, a license bot, and a spreadsheet.
            </p>
            <div className="mt-8 grid gap-6 border-t border-border-subtle pt-8 sm:grid-cols-2">
              <p className="text-sm leading-relaxed text-text-secondary">
                BOYFINITY Hub is being built as that single system. The public site explains the
                product and publishes documentation. The API owns identity, authorization, and audit
                records. The database holds the catalog, keys, and billing state.
              </p>
              <p className="text-sm leading-relaxed text-text-secondary">
                This preview is frontend-first. Pages that need data which does not exist yet say so
                plainly. Nothing is presented as purchasable, available, or complete until the
                underlying implementation exists and is verified.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Platform capabilities" className="border-b border-border-subtle">
        <div className="shell py-16 sm:py-20">
          <SectionHeading
            index="01"
            eyebrow="Capabilities"
            title="What the platform is designed to do"
            description="Each item states its real status. Only the public site is usable in this preview."
          />

          <div className="mt-10 grid gap-x-10 gap-y-8 border-t border-border-subtle pt-8 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="flex flex-col">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex size-9 items-center justify-center rounded-sm border border-border-default bg-bg-surface">
                      <Icon
                        aria-hidden="true"
                        className="size-[18px] text-purple-text"
                        strokeWidth={1.75}
                      />
                    </span>
                    <Badge
                      tone={
                        feature.status === "In preview"
                          ? "accent"
                          : feature.status === "Backend ready"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {feature.status}
                    </Badge>
                  </div>
                  <h3 className="mt-4 text-base font-semibold text-text-primary">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    {feature.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section aria-label="Catalog" className="border-b border-border-subtle bg-bg-secondary">
        <div className="shell grid gap-10 py-16 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start lg:gap-16">
          <div>
            <SectionHeading
              index="02"
              eyebrow="Catalog"
              title="No scripts have been published yet"
              description="The catalog will list only real entries from the script catalog. Until then, it stays empty rather than showing invented products, prices, or ratings."
            />
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/catalog"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                Open the catalog
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
              <Link href="/docs" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <BookOpen aria-hidden="true" className="size-3.5" />
                Read the overview
              </Link>
            </div>
          </div>
          <EmptyState
            icon={Terminal}
            title="Catalog is empty"
            description="A catalog API is not connected in this phase. Listings, game metadata, and access types will appear here once the backend provides them."
            className="bg-bg-primary"
          />
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="border-b border-border-subtle">
        <div className="shell grid gap-10 py-16 sm:py-20 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-16">
          <div>
            <p className="text-[11px] font-medium tracking-[0.14em] text-purple-text">03</p>
            <h2
              id="faq-heading"
              className="mt-3 text-2xl font-semibold tracking-[-0.015em] text-text-primary sm:text-3xl"
            >
              Straight answers
            </h2>
            <p className="mt-3 max-w-[36ch] text-sm leading-relaxed text-text-secondary">
              The preview is intentionally limited. These are the questions the site should answer
              without overstating anything.
            </p>
          </div>
          <div className="border-t border-border-subtle">
            {FAQ_ITEMS.map((item) => (
              <details key={item.question} className="group border-b border-border-subtle py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-sm text-sm font-medium text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <Plus
                    aria-hidden="true"
                    className="size-4 shrink-0 text-text-muted transition-transform duration-150 group-open:rotate-45"
                  />
                </summary>
                <p className="mt-3 max-w-[64ch] text-sm leading-relaxed text-text-secondary">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-border-subtle bg-bg-secondary">
        <div className="shell flex flex-col gap-8 py-16 sm:py-20 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-[56ch]">
            <p className="text-[11px] font-medium tracking-[0.14em] text-text-muted">
              Where to go next
            </p>
            <h2 className="mt-3 text-balance text-2xl font-semibold leading-snug tracking-[-0.015em] text-text-primary sm:text-3xl">
              Read the documentation before expecting a product.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
              The docs describe what exists, what does not, and how to run the project locally.
              There is no sign-up, checkout, or dashboard behind them.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/docs" className={buttonVariants()}>
              Start with the docs
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
            <Link href="/changelog" className={buttonVariants({ variant: "secondary" })}>
              View the changelog
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

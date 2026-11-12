import { ArrowRight, PackageOpen } from "lucide-react";
import Link from "next/link";

import { Notice } from "@/components/site/notice";
import { PageHeader } from "@/components/site/page-header";
import { SectionHeading } from "@/components/site/section-heading";
import { Badge } from "@/components/ui/badge";
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
import { catalogEntries } from "@/lib/catalog";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata({
  title: "Catalog",
  description:
    "The public script catalog for BOYFINITY Hub. No scripts have been published yet; this page shows an explicit empty state.",
  path: "/catalog",
});

const LISTING_FIELDS = [
  { field: "Title", description: "The published name of the script." },
  { field: "Game", description: "The game or experience the script targets." },
  { field: "Summary", description: "A short statement of what the script does." },
  { field: "Access", description: "Whether the listing is free or requires a subscription." },
  { field: "Updated", description: "The date the listing was last published or revised." },
];

export default function CatalogPage() {
  const hasEntries = catalogEntries.length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Script catalog"
        description="Published scripts, the game they target, and the access they require. The catalog is not connected to a data source in this phase."
        actions={
          <Link href="/docs/platform-status" className={buttonVariants({ variant: "secondary" })}>
            Platform status
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        }
      />

      <div className="shell py-12 sm:py-16">
        <Notice tone="warning" title="No catalog data is available">
          No catalog API is connected and no scripts have been published. This page does not show
          sample products, invented prices, ratings, or download counts.
        </Notice>

        <div className="mt-10">
          {hasEntries ? (
            <Table scrollLabel="Catalog listings">
              <TableCaption>Published scripts from the catalog.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Game</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogEntries.map((entry) => (
                  <TableRow key={entry.slug}>
                    <TableCell className="font-medium text-text-primary">{entry.title}</TableCell>
                    <TableCell>{entry.game}</TableCell>
                    <TableCell>
                      <Badge tone={entry.access === "free" ? "info" : "accent"}>
                        {entry.access === "free" ? "Free" : "Subscription"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.updatedAt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={PackageOpen}
              title="The catalog is empty"
              description={
                <>
                  Nothing is listed yet. When the catalog backend exists, published scripts will
                  appear here with their game, access type, and update date.{" "}
                  <Link
                    href="/docs"
                    className="rounded-sm text-purple-text underline decoration-border-strong underline-offset-4 hover:decoration-purple-text"
                  >
                    Read what exists today
                  </Link>
                  .
                </>
              }
              action={
                <Link
                  href="/docs/platform-status"
                  className={buttonVariants({ variant: "secondary" })}
                >
                  See the status table
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              }
            />
          )}
        </div>

        <section className="mt-16 border-t border-border-subtle pt-10">
          <SectionHeading
            eyebrow="Presentation model"
            title="How a listing will be structured"
            description="The public catalog uses a static presentation model until a catalog API exists. These are the fields the interface is built to show."
          />
          <div className="mt-6">
            <Table scrollLabel="Catalog listing fields">
              <TableCaption>This is a field reference, not a published product list.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Meaning</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {LISTING_FIELDS.map((item) => (
                  <TableRow key={item.field}>
                    <TableCell className="w-40 font-medium text-text-primary">
                      {item.field}
                    </TableCell>
                    <TableCell>{item.description}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </>
  );
}

export type ChangeKind = "added" | "changed" | "fixed" | "security" | "notes";

export interface ChangelogChange {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  slug: string;
  title: string;
  date: string;
  label: string;
  summary: string;
  changes: readonly ChangelogChange[];
}

/**
 * Development changelog. Every entry describes work that is actually present in
 * this repository; it is not a product-release feed for a deployed service.
 */
export const changelogEntries: readonly ChangelogEntry[] = [
  {
    slug: "public-site-foundation",
    title: "Public site foundation",
    date: "2026-11-12",
    label: "Phase 3A–3B",
    summary:
      "A public website built on the design system, with documentation and clearly marked unavailable states for catalog data, pricing, and accounts.",
    changes: [
      {
        kind: "added",
        text: "Design tokens extended into reusable button, input, card, badge, table, dialog, and empty-state primitives.",
      },
      {
        kind: "added",
        text: "Public landing, catalog, pricing, changelog, announcements, and documentation routes.",
      },
      {
        kind: "added",
        text: "Inter and Geist Mono through the Next.js font loader, Lucide icons, robots.txt, sitemap, and social metadata.",
      },
      {
        kind: "security",
        text: "Baseline security headers with a report-only Content Security Policy.",
      },
      {
        kind: "notes",
        text: "Accounts, access keys, subscriptions, and checkout are not part of this entry.",
      },
    ],
  },
  {
    slug: "project-foundation",
    title: "Project foundation",
    date: "2026-11-11",
    label: "Phase 1",
    summary:
      "The application shell, one API entry point, Discord OAuth backend, and the initial database migration.",
    changes: [
      {
        kind: "added",
        text: "Next.js App Router project with TypeScript, Tailwind CSS, and a single API catch-all route.",
      },
      {
        kind: "added",
        text: "Discord OAuth with PKCE, hashed server-side sessions, roles, CSRF checks, and rate limiting.",
      },
      {
        kind: "added",
        text: "Initial PostgreSQL migration covering users, sessions, roles, and audit records.",
      },
      {
        kind: "notes",
        text: "No deployment, payment integration, or public interface was included.",
      },
    ],
  },
];

export function getChangelogEntry(slug: string): ChangelogEntry | undefined {
  return changelogEntries.find((entry) => entry.slug === slug);
}

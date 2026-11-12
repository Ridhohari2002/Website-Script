import type { BadgeTone } from "@/components/ui/badge";

/**
 * Static presentation model for the public catalog. No catalog API exists yet,
 * so the list stays empty until a real data source is connected. Rendering code
 * already handles the populated shape, which keeps the eventual swap to the
 * `scripts` table a data change rather than a redesign.
 */
export interface CatalogEntry {
  slug: string;
  title: string;
  game: string;
  summary: string;
  access: "free" | "subscription";
  updatedAt: string;
}

export const catalogEntries: readonly CatalogEntry[] = [];

export interface PlatformSurface {
  name: string;
  description: string;
  status: string;
  tone: BadgeTone;
}

/**
 * Status language is deliberately literal. "Available" is never used for a
 * surface that only exists in the backend or the plan.
 */
export const platformSurfaces: readonly PlatformSurface[] = [
  {
    name: "Public website",
    description: "Catalog, pricing, changelog, announcements, and documentation shells.",
    status: "In preview",
    tone: "accent",
  },
  {
    name: "Discord accounts",
    description: "OAuth, server-side sessions, and role checks exist in the API only.",
    status: "No interface",
    tone: "warning",
  },
  {
    name: "Access keys",
    description: "Device binding and validation are specified but not implemented.",
    status: "Planned",
    tone: "neutral",
  },
  {
    name: "Subscriptions",
    description: "Plan data and payment flow are not connected to the public site.",
    status: "Planned",
    tone: "neutral",
  },
];

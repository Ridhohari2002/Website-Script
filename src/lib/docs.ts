export interface DocEntry {
  slug: string;
  href: string;
  title: string;
  description: string;
}

/**
 * Metadata-only documentation index. MDX content is loaded separately in a
 * server module so client navigation never bundles the documentation bodies.
 */
export const docs: readonly DocEntry[] = [
  {
    slug: "overview",
    href: "/docs",
    title: "Overview",
    description: "What BOYFINITY Hub is, what exists today, and what does not.",
  },
  {
    slug: "platform-status",
    href: "/docs/platform-status",
    title: "Platform status",
    description: "An honest status table for every surface in the product.",
  },
  {
    slug: "local-development",
    href: "/docs/local-development",
    title: "Local development",
    description: "Run the public site and checks on your own machine.",
  },
];

export function getDoc(slug: string): DocEntry | undefined {
  return docs.find((entry) => entry.slug === slug);
}

export function getAdjacentDocs(slug: string): {
  previous?: DocEntry;
  next?: DocEntry;
} {
  const index = docs.findIndex((entry) => entry.slug === slug);
  if (index === -1) return {};
  return {
    previous: index > 0 ? docs[index - 1] : undefined,
    next: index < docs.length - 1 ? docs[index + 1] : undefined,
  };
}

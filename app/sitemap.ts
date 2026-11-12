import type { MetadataRoute } from "next";

import { hasPublishedAnnouncements } from "@/lib/announcements";
import { changelogEntries } from "@/lib/changelog";
import { docs } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

const staticRoutes = [
  { path: "/", priority: 1, changeFrequency: "monthly" as const },
  { path: "/catalog", priority: 0.8, changeFrequency: "weekly" as const },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly" as const },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly" as const },
  { path: "/announcements", priority: 0.6, changeFrequency: "weekly" as const },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // A section that only holds labeled samples should not be advertised to crawlers.
  const routes = staticRoutes.filter(
    (route) => route.path !== "/announcements" || hasPublishedAnnouncements,
  );

  return [
    // Static pages have no reliable per-page modification date, so `lastModified`
    // is omitted instead of stamping every URL with the build time.
    ...routes.map((route) => ({
      url: `${SITE_URL}${route.path}`,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    })),
    ...changelogEntries.map((entry) => ({
      url: `${SITE_URL}/changelog/${entry.slug}`,
      lastModified: new Date(entry.date),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
    ...docs
      .filter((doc) => doc.slug !== "overview")
      .map((doc) => ({
        url: `${SITE_URL}${doc.href}`,
        changeFrequency: "monthly" as const,
        priority: 0.5,
      })),
  ];
}

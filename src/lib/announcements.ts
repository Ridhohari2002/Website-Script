export interface Announcement {
  slug: string;
  title: string;
  date: string;
  summary: string;
  body: readonly string[];
  /** Sample entries exist only to preview the layout and are labeled on screen. */
  sample: boolean;
}

export const announcements: readonly Announcement[] = [
  {
    slug: "announcement-layout-preview",
    title: "Announcement layout preview",
    date: "2026-11-12",
    summary:
      "This entry demonstrates the announcement layout. It is sample content, not a published announcement.",
    body: [
      "The announcements section is ready for real posts once an editorial workflow exists. Until then, this sample entry shows the typography, spacing, and metadata treatment for a single announcement.",
      "No release date, account feature, or availability claim in this entry should be read as a commitment. Public announcements will only describe functionality that has actually shipped.",
    ],
    sample: true,
  },
];

export function getAnnouncement(slug: string): Announcement | undefined {
  return announcements.find((entry) => entry.slug === slug);
}

/** True once at least one announcement is real content rather than a layout sample. */
export const hasPublishedAnnouncements = announcements.some((entry) => !entry.sample);

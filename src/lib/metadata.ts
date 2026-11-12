import type { Metadata } from "next";

import { SITE_NAME, absoluteUrl } from "./site";

const SOCIAL_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: `${SITE_NAME} — Script catalog and access platform`,
};

export type PageMetadataInput = {
  title: string;
  description: string;
  path: string;
  noIndex?: boolean;
};

/** One metadata shape for every public page, including canonical and social cards. */
export function pageMetadata({
  title,
  description,
  path,
  noIndex = false,
}: PageMetadataInput): Metadata {
  const url = absoluteUrl(path);
  const socialTitle = `${title} — ${SITE_NAME}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: socialTitle,
      description,
      url,
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: socialTitle,
      description,
      images: [SOCIAL_IMAGE.url],
    },
    ...(noIndex ? { robots: { index: false, follow: false } } : {}),
  };
}

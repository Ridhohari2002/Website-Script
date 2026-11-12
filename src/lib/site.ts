export const SITE_NAME = "BOYFINITY Hub";
export const SITE_TAGLINE = "Game scripts, account access, and software licensing in one place.";

const DEVELOPMENT_SITE_URL = "http://localhost:3000";

/**
 * Canonical origin for the whole site. Every metadata, sitemap, and robots URL
 * is built from this value, so a wrong value silently poisons all of them.
 *
 * Development falls back to localhost. A production build must supply an
 * explicit https origin; failing loudly here is safer than emitting localhost
 * canonicals into an indexable deployment.
 */
function resolveSiteUrl(rawValue: string | undefined, nodeEnv: string | undefined): string {
  const isProduction = nodeEnv === "production";
  const value = rawValue?.trim();

  if (!value) {
    if (isProduction) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required for a production build. Set it to the site's canonical https:// origin.",
      );
    }
    return DEVELOPMENT_SITE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must be an absolute URL, for example https://hub.example.com.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use http:// or https://.");
  }
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_URL must use https:// in production.");
  }
  if (!parsed.hostname) {
    throw new Error("NEXT_PUBLIC_SITE_URL must include a hostname.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must contain only the origin: no path, query, fragment, or credentials.",
    );
  }

  return parsed.origin;
}

export const SITE_URL = resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL, process.env.NODE_ENV);

export const SITE_DESCRIPTION =
  "BOYFINITY Hub is a development preview of a platform for published game scripts, account access, and software licensing.";

export interface NavItem {
  href: string;
  label: string;
}

export const publicNavigation: readonly NavItem[] = [
  { href: "/catalog", label: "Catalog" },
  { href: "/pricing", label: "Pricing" },
  { href: "/changelog", label: "Changelog" },
  { href: "/announcements", label: "Announcements" },
  { href: "/docs", label: "Docs" },
];

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

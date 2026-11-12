import { createElement, type ComponentType } from "react";

import LocalDevelopment from "../../content/docs/local-development.mdx";
import Overview from "../../content/docs/overview.mdx";
import PlatformStatus from "../../content/docs/platform-status.mdx";

type DocContent = ComponentType<Record<string, unknown>>;

const CONTENT: Readonly<Record<string, DocContent>> = {
  overview: Overview,
  "platform-status": PlatformStatus,
  "local-development": LocalDevelopment,
};

/** Server-only lookup for rendered documentation bodies. */
export function getDocContent(slug: string): DocContent | undefined {
  return CONTENT[slug];
}

/**
 * Stable component wrapper. Rendering the MDX body here keeps the React
 * component identity out of page render variables.
 */
export function DocBody({ slug }: { slug: string }) {
  const Content = CONTENT[slug];
  return Content ? createElement(Content) : null;
}

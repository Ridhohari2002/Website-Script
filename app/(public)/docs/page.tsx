import { DocBody, getDocContent } from "@/lib/doc-content";
import { getDoc } from "@/lib/docs";
import { pageMetadata } from "@/lib/metadata";

import { DocsArticle } from "./docs-article";

export const metadata = pageMetadata({
  title: "Documentation",
  description:
    "Documentation for BOYFINITY Hub: what the platform is, what exists today, and how to run it locally.",
  path: "/docs",
});

export default function DocsIndexPage() {
  const doc = getDoc("overview");
  const hasContent = Boolean(getDocContent("overview"));

  return (
    <DocsArticle
      title={doc?.title ?? "Overview"}
      description={doc?.description ?? "Platform overview."}
      slug="overview"
    >
      {hasContent ? <DocBody slug="overview" /> : null}
    </DocsArticle>
  );
}

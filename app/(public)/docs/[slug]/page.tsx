import { notFound } from "next/navigation";

import { DocBody, getDocContent } from "@/lib/doc-content";
import { docs, getDoc } from "@/lib/docs";
import { pageMetadata } from "@/lib/metadata";

import { DocsArticle } from "../docs-article";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return docs.filter((doc) => doc.slug !== "overview").map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc || slug === "overview") {
    return pageMetadata({
      title: "Documentation not found",
      description: "",
      path: "/docs",
      noIndex: true,
    });
  }

  return pageMetadata({
    title: doc.title,
    description: doc.description,
    path: doc.href,
  });
}

export default async function DocsPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug);
  const hasContent = Boolean(getDocContent(slug));
  if (!doc || !hasContent || slug === "overview") notFound();

  return (
    <DocsArticle title={doc.title} description={doc.description} slug={doc.slug}>
      <DocBody slug={slug} />
    </DocsArticle>
  );
}

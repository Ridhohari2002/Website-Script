import type { ReactNode } from "react";

import { DocsNav } from "@/components/site/docs-nav";

export default function DocsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="shell grid gap-10 py-12 sm:py-16 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16">
      <aside>
        <DocsNav />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

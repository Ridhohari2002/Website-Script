import { evaluate } from "@mdx-js/mdx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { useMDXComponents as getMdxComponents } from "../mdx-components";

const GFM_TABLE = `
## How the pieces fit

| Layer | Responsibility |
| --- | --- |
| Public site | Explains the platform. |
| API | Validates requests. |
`;

async function renderMdx(source: string): Promise<string> {
  const { default: MdxContent } = await evaluate(source, {
    ...runtime,
    remarkPlugins: [remarkGfm],
  });

  return renderToStaticMarkup(createElement(MdxContent, { components: getMdxComponents({}) }));
}

describe("MDX GitHub Flavored Markdown tables", () => {
  it("parses a pipe table into semantic table elements", async () => {
    const html = await renderMdx(GFM_TABLE);

    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
    expect(html).toMatch(/<th[^>]*>Layer<\/th>/);
    expect(html).toMatch(/<th[^>]*>Responsibility<\/th>/);
    expect(html).toMatch(/<td[^>]*>Public site<\/td>/);
    expect(html).toMatch(/<td[^>]*>Validates requests\.<\/td>/);
  });

  it("does not leave literal pipe-table text behind", async () => {
    const html = await renderMdx(GFM_TABLE);

    expect(html).not.toContain("| --- |");
    expect(html).not.toContain("| Layer |");
  });

  it("applies the existing accessible scroll wrapper exactly once", async () => {
    const html = await renderMdx(GFM_TABLE);

    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Scrollable documentation table"');
    expect(html).toContain('tabindex="0"');
    expect(html.match(/role="region"/g)).toHaveLength(1);
    expect(html.match(/<table/g)).toHaveLength(1);
  });

  it("keeps non-table MDX content rendering normally", async () => {
    const html = await renderMdx("## Section\n\nA paragraph with **bold** text.\n");

    expect(html).toContain("<h2");
    expect(html).toContain("<p");
    expect(html).toContain("<strong");
    expect(html).not.toContain("<table");
  });
});

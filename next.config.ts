import createMDX from "@next/mdx";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const isProduction = process.env.NODE_ENV === "production";

/**
 * Report-only first. The policy is deliberately permissive enough for Next.js
 * development and the existing OAuth redirect flow.
 *
 * No CSP report collector is configured for this project, so a `report-uri` or
 * `report-to` directive would be dead weight; violation reports are not
 * collected today. Add a destination only after a collector is chosen and
 * verified. Do not enforce this policy or remove `unsafe-inline`/`unsafe-eval`
 * until Next.js script handling is reworked and tested.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root so a parent-directory lockfile cannot affect builds.
  turbopack: { root: projectRoot },
  // One API entry point only. No rewrites, no api/ directory, no Server Actions.
  serverExternalPackages: ["pg", "kysely"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

const withMDX = createMDX({
  options: {
    // GitHub Flavored Markdown tables. The string form keeps Turbopack loader
    // options serializable; @next/mdx resolves it to the installed package.
    remarkPlugins: ["remark-gfm"],
  },
});

export default withMDX(nextConfig);

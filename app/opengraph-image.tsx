import { ImageResponse } from "next/og";

import { SITE_NAME } from "@/lib/site";

export const alt = `${SITE_NAME} — Script catalog and access platform`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#08090B",
        color: "#F1F1F3",
        padding: "72px",
        border: "1px solid #252832",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, fontSize: 26 }}>
        <span style={{ letterSpacing: "0.12em", fontWeight: 600 }}>BOYFINITY</span>
        <span style={{ color: "#858995" }}>Hub</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ width: 56, height: 3, background: "#51406E", marginBottom: 28 }} />
        <div
          style={{
            fontSize: 66,
            lineHeight: 1.1,
            fontWeight: 600,
            letterSpacing: "-0.03em",
            maxWidth: 900,
          }}
        >
          A controlled catalog for game scripts.
        </div>
        <div style={{ marginTop: 26, fontSize: 24, color: "#A1A4AE", maxWidth: 760 }}>
          Script catalog, device-bound access, and licensing in one platform. Development preview.
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          borderTop: "1px solid #252832",
          paddingTop: 24,
          fontSize: 20,
          color: "#858995",
        }}
      >
        <span>Development preview</span>
        <span style={{ fontFamily: "monospace" }}>/catalog · /docs</span>
      </div>
    </div>,
    size,
  );
}

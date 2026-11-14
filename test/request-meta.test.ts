import { describe, expect, it } from "vitest";
import { clientIp, TRUSTED_PROXY_SECRET_HEADER, userAgent } from "@/core/request-meta";

const SECRET = "test-trusted-proxy-secret-0123456789";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/executor/v1/validate", { headers });
}

function trusted(headers: Record<string, string> = {}): Request {
  return request({ [TRUSTED_PROXY_SECRET_HEADER]: SECRET, ...headers });
}

describe("client IP trust boundary", () => {
  it("returns no IP when no trusted proxy secret is configured", () => {
    const value = clientIp(
      request({ "x-forwarded-for": "203.0.113.10", [TRUSTED_PROXY_SECRET_HEADER]: SECRET }),
      { trustedProxySecret: null },
    );
    expect(value).toBeNull();
  });

  it("does not trust a spoofed X-Forwarded-For without the proxy marker", () => {
    expect(
      clientIp(request({ "x-forwarded-for": "203.0.113.10" }), {
        trustedProxySecret: SECRET,
      }),
    ).toBeNull();
  });

  it("does not trust a spoofed X-Real-IP without the proxy marker", () => {
    expect(
      clientIp(request({ "x-real-ip": "203.0.113.10" }), {
        trustedProxySecret: SECRET,
      }),
    ).toBeNull();
  });

  it("uses the forwarded address when the marker is valid", () => {
    expect(
      clientIp(trusted({ "x-forwarded-for": "203.0.113.10" }), {
        trustedProxySecret: SECRET,
      }),
    ).toBe("203.0.113.10");
  });

  it("rejects an invalid marker", () => {
    expect(
      clientIp(
        request({
          [TRUSTED_PROXY_SECRET_HEADER]: "wrong-secret-value-0123456789",
          "x-forwarded-for": "203.0.113.10",
        }),
        { trustedProxySecret: SECRET },
      ),
    ).toBeNull();
  });

  it("ignores X-Real-IP even when the marker is valid", () => {
    expect(
      clientIp(trusted({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "198.51.100.7" }), {
        trustedProxySecret: SECRET,
      }),
    ).toBe("203.0.113.10");
  });

  it("requires exactly one forwarded address so a client cannot select one", () => {
    for (const value of [
      "203.0.113.10, 198.51.100.7",
      "198.51.100.7,203.0.113.10",
      "203.0.113.10,",
      ",203.0.113.10",
    ]) {
      expect(
        clientIp(trusted({ "x-forwarded-for": value }), { trustedProxySecret: SECRET }),
      ).toBeNull();
    }
  });

  it("handles malformed and oversized headers safely", () => {
    for (const value of [
      "",
      "   ",
      "not-an-ip",
      "300.1.1.1",
      "203.0.113.10:443",
      "a".repeat(200),
    ]) {
      expect(
        clientIp(trusted({ "x-forwarded-for": value }), { trustedProxySecret: SECRET }),
      ).toBeNull();
    }
  });

  it("supports IPv4 and IPv6 addresses", () => {
    expect(
      clientIp(trusted({ "x-forwarded-for": "203.0.113.10" }), { trustedProxySecret: SECRET }),
    ).toBe("203.0.113.10");
    expect(
      clientIp(trusted({ "x-forwarded-for": "2001:db8::1" }), { trustedProxySecret: SECRET }),
    ).toBe("2001:db8::1");
    expect(
      clientIp(trusted({ "x-forwarded-for": "[2001:db8::2]" }), { trustedProxySecret: SECRET }),
    ).toBe("2001:db8::2");
  });

  it("returns null when the marker is valid but no forwarded address exists", () => {
    expect(
      clientIp(trusted({ "x-real-ip": "203.0.113.10" }), { trustedProxySecret: SECRET }),
    ).toBeNull();
  });
});

describe("user agent metadata", () => {
  it("bounds the value", () => {
    const value = userAgent(request({ "user-agent": `abc${"x".repeat(600)}` }));
    expect(value).not.toBeNull();
    expect(value!.length).toBe(512);
    expect(value!.startsWith("abc")).toBe(true);
  });
});

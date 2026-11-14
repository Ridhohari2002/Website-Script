import { describe, expect, it } from "vitest";
import { jsonResponse, redirectResponse } from "@/core/response";

describe("response helpers", () => {
  it("sets the request id on JSON responses", () => {
    const response = jsonResponse({ ok: true }, { requestId: "req-json" });
    expect(response.headers.get("x-request-id")).toBe("req-json");
  });

  it("sets the request id on redirects when supplied", () => {
    const response = redirectResponse("http://localhost:3000/dashboard", [], 302, "req-redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard");
    expect(response.headers.get("x-request-id")).toBe("req-redirect");
  });

  it("keeps redirects without an explicit request id unchanged", () => {
    const response = redirectResponse("http://localhost:3000/dashboard");
    expect(response.status).toBe(302);
    expect(response.headers.get("x-request-id")).toBeNull();
  });
});

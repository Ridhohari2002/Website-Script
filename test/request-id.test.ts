import { describe, expect, it } from "vitest";
import { newRequestId, resolveRequestId } from "@/core/request-id";

describe("request ids", () => {
  it("accepts a safe inbound id", () => {
    const headers = new Headers({ "x-request-id": "abc123.def-456:ghi" });
    expect(resolveRequestId(headers)).toBe("abc123.def-456:ghi");
  });

  it("rejects an unsafe inbound id", () => {
    const headers = new Headers({ "x-request-id": "<script>alert(1)</script>" });
    const id = resolveRequestId(headers);
    expect(id).not.toContain("<");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects an overlong inbound id", () => {
    const id = resolveRequestId(new Headers({ "x-request-id": "a".repeat(129) }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a UUID when the header is absent", () => {
    expect(resolveRequestId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints unique ids", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

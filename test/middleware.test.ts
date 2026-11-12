import { describe, expect, it } from "vitest";
import { AppError } from "@/core/errors";
import { readJsonBody } from "@/middleware/body-limit";
import { allowedOrigins, assertSameOrigin } from "@/middleware/csrf";
import { anonymousSession } from "@/middleware/session";
import { validate } from "@/middleware/validation";
import { z } from "zod";

function jsonRequest(body: string, contentLength?: number): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Request("http://localhost/api/test", { method: "POST", body, headers });
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await promise.catch((error: AppError) => expect(error.code).toBe(code));
}

describe("body limits", () => {
  it("parses a valid JSON body", async () => {
    await expect(readJsonBody(jsonRequest('{"a":1}'))).resolves.toEqual({ a: 1 });
  });

  it("rejects a non-JSON content type", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    await expectAppError(readJsonBody(request), "bad_request");
  });

  it("rejects an oversized declared length before reading", async () => {
    await expectAppError(readJsonBody(jsonRequest("{}", 50), 10), "payload_too_large");
  });

  it("rejects an oversized body when the length header is absent", async () => {
    const request = jsonRequest(JSON.stringify({ padded: "x".repeat(100) }));
    request.headers.delete("content-length");
    await expectAppError(readJsonBody(request, 10), "payload_too_large");
  });

  it("rejects an empty body", async () => {
    await expectAppError(readJsonBody(jsonRequest("")), "bad_request");
  });

  it("rejects malformed JSON", async () => {
    await expectAppError(readJsonBody(jsonRequest("{oops")), "bad_request");
  });
});

describe("validation hook", () => {
  it("returns parsed data", () => {
    const schema = z.object({ name: z.string().min(1) });
    expect(validate(schema, { name: "ok" })).toEqual({ name: "ok" });
  });

  it("throws a 400 with issue paths", async () => {
    const schema = z.object({ name: z.string().min(1) });
    await expectAppError(
      Promise.resolve().then(() => validate(schema, { name: "" })),
      "bad_request",
    );
  });
});

describe("CSRF origin hook", () => {
  const origins = ["https://hub.example"];

  it("skips safe methods", () => {
    expect(() => assertSameOrigin(new Request("https://hub.example/x"), origins)).not.toThrow();
  });

  it("requires an Origin header on unsafe methods", () => {
    const request = new Request("https://hub.example/x", { method: "POST" });
    expect(() => assertSameOrigin(request, origins)).toThrow(/Origin header is required/);
  });

  it("rejects a foreign origin", () => {
    const request = new Request("https://hub.example/x", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(() => assertSameOrigin(request, origins)).toThrow(/not allowed/);
  });

  it("accepts an allowlisted origin", () => {
    const request = new Request("https://hub.example/x", {
      method: "POST",
      headers: { origin: "https://hub.example" },
    });
    expect(() => assertSameOrigin(request, origins)).not.toThrow();
  });

  it("derives origins from APP_URL", () => {
    expect(allowedOrigins("https://hub.example:8443/path")).toEqual(["https://hub.example:8443"]);
    expect(allowedOrigins("not a url")).toEqual([]);
  });
});

describe("session boundary", () => {
  it("returns no session in Phase 1", async () => {
    await expect(anonymousSession(new Request("http://localhost/"))).resolves.toBeNull();
  });
});

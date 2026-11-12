import { describe, expect, it } from "vitest";
import {
  AppError,
  badRequest,
  internalError,
  methodNotAllowed,
  notFound,
  toErrorBody,
} from "@/core/errors";

describe("error surface", () => {
  it("exposes 4xx messages and details", () => {
    const { status, body } = toErrorBody(badRequest("Bad input", { field: "email" }), "req_1");
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe("Bad input");
    expect(body.error.requestId).toBe("req_1");
    expect(body.error.details).toEqual({ field: "email" });
  });

  it("never exposes internal error text", () => {
    const { status, body } = toErrorBody(internalError(new Error("connection refused")), "req_2");
    expect(status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("maps unknown thrown values to a safe 500", () => {
    const { status, body } = toErrorBody(new Error("boom"), "req_3");
    expect(status).toBe(500);
    expect(body.error.code).toBe("unknown");
  });

  it("keeps details when an AppError explicitly exposes a 5xx", () => {
    const error = new AppError("internal_error", 500, "Upstream unavailable", {
      expose: true,
      details: { retry: true },
    });
    const { status, body } = toErrorBody(error, "req_4");
    expect(status).toBe(500);
    expect(body.error.message).toBe("Upstream unavailable");
    expect(body.error.details).toEqual({ retry: true });
  });

  it("carries allowed methods on a 405", () => {
    const { status, body } = toErrorBody(
      methodNotAllowed("Method not allowed", { allowed: ["GET"] }),
      "req_5",
    );
    expect(status).toBe(405);
    expect(body.error.details).toEqual({ allowed: ["GET"] });
  });

  it("builds a plain 404", () => {
    expect(toErrorBody(notFound(), "req_6").status).toBe(404);
  });
});

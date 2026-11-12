import { describe, expect, it } from "vitest";
import { matchRoute, type RouteDefinition } from "@/http/router";

const noop = async () => new Response(null, { status: 204 });

const routes: RouteDefinition[] = [
  { method: "GET", pattern: ["health"], handler: noop },
  { method: "GET", pattern: ["keys", ":id"], handler: noop },
  { method: "POST", pattern: ["keys"], handler: noop },
];

describe("route matching", () => {
  it("matches an exact route", () => {
    const result = matchRoute(routes, "GET", ["health"]);
    expect(result.kind).toBe("matched");
  });

  it("captures and decodes params", () => {
    const result = matchRoute(routes, "GET", ["keys", "a%20b"]);
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.params.id).toBe("a b");
    }
  });

  it("reports allowed methods on a path match", () => {
    const result = matchRoute(routes, "DELETE", ["health"]);
    expect(result).toEqual({ kind: "method_not_allowed", allowed: ["GET"] });
  });

  it("does not match a longer path", () => {
    expect(matchRoute(routes, "GET", ["health", "extra"])).toEqual({ kind: "not_found" });
  });

  it("does not match an empty segment for a param", () => {
    expect(matchRoute(routes, "GET", ["keys", ""])).toEqual({ kind: "not_found" });
  });

  it("returns not_found for an unknown path", () => {
    expect(matchRoute(routes, "GET", ["missing"])).toEqual({ kind: "not_found" });
  });
});

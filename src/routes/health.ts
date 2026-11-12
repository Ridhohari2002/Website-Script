import type { RouteDefinition } from "@/http/router";
import { jsonResponse } from "@/core/response";

export type DatabaseProbe = () => Promise<boolean>;

/**
 * `/api/health` is deliberately unauthenticated and unthrottled. It reports
 * liveness plus database reachability, never configuration or secrets.
 */
export function healthRoute(checkDatabase: DatabaseProbe): RouteDefinition {
  return {
    method: "GET",
    pattern: ["health"],
    async handler({ requestId }) {
      const databaseUp = await checkDatabase();
      const body = {
        status: databaseUp ? "ok" : "degraded",
        service: "boyfinity-hub",
        checks: {
          database: databaseUp ? "up" : "down",
        },
        timestamp: new Date().toISOString(),
      };
      return jsonResponse(body, { status: databaseUp ? 200 : 503, requestId });
    },
  };
}

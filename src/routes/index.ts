import { checkDatabase } from "@/db/kysely";
import type { ApiDependencies } from "@/http/app";
import { authRoutes } from "@/routes/auth";
import { healthRoute, type DatabaseProbe } from "@/routes/health";
import { createAuthService, type AuthService } from "@/modules/auth/service";
import type { RouteDefinition } from "@/http/router";

export interface RouteDependencies extends ApiDependencies {
  checkDatabase?: DatabaseProbe;
  auth?: AuthService;
}

export function createRoutes(dependencies: RouteDependencies = {}): RouteDefinition[] {
  const probe = dependencies.checkDatabase ?? checkDatabase;
  const auth = dependencies.auth ?? createAuthService();
  return [healthRoute(probe), ...authRoutes(auth)];
}

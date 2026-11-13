import { checkDatabase } from "@/db/kysely";
import type { ApiDependencies } from "@/http/app";
import { authRoutes } from "@/routes/auth";
import { healthRoute, type DatabaseProbe } from "@/routes/health";
import { createAuthService, type AuthService } from "@/modules/auth/service";
import { createKeyService, type KeyService } from "@/modules/keys/service";
import { createExecutorService, type ExecutorService } from "@/modules/executor/service";
import { keyRoutes } from "@/routes/keys";
import { executorRoutes } from "@/routes/executor";
import type { RouteDefinition } from "@/http/router";

export interface RouteDependencies extends ApiDependencies {
  checkDatabase?: DatabaseProbe;
  auth?: AuthService;
  keys?: KeyService;
  executor?: ExecutorService;
}

export function createRoutes(dependencies: RouteDependencies = {}): RouteDefinition[] {
  const probe = dependencies.checkDatabase ?? checkDatabase;
  const auth = dependencies.auth ?? createAuthService();
  const keys = dependencies.keys ?? createKeyService();
  const executor = dependencies.executor ?? createExecutorService();
  return [healthRoute(probe), ...authRoutes(auth), ...keyRoutes(keys), ...executorRoutes(executor)];
}

import { createApiHandler } from "@/http/app";
import { createRoutes } from "@/routes";
import { createAuthService } from "@/modules/auth/service";
import type { RouteDefinition } from "@/http/router";

/**
 * The only API entry point. Every future endpoint is added to `createRoutes`,
 * never as a new route file, so there is exactly one auth and error surface.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const authService = createAuthService();
const routes: RouteDefinition[] = createRoutes({ auth: authService });
const handle = createApiHandler(routes, {
  resolveSession: (request) => authService.resolveSession(request),
  auditDenial: (event) => authService.recordAuthorizationDenied(event),
});

interface RouteContext {
  params: Promise<{ path?: string[] }>;
}

async function dispatch(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return handle(request, path ?? []);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

export async function OPTIONS(request: Request, context: RouteContext): Promise<Response> {
  return dispatch(request, context);
}

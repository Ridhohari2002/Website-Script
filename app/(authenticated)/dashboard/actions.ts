"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { SessionContext } from "@/middleware/session";
import { hasAdminAccess } from "@/modules/auth/permissions";
import { getPageSession } from "@/modules/auth/page-session.server";
import { createKeyService } from "@/modules/keys/service";
import { createExecutorService } from "@/modules/executor/service";

/**
 * Dashboard mutations. Next.js server actions already reject cross-origin
 * submissions; these handlers additionally re-check the admin role because the
 * page-level gate is not an authorization boundary by itself.
 */

async function adminSession(): Promise<SessionContext> {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/dashboard");
  if (!hasAdminAccess(session.roles)) redirect("/dashboard");
  return {
    userId: session.userId,
    roles: session.roles,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.user ? { user: session.user } : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
  };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function revokeLicenseAction(formData: FormData): Promise<void> {
  const session = await adminSession();
  const keyId = text(formData, "keyId");
  const reason = text(formData, "reason");
  await createKeyService().adminRevoke({
    session,
    request: new Request("http://localhost/dashboard", { method: "POST" }),
    keyId,
    ...(reason ? { reason } : {}),
  });
  revalidatePath("/dashboard");
}

export async function resetHwidAction(formData: FormData): Promise<void> {
  const session = await adminSession();
  const keyId = text(formData, "keyId");
  const reason = text(formData, "reason") || "Admin reset from dashboard";
  await createKeyService().adminResetHwid({
    session,
    request: new Request("http://localhost/dashboard", { method: "POST" }),
    keyId,
    reason,
  });
  revalidatePath("/dashboard");
}

export async function revokeExecutorSessionAction(formData: FormData): Promise<void> {
  const session = await adminSession();
  const keyId = text(formData, "keyId");
  const sessionId = text(formData, "sessionId");
  await createExecutorService().adminRevokeSession({
    keyId,
    sessionId,
    adminUserId: session.userId,
    request: new Request("http://localhost/dashboard", { method: "POST" }),
  });
  revalidatePath("/dashboard");
}

import { KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/site/page-header";
import { SectionHeading } from "@/components/site/section-heading";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getSqlDb } from "@/db/client";
import { pageMetadata } from "@/lib/metadata";
import { accountLabel } from "@/lib/auth-client";
import { hasAdminAccess } from "@/modules/auth/permissions";
import { pageSessionGate } from "@/modules/auth/page-access";
import { getPageSession } from "@/modules/auth/page-session.server";
import { getLicenseDetail, listLicenses } from "@/modules/executor/dashboard";
import { resetHwidAction, revokeExecutorSessionAction, revokeLicenseAction } from "./actions";

export const metadata = pageMetadata({
  title: "Dashboard",
  description:
    "License, purchase, and executor session information for your BOYFINITY Hub account.",
  path: "/dashboard",
  noIndex: true,
});

function formatTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const STATUS_TONES: Record<string, BadgeTone> = {
  active: "success",
  unused: "neutral",
  expired: "warning",
  revoked: "danger",
  suspended: "warning",
  banned: "danger",
  superseded: "neutral",
};

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{status}</Badge>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-primary">{value}</dd>
    </div>
  );
}

export default async function DashboardPage() {
  const session = await getPageSession();
  const gate = pageSessionGate(session, "/dashboard");
  if (gate.status === "login") redirect(gate.location);

  const label = accountLabel(gate.session.user.username);
  const isAdmin = hasAdminAccess(gate.session.roles);
  const db = getSqlDb();
  const licenses = await listLicenses(db, {
    discordId: gate.session.user.discordId,
    all: isAdmin,
  });
  const details = await Promise.all(licenses.map((license) => getLicenseDetail(db, license.keyId)));

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title={`Welcome, ${label}`}
        description={
          isAdmin
            ? "Every license is listed because your account holds an admin role. Buyer identity and executor identity are shown separately."
            : "Licenses you purchased or own are listed below. Buyer identity and executor identity are shown separately."
        }
        actions={
          <Link href="/docs/platform-status" className={buttonVariants({ variant: "secondary" })}>
            Platform status
          </Link>
        }
      />

      <div className="shell py-10 sm:py-14">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="pt-5">
              <p className="text-[11px] font-medium tracking-wide text-text-muted">Signed in as</p>
              <p className="mt-1 text-sm text-text-primary">{label}</p>
              <p className="mt-1 font-mono text-xs text-text-muted">
                {gate.session.user.discordId}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className="text-[11px] font-medium tracking-wide text-text-muted">Licenses</p>
              <p className="mt-1 text-sm text-text-primary">{licenses.length}</p>
              <p className="mt-1 text-xs text-text-muted">
                {isAdmin ? "Admin-wide view" : "Owned or purchased by you"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <p className="text-[11px] font-medium tracking-wide text-text-muted">
                Session policy
              </p>
              <p className="mt-1 text-sm text-text-primary">30 min idle · 24 h absolute</p>
              <p className="mt-1 text-xs text-text-muted">One active executor session per key</p>
            </CardContent>
          </Card>
        </div>

        <section className="mt-12">
          <SectionHeading
            eyebrow="Licenses"
            title="Purchase and executor"
            description="A license belongs to the buyer who purchased it. The executor binding is recorded separately the first time the key is activated."
          />

          {licenses.length === 0 ? (
            <div className="mt-6">
              <EmptyState
                icon={KeyRound}
                title="No licenses yet"
                description="No purchase record or key is attached to this account. Nothing is invented here."
              />
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {licenses.map((license, index) => {
                const detail = details[index];
                const activeSession = detail?.sessions.find((entry) => entry.status === "active");
                return (
                  <Card key={license.keyId}>
                    <CardHeader>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <CardTitle className="font-mono text-sm">
                            {license.keyPrefix ?? "key prefix unavailable"}
                          </CardTitle>
                          <CardDescription>
                            {license.productName ?? "No product assigned"}
                            {license.productCode ? ` · ${license.productCode}` : ""}
                          </CardDescription>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={license.status} />
                          {license.paymentStatus ? (
                            <Badge tone={license.paymentStatus === "paid" ? "info" : "neutral"}>
                              payment: {license.paymentStatus}
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-8 lg:grid-cols-2">
                        <section aria-labelledby={`purchase-${license.keyId}`}>
                          <h3
                            id={`purchase-${license.keyId}`}
                            className="text-xs font-medium tracking-wide text-text-muted"
                          >
                            Purchase information
                          </h3>
                          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                            <Field
                              label="Buyer Discord ID"
                              value={license.buyerDiscordId ?? "Not recorded"}
                            />
                            <Field
                              label="Buyer username"
                              value={license.buyerDiscordUsername ?? "Not recorded"}
                            />
                            <Field
                              label="Product"
                              value={license.productName ?? "No product assigned"}
                            />
                            <Field
                              label="Payment status"
                              value={license.paymentStatus ?? "Not recorded"}
                            />
                            <Field
                              label="Purchase reference"
                              value={license.purchaseReference ?? "—"}
                            />
                            <Field label="Purchased" value={formatTime(license.purchasedAt)} />
                            <Field label="Licenses status" value={license.status} />
                            <Field
                              label="Activations"
                              value={`${license.activationCount} / ${license.maxActivations}`}
                            />
                          </dl>
                        </section>

                        <section aria-labelledby={`executor-${license.keyId}`}>
                          <h3
                            id={`executor-${license.keyId}`}
                            className="text-xs font-medium tracking-wide text-text-muted"
                          >
                            Executor information
                          </h3>
                          {license.executor ? (
                            <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                              <Field
                                label="Roblox user"
                                value={
                                  license.executor.robloxUsername ??
                                  license.executor.robloxUserId ??
                                  "Not reported"
                                }
                              />
                              <Field
                                label="Executor"
                                value={
                                  [license.executor.executorName, license.executor.executorVersion]
                                    .filter(Boolean)
                                    .join(" ") || "Not reported"
                                }
                              />
                              <Field
                                label="HWID fingerprint"
                                value={
                                  <span className="font-mono text-xs">
                                    {license.executor.hwidFingerprint}
                                  </span>
                                }
                              />
                              <Field
                                label="Session status"
                                value={<StatusBadge status={license.executor.status} />}
                              />
                              <Field
                                label="First activation"
                                value={formatTime(license.executor.firstActivatedAt)}
                              />
                              <Field
                                label="Last activity"
                                value={formatTime(license.executor.lastActivityAt)}
                              />
                              <Field
                                label="Idle expiry"
                                value={formatTime(license.executor.idleExpiresAt)}
                              />
                              <Field
                                label="Absolute expiry"
                                value={formatTime(license.executor.absoluteExpiresAt)}
                              />
                            </dl>
                          ) : (
                            <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                              No executor has claimed this key yet. Activation binds the first
                              device and records telemetry separately from the buyer.
                            </p>
                          )}
                        </section>
                      </div>

                      {isAdmin ? (
                        <div className="mt-8 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-6">
                          <form
                            action={revokeLicenseAction}
                            className="flex flex-wrap items-end gap-2"
                          >
                            <input type="hidden" name="keyId" value={license.keyId} />
                            <label className="text-[11px] text-text-muted">
                              Revoke reason
                              <input
                                name="reason"
                                maxLength={500}
                                className="mt-1 block h-9 w-48 rounded-sm border border-border-default bg-bg-input px-2 text-xs text-text-primary"
                              />
                            </label>
                            <Button type="submit" variant="danger" size="sm">
                              Revoke license
                            </Button>
                          </form>

                          <form action={resetHwidAction} className="flex flex-wrap items-end gap-2">
                            <input type="hidden" name="keyId" value={license.keyId} />
                            <label className="text-[11px] text-text-muted">
                              Reset reason
                              <input
                                name="reason"
                                maxLength={500}
                                className="mt-1 block h-9 w-48 rounded-sm border border-border-default bg-bg-input px-2 text-xs text-text-primary"
                              />
                            </label>
                            <Button type="submit" variant="secondary" size="sm">
                              Reset HWID
                            </Button>
                          </form>

                          {activeSession ? (
                            <form action={revokeExecutorSessionAction}>
                              <input type="hidden" name="keyId" value={license.keyId} />
                              <input
                                type="hidden"
                                name="sessionId"
                                value={activeSession.sessionId}
                              />
                              <Button type="submit" variant="secondary" size="sm">
                                Revoke active session
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-8 border-t border-border-subtle pt-6 text-xs leading-relaxed text-text-muted">
                          HWID reset and session revocation are admin-only. Contact an administrator
                          if a device needs to be replaced.
                        </p>
                      )}

                      {detail ? (
                        <details className="mt-6 border-t border-border-subtle pt-5">
                          <summary className="cursor-pointer text-xs font-medium text-text-secondary">
                            Sessions, entitlements, device and audit history
                          </summary>

                          <div className="mt-5 space-y-6">
                            <div>
                              <h4 className="text-[11px] font-medium tracking-wide text-text-muted">
                                Executor sessions
                              </h4>
                              {detail.sessions.length === 0 ? (
                                <p className="mt-2 text-sm text-text-secondary">No sessions.</p>
                              ) : (
                                <Table scrollLabel="Executor sessions">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Status</TableHead>
                                      <TableHead>HWID</TableHead>
                                      <TableHead>First seen</TableHead>
                                      <TableHead>Last seen</TableHead>
                                      <TableHead>Absolute expiry</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {detail.sessions.map((entry) => (
                                      <TableRow key={entry.sessionId}>
                                        <TableCell>
                                          <StatusBadge status={entry.status} />
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">
                                          {entry.hwidFingerprint}
                                        </TableCell>
                                        <TableCell>{formatTime(entry.firstActivatedAt)}</TableCell>
                                        <TableCell>{formatTime(entry.lastActivityAt)}</TableCell>
                                        <TableCell>{formatTime(entry.absoluteExpiresAt)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>

                            <div>
                              <h4 className="text-[11px] font-medium tracking-wide text-text-muted">
                                Entitlements
                              </h4>
                              {detail.entitlements.length === 0 ? (
                                <p className="mt-2 text-sm text-text-secondary">
                                  No product entitlement. The key cannot validate any script.
                                </p>
                              ) : (
                                <ul className="mt-2 space-y-3">
                                  {detail.entitlements.map((entitlement) => (
                                    <li
                                      key={entitlement.id}
                                      className="border-l-2 border-border-default pl-3"
                                    >
                                      <p className="text-sm text-text-primary">
                                        {entitlement.productName} ·{" "}
                                        <span className="font-mono text-xs text-text-muted">
                                          {entitlement.productCode}
                                        </span>
                                      </p>
                                      <p className="mt-1 text-xs text-text-muted">
                                        {entitlement.status} · source {entitlement.source} · starts{" "}
                                        {formatTime(entitlement.startsAt)} · expires{" "}
                                        {entitlement.expiresAt
                                          ? formatTime(entitlement.expiresAt)
                                          : "never"}
                                      </p>
                                      <p className="mt-1 text-xs text-text-secondary">
                                        Scripts:{" "}
                                        {entitlement.scripts.length === 0
                                          ? "none mapped"
                                          : entitlement.scripts
                                              .map((script) => script.publicId)
                                              .join(", ")}
                                      </p>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            <div>
                              <h4 className="text-[11px] font-medium tracking-wide text-text-muted">
                                Device history
                              </h4>
                              {detail.devices.length === 0 ? (
                                <p className="mt-2 text-sm text-text-secondary">No events.</p>
                              ) : (
                                <Table scrollLabel="Device history">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Event</TableHead>
                                      <TableHead>Actor</TableHead>
                                      <TableHead>HWID</TableHead>
                                      <TableHead>When</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {detail.devices.map((event, eventIndex) => (
                                      <TableRow key={`${event.event}-${eventIndex}`}>
                                        <TableCell>{event.event}</TableCell>
                                        <TableCell>{event.actor}</TableCell>
                                        <TableCell className="font-mono text-xs">
                                          {event.hwidFingerprint ?? "—"}
                                        </TableCell>
                                        <TableCell>{formatTime(event.createdAt)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>

                            <div>
                              <h4 className="text-[11px] font-medium tracking-wide text-text-muted">
                                Audit history
                              </h4>
                              {detail.audit.length === 0 ? (
                                <p className="mt-2 text-sm text-text-secondary">No audit rows.</p>
                              ) : (
                                <Table scrollLabel="Audit history">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Action</TableHead>
                                      <TableHead>Actor</TableHead>
                                      <TableHead>When</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {detail.audit.map((event, eventIndex) => (
                                      <TableRow key={`${event.action}-${eventIndex}`}>
                                        <TableCell className="font-mono text-xs">
                                          {event.action}
                                        </TableCell>
                                        <TableCell>{event.actorType ?? "system"}</TableCell>
                                        <TableCell>{formatTime(event.createdAt)}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              )}
                            </div>
                          </div>
                        </details>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <div className="mt-10 flex items-start gap-3 border-t border-border-subtle pt-6 text-xs leading-relaxed text-text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            Plaintext license keys are shown only once at creation and are never displayed here.
            HWID values are stored as keyed hashes; the dashboard shows a short non-reversible
            fingerprint. Roblox user id, username, and executor metadata are reported by the client
            and are not authentication.
          </p>
        </div>
      </div>
    </>
  );
}

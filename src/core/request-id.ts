import { randomUUID } from "node:crypto";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_CLIENT_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

/** Accept a sane client-supplied ID for tracing, otherwise mint a new one. */
export function resolveRequestId(headers: Headers): string {
  const inbound = headers.get(REQUEST_ID_HEADER);
  if (inbound && inbound.length <= MAX_CLIENT_ID_LENGTH && SAFE_ID.test(inbound)) {
    return inbound;
  }
  return randomUUID();
}

export function newRequestId(): string {
  return randomUUID();
}

export { REQUEST_ID_HEADER };

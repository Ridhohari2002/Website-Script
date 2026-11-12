import { badRequest, payloadTooLarge } from "@/core/errors";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Body size limits are enforced before parsing and again on the decoded bytes,
 * so a missing or lying Content-Length header cannot bypass the cap.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw badRequest("Content-Type must be application/json");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) throw badRequest("Invalid Content-Length header");
    if (size > maxBytes) throw payloadTooLarge();
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw payloadTooLarge();
  if (raw.trim().length === 0) throw badRequest("Request body is required");

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
}

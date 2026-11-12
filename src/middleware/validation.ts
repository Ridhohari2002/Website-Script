import type { ZodType } from "zod";
import { badRequest } from "@/core/errors";

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Single validation entry point. Handlers pass untrusted input here; nothing
 * downstream sees a parsed-but-unchecked value.
 */
export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw badRequest("Validation failed", { issues });
  }
  return result.data;
}

import { describe, expect, it } from "vitest";
import { createLogger, redact } from "@/core/logger";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line)) };
}

describe("structured logger", () => {
  it("emits one JSON object per entry", () => {
    const { logger, records } = capture();
    logger.info("hello", { event: "test" });
    const [record] = records();
    expect(record.level).toBe("info");
    expect(record.message).toBe("hello");
    expect(record.event).toBe("test");
    expect(typeof record.time).toBe("string");
  });

  it("honors the level threshold", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", sink: (line) => lines.push(line) });
    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
  });

  it("redacts sensitive keys at any depth", () => {
    const redacted = redact({
      authorization: "Bearer abc",
      nested: { serverKey: "abc", ok: 1 },
      list: [{ password: "x" }],
    });
    expect(redacted.authorization).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).serverKey).toBe("[redacted]");
    expect((redacted.nested as Record<string, unknown>).ok).toBe(1);
    expect((redacted.list as Array<Record<string, unknown>>)[0]!.password).toBe("[redacted]");
  });

  it("redacts connection strings and bearer values", () => {
    const redacted = redact({ dsn: "postgresql://user:pass@host/db", header: "Bearer token" });
    expect(redacted.dsn).toBe("[redacted]");
    expect(redacted.header).toBe("[redacted]");
  });

  it("merges child fields", () => {
    const { logger, records } = capture();
    logger.child({ requestId: "req_1" }).info("child");
    expect(records()[0].requestId).toBe("req_1");
  });
});

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /(secret|token|password|passwd|authorization|cookie|api[-_]?key|server[-_]?key|private[-_]?key|session|hwid|credential)/i;
const SENSITIVE_VALUE = /^(postgres(ql)?:\/\/|Bearer\s+|sk_)/i;
const MAX_DEPTH = 6;

function redactValue(value: unknown, key: string | null, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (key && SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, null, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      out[entryKey] = redactValue(entryValue, entryKey, depth + 1);
    }
    return out;
  }
  return value;
}

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, null, 0) as Record<string, unknown>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(base: Record<string, unknown>): Logger;
}

type Sink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: Sink;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink: Sink = options.sink ?? ((line) => console.log(line));
  const base = options.base ?? {};

  function emit(entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const record = {
      level: entryLevel,
      time: new Date().toISOString(),
      message,
      ...redact({ ...base, ...(fields ?? {}) }),
    };
    sink(JSON.stringify(record));
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBase) => createLogger({ level, sink, base: { ...base, ...childBase } }),
  };
}

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export const logger: Logger = createLogger({ level: resolveLevel() });

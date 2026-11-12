import { loadEnvFile } from "node:process";
import { getSqlDb } from "../src/db/client";
import { closePool } from "../src/db/pool";
import { runAuthRetention } from "../src/modules/auth/retention";

/**
 * Manual/scheduled retention pass. Run with `npm run db:retention`.
 * Logs counts only; raw IPs, user agents, and credentials never appear.
 */

function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      loadEnvFile(file);
      return;
    } catch {
      // Missing file is expected in CI; the real environment may supply the URL.
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const result = await runAuthRetention(getSqlDb(), { now: new Date() });
  console.log(JSON.stringify({ event: "auth.retention.completed", ...result }));
}

main()
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "auth.retention.failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });

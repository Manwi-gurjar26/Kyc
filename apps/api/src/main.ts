import { resolve } from "node:path";
import { Logger } from "@nestjs/common";
import { createApp } from "./bootstrap.js";
import { loadConfig } from "./config.js";

/**
 * Loads .env from the repository root, if there is one.
 *
 * Deliberately not a dependency: Node reads these itself. And deliberately
 * not fatal when the file is missing — production injects real environment
 * variables and has no .env to find, so an error here would mean the file
 * every deploy does NOT have becomes the thing that stops it booting.
 *
 * Precedence, which was measured rather than assumed: a variable already set
 * in the environment WINS over the same name in the file. That is the
 * ordering you want — a stray .env left in an image cannot override what the
 * platform injected.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, "../../..", ".env"));
  } catch {
    /* no .env, or unreadable: the real environment is the source of truth */
  }
}

loadDotEnv();


/**
 * Entry point.
 *
 * Configuration is validated before anything else. A KYC service that starts
 * without a webhook secret or without the blind index key is worse than one
 * that refuses to start: it accepts traffic and gets security-critical things
 * wrong quietly.
 */
async function main(): Promise<void> {
  const logger = new Logger("Bootstrap");

  const config = loadConfig();
  const app = await createApp({ config });

  await app.listen(config.PORT);

  logger.log(`API listening on http://localhost:${config.PORT}`);
  logger.log(`KYC provider: ${config.KYC_PROVIDER}`);

  if (config.KYC_PROVIDER === "fake") {
    logger.warn(
      "Using the FAKE KYC provider. It verifies nobody — it simulates vendor " +
        "responses so the flow can be built and tested. No real Aadhaar or PAN " +
        "is being checked.",
    );
  }
}

main().catch((error: unknown) => {
  console.error("Failed to start:", error);
  process.exit(1);
});

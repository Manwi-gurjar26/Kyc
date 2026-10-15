import { KYC_PROVIDERS } from "@kilowattx/integrations";
import { z } from "zod";

/**
 * Environment configuration, validated at boot.
 *
 * The process refuses to start on a bad or missing value rather than
 * discovering it on the first request. A KYC service that comes up without a
 * webhook secret, or without the blind index key, is worse than one that does
 * not come up: it accepts traffic and gets security-critical things wrong
 * quietly.
 */

export const DI = {
  CONFIG: Symbol("CONFIG"),
  DATABASE: Symbol("DATABASE"),
  KYC_PROVIDER: Symbol("KYC_PROVIDER"),
  KYB_PROVIDER: Symbol("KYB_PROVIDER"),
  SEEN_EVENT_STORE: Symbol("SEEN_EVENT_STORE"),
  REPLAY_GUARD: Symbol("REPLAY_GUARD"),
  CLOCK: Symbol("CLOCK"),
  PAN_ENCRYPTOR: Symbol("PAN_ENCRYPTOR"),
  FILE_STORE: Symbol("FILE_STORE"),
  DOCUMENT_SCANNER: Symbol("DOCUMENT_SCANNER"),
  DOCUMENT_EXTRACTOR: Symbol("DOCUMENT_EXTRACTOR"),
  FILE_BUCKET: Symbol("FILE_BUCKET"),
  /** Narrow port: "the name we verified for this user", nothing more. */
  VERIFIED_NAME_LOOKUP: Symbol("VERIFIED_NAME_LOOKUP"),
} as const;

/** 32 bytes, base64. Rejected if absent, short, or all zeroes. */
const Base64Key32 = z
  .string()
  .min(1, "required")
  .refine(
    (value) => {
      const buf = Buffer.from(value, "base64");
      return buf.length >= 32 && !buf.every((b) => b === 0);
    },
    "must be at least 32 bytes of base64 and not all zeroes",
  );

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1),

  /**
   * Which adapter to use. `fake` runs the full flow with no vendor contract;
   * the others need credentials. Swapping this is the entire cost of changing
   * vendor.
   */
  KYC_PROVIDER: z.enum(KYC_PROVIDERS).default("fake"),

  /**
   * Vendor credentials. Only needed once KYC_PROVIDER names a real one.
   *
   * Two vendors behind one interface, so an outage at the primary is a config
   * change rather than an incident.
   *
   * Sandbox (sandbox.co.in, by Quicko) is the primary: its Aadhaar OKYC is the
   * same two calls this system already assumed, it publishes a test host, and
   * the keys are self-serve. Cashfree is the backup, chosen because it is a
   * different company on different infrastructure — a failover that shares the
   * primary's rails is not a failover.
   */
  KYC_VENDOR_CLIENT_ID: z.string().min(1).optional(),
  KYC_VENDOR_CLIENT_SECRET: z.string().min(1).optional(),

  /** Verifies every inbound vendor webhook. No default, ever. */
  KYC_WEBHOOK_SECRET: z.string().min(16, "must be at least 16 characters"),

  /** Keys the duplicate-PAN blind index. See packages/core/blindIndex.ts. */
  KYC_BLIND_INDEX_KEY: Base64Key32,

  /** Where the vendor returns the user after their hosted flow. */
  KYC_REDIRECT_URL: z.string().url().default("http://localhost:3000/kyc/return"),

  /** How far a webhook's signing timestamp may be from now. */
  KYC_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * Signs the short-lived document URLs.
   *
   * Separate from every webhook secret: these two keys protect different
   * things in different directions, and one key that both verifies vendor
   * callbacks and grants access to land deeds means a leak of either is a leak
   * of both.
   *
   * A managed bucket replaces this with its own presigning credentials. The
   * interface does not change, which is why the secret is configuration
   * rather than a hardcoded development value.
   */
  FILE_SIGNING_SECRET: z.string().min(24, "must be at least 24 characters"),

  /** Where the signed URLs point. The bucket's own host in production. */
  FILE_BASE_URL: z.string().url().default("http://localhost:4000/v1/files"),

  /**
   * Where the development object store keeps its bytes.
   *
   * Replaced by a managed bucket, which is why there is no production default to
   * fall back to — LocalDiskBucket refuses to construct in production at all.
   */
  FILE_BUCKET_ROOT: z.string().default(".kwx-bucket"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Parses and validates the environment.
 *
 * Reports every problem at once, because being told about one missing
 * variable at a time is how a deploy takes six attempts.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = ConfigSchema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const config = result.data;

  /**
   * A real vendor in production must not be left on the fake adapter, and the
   * fake must never be reachable in production. Both directions are mistakes
   * that would otherwise only show up in the KYC numbers.
   */
  if (config.NODE_ENV === "production" && config.KYC_PROVIDER === "fake") {
    throw new Error(
      "KYC_PROVIDER=fake is refused in production. The fake adapter approves people without verifying anyone.",
    );
  }

  /**
   * A named vendor without its credentials is the failure worth catching at
   * boot: the adapter would construct, every call would fail at the gateway,
   * and the symptom would be "verification is broken" rather than "nobody
   * set the key".
   */
  if (
    config.KYC_PROVIDER !== "fake" &&
    (!config.KYC_VENDOR_CLIENT_ID || !config.KYC_VENDOR_CLIENT_SECRET)
  ) {
    throw new Error(
      `KYC_PROVIDER=${config.KYC_PROVIDER} needs KYC_VENDOR_CLIENT_ID and KYC_VENDOR_CLIENT_SECRET. ` +
        "Sandbox calls these the API key and API secret, from its dashboard.",
    );
  }

  /**
   * The file signing key must be its own. Reusing the webhook secret would
   * mean anybody who can forge a vendor callback can also mint a URL to any
   * document in the bucket.
   */
  if (config.FILE_SIGNING_SECRET === config.KYC_WEBHOOK_SECRET) {
    throw new Error(
      "FILE_SIGNING_SECRET must differ from the webhook secret. One key that both verifies callbacks and grants access to documents means a leak of either is a leak of both.",
    );
  }

  return config;
}

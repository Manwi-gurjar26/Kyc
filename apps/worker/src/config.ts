import { KYC_PROVIDERS } from "@kilowattx/integrations";
import { z } from "zod";

/**
 * The worker's environment.
 *
 * Its own module, not a const inside main.ts, for a reason this project
 * learned the hard way: main.ts calls main() at import time, so anything
 * wanting to check the schema — a test, a tool — would have started the
 * worker to do it. A schema that cannot be inspected without side effects is a
 * schema nobody checks, and these two schemas had already drifted apart once.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  KYC_PROVIDER: z.enum(KYC_PROVIDERS).default("fake"),
  KYC_WEBHOOK_SECRET: z.string().min(16),
  /**
   * The gateway credentials, needed here as well as in the API.
   *
   * Reconciliation asks the vendor what happened to a session the webhook
   * never came back for, so the worker holds its own adapter and therefore its
   * own key. Optional, because a deployment on the fake has none.
   */
  KYC_VENDOR_CLIENT_ID: z.string().min(1).optional(),
  KYC_VENDOR_CLIENT_SECRET: z.string().min(1).optional(),
  /** 32+ bytes, base64. Keys the duplicate-PAN blind index. */
  KYC_BLIND_INDEX_KEY: z
    .string()
    .min(1)
    .refine((v) => {
      const buf = Buffer.from(v, "base64");
      return buf.length >= 32 && !buf.every((b) => b === 0);
    }, "must be at least 32 bytes of base64 and not all zeroes"),

  PGBOSS_SCHEMA: z.string().min(1).default("pgboss"),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  RECONCILE_STUCK_AFTER_MINUTES: z.coerce.number().int().positive().default(30),
  /** How many batches one outbox pass will drain before yielding. */
  OUTBOX_MAX_BATCHES_PER_PASS: z.coerce.number().int().positive().default(25),
});

export type Config = z.infer<typeof ConfigSchema>;

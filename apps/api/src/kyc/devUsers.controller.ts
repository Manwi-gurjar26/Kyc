import { users, withContext, type Database } from "@kilowattx/db";
import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";
import { ZodBody } from "../common/zodPipe.js";

/**
 * Development-only identities.
 *
 * Better Auth will own users: phone OTP, Google and Apple sign-in, guest
 * sessions that merge on sign-up. None of that exists yet, and the web app
 * still needs somebody to be in order to walk the flow.
 *
 * It lives here rather than in the web app because of a rule worth keeping:
 * no surface touches the database directly, only the API does. A web app with
 * its own database connection is how two sources of truth start.
 *
 * Registered only outside production, and it checks NODE_ENV itself as well.
 */

const CreateDevUserSchema = z.object({
  /** E.164. Unique, because phone is the identity on this platform. */
  phoneE164: z
    .string()
    .regex(/^\+91[6-9][0-9]{9}$/, "Enter an Indian mobile number as +91XXXXXXXXXX"),
  /**
   * Optional, because a visitor who has just arrived has not told us their
   * name — and it is not ours to invent one.
   *
   * The column is nullable; this schema was the stricter of the two, which
   * was fine while the only caller was a form a developer typed into. It
   * stopped being fine when a session started being created for somebody
   * landing on the first screen with nothing filled in.
   *
   * Substituting a placeholder here would be the tempting fix and the wrong
   * one: `displayNameFor()` feeds `verifiedName` in LandService, where it is
   * compared against the owner name on a jamabandi to decide whether a parcel
   * needs a human. An invented name would travel into that comparison and
   * quietly corrupt it. The real name arrives from Aadhaar, after
   * verification, and until then the absence has to stay an absence.
   *
   * Still bounded when it IS given: an empty string is not a name.
   */
  displayName: z.string().min(2).max(120).nullish(),
  locale: z.enum(["en", "hi"]).default("en"),
});

type CreateDevUser = z.infer<typeof CreateDevUserSchema>;

@Controller("v1/dev/users")
export class DevUsersController {
  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.DATABASE) private readonly db: Database,
  ) {}

  private assertAvailable(): void {
    if (this.config.NODE_ENV === "production") {
      throw ApiError.notFound("NOT_FOUND", "Not found.");
    }
  }

  /** The identities available to pick from, newest first. */
  @Get()
  async list() {
    this.assertAvailable();

    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          id: users.id,
          phoneE164: users.phoneE164,
          displayName: users.displayName,
          locale: users.locale,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(25),
    );

    return { users: rows };
  }

  @Post()
  async create(@Body(new ZodBody(CreateDevUserSchema)) body: CreateDevUser) {
    this.assertAvailable();

    const existing = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.phoneE164, body.phoneE164))
        .limit(1),
    );

    if (existing[0]) {
      throw ApiError.conflict(
        "PHONE_ALREADY_USED",
        "That mobile number already has an account. Pick it from the list instead.",
      );
    }

    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .insert(users)
        .values({
          phoneE164: body.phoneE164,
          displayName: body.displayName,
          locale: body.locale,
          /**
           * Marked verified immediately. The real flow sends a 6-digit OTP
           * over MSG91 on a DLT template, with a 5-minute expiry and three
           * attempts — none of which exists yet, and pretending otherwise
           * would make the trial rules look enforced when they are not.
           */
          phoneVerifiedAt: new Date(),
        })
        .returning({ id: users.id, displayName: users.displayName }),
    );

    return rows[0];
  }
}

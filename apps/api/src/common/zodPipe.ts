import { PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Validates a request body with the same Zod schema the browser form used.
 *
 * One schema, three places: the form, this pipe, and the database boundary. A
 * rule that lives in only one of them is not a rule — it is a suggestion the
 * next client can ignore, and `curl` is a client.
 *
 * Returns the parsed value, so transforms apply too: a PAN typed as
 * "abcps 4412 k" reaches the service as "ABCPS4412K", which is what the blind
 * index must be computed over.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    // Throws ZodError, which ApiExceptionFilter renders as VALIDATION_FAILED.
    return this.schema.parse(value);
  }
}

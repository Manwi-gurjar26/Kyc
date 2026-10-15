import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

/**
 * One error shape for the whole API: { code, message, details }.
 *
 * The apps switch on `code`, never on the message — messages get reworded and
 * translated, codes do not. Every KYC denial returns a code the client can
 * branch on: KYC_REQUIRED sends the user into verification, KYC_IN_REVIEW
 * shows a "we are looking at it" screen, and a client that cannot tell them
 * apart will ask the user to re-submit something already sitting in a queue.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }

  static badRequest(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, code, message, details);
  }

  static unauthorized(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, code, message, details);
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, code, message);
  }

  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(HttpStatus.CONFLICT, code, message, details);
  }

  /** A body bigger than the size the upload URL was signed for. */
  static payloadTooLarge(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, code, message);
  }

  /** A body whose content type is not the one the URL was signed for. */
  static unsupportedMediaType(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, code, message);
  }

  /**
   * A dependency this instance needs is not answering.
   *
   * Distinct from a 500: a 500 says the handler is broken and retrying will
   * not help, where this says "ask again shortly" — which is both true and
   * the thing a load balancer acts on by taking the instance out of rotation
   * rather than reporting an incident.
   */
  static serviceUnavailable(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }
}

/**
 * Turns everything into the standard shape.
 *
 * The important half is the last branch: an unexpected error is logged in full
 * and answered with a generic message. A stack trace or a driver error
 * reaching the client would leak table names, and in this module a constraint
 * error message can name a column like `pan_blind_index`.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ZodError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        code: "VALIDATION_FAILED",
        message: "Some of the values sent are not valid.",
        details: exception.issues.map((issue) => ({
          field: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      } satisfies ApiErrorBody);
      return;
    }

    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      const body: ApiErrorBody =
        typeof payload === "object" && payload !== null && "code" in payload
          ? (payload as ApiErrorBody)
          : {
              code: "HTTP_ERROR",
              message:
                typeof payload === "string" ? payload : exception.message,
            };
      response.status(exception.getStatus()).json(body);
      return;
    }

    this.logger.error(
      "Unhandled error",
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side. Please try again.",
    } satisfies ApiErrorBody);
  }
}

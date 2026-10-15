import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "./errors.js";

/**
 * Session resolution.
 *
 * NOT THE REAL THING. Better Auth, running inside this API with users and
 * sessions in our own Postgres, is what will populate this — phone OTP,
 * Google and Apple sign-in, guest sessions that merge on sign-up, and staff
 * Google Workspace SSO with MFA.
 *
 * Until then this reads headers, which means anyone can claim to be anyone.
 * So it refuses to operate in production: a placeholder that fails closed
 * cannot be the thing that was accidentally shipped. If this file is still
 * here when auth lands, deleting it is the whole migration.
 */

export interface Session {
  userId: string;
  /** Staff roles, e.g. ["compliance"] or ["legal"]. Empty for a customer. */
  staffRoles: string[];
  isStaff: boolean;
}

export interface RequestWithSession extends Request {
  session?: Session;
  /** The exact bytes received, kept for webhook signature verification. */
  rawBody?: Buffer;
}

export const DEV_USER_HEADER = "x-dev-user-id";
export const DEV_STAFF_ROLES_HEADER = "x-dev-staff-roles";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(DI.CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.NODE_ENV === "production") {
      throw new Error(
        "SessionGuard is a development placeholder that trusts request headers. " +
          "It must be replaced by Better Auth before anything runs in production.",
      );
    }

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const userId = request.header(DEV_USER_HEADER);

    if (!userId) {
      throw ApiError.unauthorized(
        "AUTH_REQUIRED",
        "Please sign in to continue.",
      );
    }

    const staffRoles = (request.header(DEV_STAFF_ROLES_HEADER) ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);

    request.session = {
      userId,
      staffRoles,
      isStaff: staffRoles.length > 0,
    };
    return true;
  }
}

/** Reads the session a guard put on the request, or fails loudly. */
export function sessionOf(request: RequestWithSession): Session {
  if (!request.session) {
    throw new Error(
      "sessionOf: no session on the request. The route is missing SessionGuard.",
    );
  }
  return request.session;
}

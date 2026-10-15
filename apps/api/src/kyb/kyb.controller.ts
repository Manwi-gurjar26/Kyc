import {
  CompanyRegisterInputSchema,
  CreateOrganisationInputSchema,
  SignatoryInputSchema,
  type CompanyRegisterInput,
  type CreateOrganisationInput,
  type SignatoryInput,
} from "@kilowattx/validation";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { SessionGuard, sessionOf, type RequestWithSession } from "../common/session.js";
import { ZodBody } from "../common/zodPipe.js";
import { KybService } from "./kyb.service.js";

/**
 * Business verification, for Commercial Users.
 *
 * Four steps and a read, which is the shape the guide sets out: the GSTIN
 * identifies the business and says what else is needed, the company register
 * confirms it still exists, the signatory proves who they are, and then the
 * whole thing is submitted for one decision.
 */
@Controller("v1/kyb/organisations")
@UseGuards(SessionGuard)
export class KybController {
  constructor(@Inject(KybService) private readonly kyb: KybService) {}

  /**
   * Starts a business check from a GSTIN alone.
   *
   * Everything else is derived or looked up. Asking the customer for the legal
   * name or the constitution would be asking them to retype what we are about
   * to be told authoritatively — and letting them type it wrong.
   */
  @Post()
  async create(
    @Req() request: RequestWithSession,
    @Body(new ZodBody(CreateOrganisationInputSchema)) body: CreateOrganisationInput,
  ) {
    const session = sessionOf(request);
    return this.kyb.createFromGstin(session.userId, body.gstin);
  }

  @Get(":id")
  async read(@Req() request: RequestWithSession, @Param("id") id: string) {
    const session = sessionOf(request);
    return this.kyb.view(id, session.userId);
  }

  /** The MCA company register, when the constitution calls for one. */
  @Post(":id/company-register")
  async companyRegister(
    @Req() request: RequestWithSession,
    @Param("id") id: string,
    @Body(new ZodBody(CompanyRegisterInputSchema)) body: CompanyRegisterInput,
  ) {
    const session = sessionOf(request);
    return this.kyb.recordCompanyRegister(session.userId, id, body);
  }

  /**
   * Declares the caller as the person who will sign.
   *
   * There is deliberately no way to nominate somebody else: that would be
   * asserting authority over a person who has not consented, and the point of
   * the step is that the signatory proves their own identity.
   */
  @Post(":id/signatory")
  async signatory(
    @Req() request: RequestWithSession,
    @Param("id") id: string,
    @Body(new ZodBody(SignatoryInputSchema)) body: SignatoryInput,
  ) {
    const session = sessionOf(request);
    return this.kyb.declareSignatory(session.userId, id, body.authorityDocumentId);
  }

  /** Submits for a decision. Refuses while a step is still outstanding. */
  @Post(":id/submit")
  async submit(@Req() request: RequestWithSession, @Param("id") id: string) {
    const session = sessionOf(request);
    return this.kyb.submit(session.userId, id);
  }
}

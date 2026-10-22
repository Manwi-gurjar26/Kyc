import { createClient, PostgresSeenEventStore, type DatabaseHandle } from "@kilowattx/db";
import {
  FakeDocumentExtractor,
  FakeDocumentScanner,
  FakeKybProvider,
  FakeKycProvider,
  LocalDiskBucket,
  ReplayGuard,
  SandboxClient,
  SandboxKybProvider,
  SandboxDigiLockerProvider,
  SandboxKycProvider,
  SignedUrlFileStore,
  type DocumentExtractor,
  type DocumentScanner,
  type FileStore,
  type KybProvider,
  type KycProvider,
} from "@kilowattx/integrations";
import { PlaceholderPanEncryptor } from "@kilowattx/kyc-pipeline";
import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { AdminController } from "./admin/admin.controller.js";
import { AdminService } from "./admin/admin.service.js";
import {
  AdminDocumentsController,
  DocumentsController,
} from "./documents/documents.controller.js";
import { DocumentsService } from "./documents/documents.service.js";
import {
  AdminLandController,
  LandController,
} from "./land/land.controller.js";
import { LandService } from "./land/land.service.js";
import { FilesController } from "./files/files.controller.js";
import { HealthController } from "./health/health.controller.js";
import { DI, type AppConfig } from "./config.js";
import { DatabaseLifecycle } from "./common/databaseLifecycle.js";
import { StaffGuard } from "./common/staffGuard.js";
import { SessionGuard } from "./common/session.js";
import { DevUsersController } from "./kyc/devUsers.controller.js";
import { DevVendorController } from "./kyc/devVendor.controller.js";
import { KybController } from "./kyb/kyb.controller.js";
import { KybService } from "./kyb/kyb.service.js";
import { KycController } from "./kyc/kyc.controller.js";
import { KycService, type Clock } from "./kyc/kyc.service.js";
import { WebhooksController } from "./kyc/webhooks.controller.js";

/**
 * Application wiring.
 *
 * Two things are deliberate here.
 *
 * Every provider is injected with an explicit @Inject(TOKEN) rather than by
 * constructor parameter type. Type-based injection needs
 * emitDecoratorMetadata, which esbuild — and therefore tsx and Vitest — does
 * not emit. Relying on it produces "Nest can't resolve dependencies" at
 * runtime only, which is a bad way to find out.
 *
 * And the vendor is chosen here, once. Nothing downstream knows which adapter
 * it is talking to, so changing vendor is one line in this file plus a
 * credential.
 */

export interface AppModuleOptions {
  config: AppConfig;
  /** Injectable so tests can pin time and assert on a replay window. */
  clock?: Clock;
  /** Supplied by tests that need to drive the provider directly. */
  kycProvider?: KycProvider;
  kybProvider?: KybProvider;
  fileStore?: FileStore;
  documentScanner?: DocumentScanner;
  documentExtractor?: DocumentExtractor;
}

/**
 * The Sandbox transport, built once and shared.
 *
 * Their access token is good for 24 hours and is held on the client, so one
 * instance across both adapters means one `/authenticate` per process instead
 * of one per provider. Null when no Sandbox adapter is selected, so nothing is
 * constructed — and no credentials are required — for a deployment on the
 * fake.
 */
function buildSandboxClient(config: AppConfig): SandboxClient | null {
  /**
   * Built for both Sandbox routes. DigiLocker is the same vendor on the same
   * key — only the Aadhaar flow differs — so it shares the access token with
   * the KYB adapter exactly as OKYC did.
   */
  if (config.KYC_PROVIDER !== "sandbox" && config.KYC_PROVIDER !== "digilocker") {
    return null;
  }

  return new SandboxClient({
    apiKey: config.KYC_VENDOR_CLIENT_ID!,
    apiSecret: config.KYC_VENDOR_CLIENT_SECRET!,
    nodeEnv: config.NODE_ENV,
  });
}

function buildKycProvider(
  config: AppConfig,
  client: SandboxClient | null,
): KycProvider {
  switch (config.KYC_PROVIDER) {
    case "fake":
      return new FakeKycProvider({
        webhookSecret: config.KYC_WEBHOOK_SECRET,
        /**
         * Development only: which Aadhaar journey the fake pretends to be.
         * Lets the hosted screens be walked without the gateway. Defaults to
         * OTP, which is what every existing test expects.
         */
        aadhaarRoute: process.env.FAKE_AADHAAR_ROUTE === "HOSTED" ? "HOSTED" : "OTP",
      });

    /*
     * Two vendors, both picked for self-serve test credentials so an adapter
     * could be written before any contract existed. Sandbox is primary and
     * written; Cashfree is the failover and is not.
     *
     * What a free test key does NOT buy is live Aadhaar: that is gated by
     * UIDAI licensing rather than by price, and needs the vendor's business
     * onboarding. PAN and GSTIN go live far sooner.
     */
    /**
     * The real gateway. Its Aadhaar OKYC is two calls — OTP out, OTP back —
     * which is the shape this system already had, so nothing downstream
     * changes when this is selected.
     *
     * The adapter is written from their published documents and has not yet
     * been exercised against the live gateway, because that needs a key. The
     * field mapping is the thing to check on the first real call.
     */
    case "sandbox":
      return new SandboxKycProvider({
        apiKey: config.KYC_VENDOR_CLIENT_ID!,
        apiSecret: config.KYC_VENDOR_CLIENT_SECRET!,
        nodeEnv: config.NODE_ENV,
        webhookSecret: config.KYC_WEBHOOK_SECRET,
        client: client ?? undefined,
      });

    /**
     * The replacement Aadhaar route.
     *
     * A hosted flow: the person authenticates at DigiLocker, on the
     * government's own site, and the Aadhaar number never reaches us. See
     * docs/superpowers/specs/2026-10-21-digilocker-migration-design.md.
     */
    case "digilocker":
      if (!client) {
        throw new Error(
          "KYC_PROVIDER=digilocker selected but no Sandbox client was built. " +
            "This is a wiring mistake in app.module, not a configuration one.",
        );
      }
      return new SandboxDigiLockerProvider({
        apiKey: config.KYC_VENDOR_CLIENT_ID!,
        apiSecret: config.KYC_VENDOR_CLIENT_SECRET!,
        nodeEnv: config.NODE_ENV,
        webhookSecret: config.KYC_WEBHOOK_SECRET,
        client,
      });

    case "cashfree":
      throw new Error(
        "KYC_PROVIDER=cashfree: the Cashfree adapter is not implemented yet. " +
          "It is the failover. Sandbox host is https://sandbox.cashfree.com/verification, " +
          "production https://api.cashfree.com/verification.",
      );
  }
}

/**
 * The virus scanner.
 *
 * Refused in production for the sharpest reason on this list: a fake scanner
 * reports every file clean. Booting without a real one would mean the platform
 * serving uploaded files while believing it had checked them.
 */
function buildScanner(config: AppConfig): DocumentScanner {
  if (config.NODE_ENV === "production") {
    throw new Error(
      "The fake document scanner is refused in production. It reports every file CLEAN without scanning anything. Wire up a real scanner before deploying.",
    );
  }
  return new FakeDocumentScanner();
}

/**
 * OCR extraction.
 *
 * Allowed to be missing in production in a way the scanner is not: a wrong
 * extraction sends a document to a human, which is the safe direction. Still
 * refused, because silently pre-filling a form with invented field values is
 * worse than not pre-filling it.
 */
function buildExtractor(config: AppConfig): DocumentExtractor {
  if (config.NODE_ENV === "production") {
    throw new Error(
      "The fake document extractor is refused in production. It returns plausible field values that were never read from the document.",
    );
  }
  return new FakeDocumentExtractor();
}

/**
 * The business-verification adapter.
 *
 * Follows KYC_PROVIDER rather than taking a setting of its own: a deployment
 * running a real KYC vendor with a fake KYB vendor is not a configuration
 * anybody wants, and leaving it expressible means it will eventually happen.
 */
function buildKybProvider(
  config: AppConfig,
  client: SandboxClient | null,
): KybProvider {
  if (config.KYC_PROVIDER === "fake") {
    if (config.NODE_ENV === "production") {
      throw new Error(
        "The fake KYB adapter is refused in production. It verifies no business.",
      );
    }
    return new FakeKybProvider();
  }

  /**
   * The same gateway as the personal checks, on the same key.
   *
   * Sandbox sells PAN, GSTIN and MCA company master data alongside Aadhaar, so
   * the business side needs no second vendor and no second contract — only
   * this adapter. That is also why the client is passed in rather than built:
   * one token serves both.
   */
  /**
   * Both Sandbox routes use the same KYB adapter.
   *
   * DigiLocker covers Aadhaar and nothing else — PAN and GSTIN are still the
   * ordinary Sandbox endpoints, on the same key, and neither is deprecated.
   * Leaving digilocker out here would have thrown at boot with a message
   * about an unimplemented KYB vendor, which is not what is wrong.
   */
  if (config.KYC_PROVIDER === "sandbox" || config.KYC_PROVIDER === "digilocker") {
    if (!client) {
      throw new Error(
        "KYC_PROVIDER=sandbox selected but no Sandbox client was built. " +
          "This is a wiring mistake in app.module, not a configuration one.",
      );
    }
    return new SandboxKybProvider(client);
  }

  throw new Error(
    `KYC_PROVIDER=${config.KYC_PROVIDER}: no KYB adapter is implemented for that vendor yet.`,
  );
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const handle: DatabaseHandle = createClient({
      url: options.config.DATABASE_URL,
    });

    /** One transport for both Sandbox adapters. See buildSandboxClient. */
    const sandboxClient = buildSandboxClient(options.config);

    const providers: Provider[] = [
      { provide: DI.CONFIG, useValue: options.config },
      { provide: DI.DATABASE, useValue: handle.db },
      /** Exposed so tests and graceful shutdown can close the pool. */
      { provide: "DATABASE_HANDLE", useValue: handle },
      {
        provide: DI.KYC_PROVIDER,
        useValue:
          options.kycProvider ?? buildKycProvider(options.config, sandboxClient),
      },
      {
        /**
         * Signzy or IDfy replace this. The fake answers the same three
         * questions — GSTIN, CIN, PAN — from the identifiers themselves, with
         * no vendor contract.
         */
        provide: DI.KYB_PROVIDER,
        useValue:
          options.kybProvider ?? buildKybProvider(options.config, sandboxClient),
      },
      {
        provide: DI.SEEN_EVENT_STORE,
        useValue: new PostgresSeenEventStore(handle.sql),
      },
      {
        provide: DI.REPLAY_GUARD,
        useFactory: (store: PostgresSeenEventStore) => new ReplayGuard(store),
        inject: [DI.SEEN_EVENT_STORE],
      },
      {
        /**
         * HMAC-signed URLs served by this process. A managed bucket's own
         * presigning replaces it;
         * the interface is the same shape, which is the point of it being an
         * interface.
         */
        provide: DI.FILE_STORE,
        useValue:
          options.fileStore ??
          new SignedUrlFileStore({
            secret: options.config.FILE_SIGNING_SECRET,
            baseUrl: options.config.FILE_BASE_URL,
            clock: options.clock,
          }),
      },
      {
        /**
         * A real scanner replaces this, as a hook on the bucket's upload event. The
         * fake refuses to construct in production for the same reason the
         * others do: a scanner that finds nothing is indistinguishable from no
         * scanner at all, right up until it matters.
         */
        provide: DI.DOCUMENT_SCANNER,
        useValue: options.documentScanner ?? buildScanner(options.config),
      },
      {
        /** A real OCR extraction service replaces this. */
        provide: DI.DOCUMENT_EXTRACTOR,
        useValue: options.documentExtractor ?? buildExtractor(options.config),
      },
      {
        /**
         * The development bucket. It refuses to construct in production, so
         * a deploy that has not been given a real bucket fails at boot rather
         * than writing deeds to a container's disk and losing them.
         */
        provide: DI.FILE_BUCKET,
        useValue: new LocalDiskBucket({
          root: options.config.FILE_BUCKET_ROOT,
          nodeEnv: options.config.NODE_ENV,
        }),
      },
      {
        /**
         * The verified-name port.
         *
         * DocumentsService needs the name we verified; KycService needs to
         * know whether a user's land is leasable. Injecting the services into
         * each other would be a cycle, so the need is narrowed to one function
         * and the direction stays one-way.
         */
        provide: DI.VERIFIED_NAME_LOOKUP,
        useFactory: (kyc: KycService) => (userId: string) =>
          kyc.displayNameFor(userId),
        inject: [KycService],
      },
      { provide: DI.CLOCK, useValue: options.clock ?? (() => new Date()) },
      {
        /**
         * The placeholder refuses to construct in production, so a deploy
         * without real envelope encryption fails to start rather than filling the
         * database with plaintext PANs.
         */
        provide: DI.PAN_ENCRYPTOR,
        useValue: new PlaceholderPanEncryptor(options.config.NODE_ENV),
      },
      KycService,
      KybService,
      DocumentsService,
      LandService,
      AdminService,
      SessionGuard,
      StaffGuard,
      /** Drains the connection pool on shutdown. Nothing else references it. */
      DatabaseLifecycle,
    ];

    /**
     * The fake-vendor controller is only registered outside production. It
     * checks NODE_ENV itself as well — two independent guards, because this is
     * the endpoint that completes a verification, and a single condition is
     * one typo away from being wrong.
     */
    const controllers =
      options.config.NODE_ENV === "production"
        ? [
            /** First in both lists: a probe has to work wherever else is broken. */
            HealthController,
            KycController,
            KybController,
            DocumentsController,
            LandController,
            WebhooksController,
            AdminController,
            AdminDocumentsController,
            AdminLandController,
          ]
        : [
            HealthController,
            KycController,
            KybController,
            DocumentsController,
            WebhooksController,
            LandController,
            AdminController,
            AdminDocumentsController,
            AdminLandController,
            /**
             * Only outside production. In production the browser PUTs to the
             * real bucket, and these routes — which authorise by signature
             * alone — should not exist at all.
             */
            FilesController,
            DevVendorController,
            DevUsersController,
          ];

    return {
      module: AppModule,
      controllers,
      providers,
      exports: [
        DI.CONFIG,
        DI.DATABASE,
        DI.KYC_PROVIDER,
        DI.KYB_PROVIDER,
        KycService,
        KybService,
        AdminService,
      ],
    };
  }
}

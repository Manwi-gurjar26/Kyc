/**
 * Sending messages.
 *
 * Behind an interface for the same reason as the KYC vendor: there are no
 * credentials. WhatsApp needs a Business Service Provider and template
 * approvals that take weeks; SMS needs MSG91 with DLT templates registered
 * against our sender id; push needs FCM and APNs keys.
 *
 * So the transport is pluggable, and the one that exists records what it
 * would have sent. That is deliberately not a no-op: the delivery row is
 * written either way, so "did you tell me?" has an answer, and swapping in a
 * real transport changes which class is constructed and nothing else.
 */

export type NotificationChannel = "PUSH" | "WHATSAPP" | "SMS" | "EMAIL" | "IN_APP";

export interface NotificationMessage {
  userId: string;
  channel: NotificationChannel;
  /** Template name, never rendered text — the text may quote the person. */
  template: string;
  locale: "en" | "hi";
  /** Values the template fills in. Reason codes, never reason detail. */
  variables: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  provider: string;
}

export interface NotificationSender {
  readonly name: string;
  readonly channels: readonly NotificationChannel[];
  send(message: NotificationMessage): Promise<SendResult>;
}

/**
 * A sender that records rather than sends.
 *
 * Returns a provider message id so the rest of the pipeline is exercised
 * exactly as it will be in production, including the delivery row and its
 * unique index.
 */
export class RecordingNotificationSender implements NotificationSender {
  readonly name = "recording";
  readonly channels = ["PUSH", "WHATSAPP", "SMS", "EMAIL", "IN_APP"] as const;

  private readonly sent: NotificationMessage[] = [];

  constructor(private readonly log: (line: string) => void = () => {}) {}

  async send(message: NotificationMessage): Promise<SendResult> {
    this.sent.push(message);

    this.log(
      `[notify] ${message.channel} -> ${message.userId.slice(0, 8)}… ` +
        `template=${message.template} locale=${message.locale} ` +
        `vars=${JSON.stringify(message.variables)}`,
    );

    return {
      provider: this.name,
      providerMessageId: `rec_${Math.random().toString(36).slice(2, 14)}`,
    };
  }

  /** Test helper. */
  get history(): readonly NotificationMessage[] {
    return this.sent;
  }
}

/**
 * A sender that always fails, for exercising retry and dead-lettering.
 *
 * Worth having as a first-class thing rather than a mock: the behaviour under
 * a vendor outage is a feature, and it should be testable end to end.
 */
export class FailingNotificationSender implements NotificationSender {
  readonly name = "failing";
  readonly channels = ["PUSH", "WHATSAPP", "SMS", "EMAIL", "IN_APP"] as const;

  constructor(private readonly message = "provider returned 503") {}

  async send(): Promise<SendResult> {
    throw new Error(this.message);
  }
}

/**
 * Which channels and template each event uses.
 *
 * The stack doc's design is a rules table rather than code, so that adding a
 * notification means adding a row and a template instead of a deployment.
 * This is that table, in the only form available until the templates module
 * exists.
 */
export interface NotificationRule {
  channels: NotificationChannel[];
  template: string;
}

export const NOTIFICATION_RULES: Record<string, NotificationRule> = {
  "kyc.verified": {
    /**
     * Push and WhatsApp. Push is free and instant; WhatsApp is what actually
     * gets read, and reaches someone who has uninstalled the app.
     */
    channels: ["PUSH", "WHATSAPP"],
    template: "kyc_verified",
  },
  "kyc.review_required": {
    channels: ["PUSH", "WHATSAPP"],
    template: "kyc_under_review",
  },
  "kyc.rejected": {
    channels: ["PUSH", "WHATSAPP"],
    template: "kyc_rejected",
  },
  "kyc.resubmission_requested": {
    /**
     * This one asks the person to do something, so it goes everywhere. A
     * re-upload request nobody sees is a case that sits in the queue until it
     * ages out and support calls them anyway.
     */
    channels: ["PUSH", "WHATSAPP", "SMS"],
    template: "kyc_resubmission_requested",
  },
};

CREATE TYPE "public"."notification_channel" AS ENUM('PUSH', 'WHATSAPP', 'SMS', 'EMAIL', 'IN_APP');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_event_id" uuid,
	"user_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"template" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_outbox_event_id_outbox_events_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_once_per_event_channel" ON "notification_deliveries" USING btree ("outbox_event_id","user_id","channel");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification_deliveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_status_idx" ON "notification_deliveries" USING btree ("status");
CREATE TABLE "public_pay_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" varchar(40) NOT NULL,
	"source_asset" varchar(8) NOT NULL,
	"source_amount_atomic" varchar(80) NOT NULL,
	"deposit_address" varchar(128) NOT NULL,
	"source_txid" varchar(128),
	"destination_network" varchar(24) NOT NULL,
	"destination_asset" varchar(8) NOT NULL,
	"destination_address" varchar(128) NOT NULL,
	"expected_output_atomic" varchar(80) NOT NULL,
	"quote" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'awaiting_funding' NOT NULL,
	"payout_txid" varchar(128),
	"payout_signed_payload" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_pay_intents_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE INDEX "public_pay_intents_created_idx" ON "public_pay_intents" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "public_pay_intents_source_txid_idx" ON "public_pay_intents" USING btree ("source_txid");
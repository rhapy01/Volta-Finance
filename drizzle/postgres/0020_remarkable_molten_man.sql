CREATE TABLE "evm_crosschain_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" varchar(40) NOT NULL,
	"workspace_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"invoice_public_id" varchar(32),
	"source_asset" varchar(8) NOT NULL,
	"source_amount_atomic" varchar(80) NOT NULL,
	"deposit_address" varchar(128) NOT NULL,
	"source_txid" varchar(128),
	"destination_network" varchar(24) NOT NULL,
	"destination_asset" varchar(8) NOT NULL,
	"destination_address" varchar(128) NOT NULL,
	"expected_output_atomic" varchar(80) NOT NULL,
	"payout_txid" varchar(128),
	"quote" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'awaiting_funding' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evm_crosschain_intents_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "evm_funding_address" varchar(128);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "evm_funding_amount_atomic" varchar(80);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "evm_funding_txid" varchar(128);--> statement-breakpoint
ALTER TABLE "evm_crosschain_intents" ADD CONSTRAINT "evm_crosschain_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evm_crosschain_intents" ADD CONSTRAINT "evm_crosschain_intents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evm_crosschain_intents_workspace_created_idx" ON "evm_crosschain_intents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "evm_crosschain_intents_invoice_idx" ON "evm_crosschain_intents" USING btree ("invoice_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evm_crosschain_intents_source_txid_idx" ON "evm_crosschain_intents" USING btree ("source_txid");
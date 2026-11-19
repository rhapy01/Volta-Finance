CREATE TABLE "crosschain_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" varchar(40) NOT NULL,
	"workspace_id" integer NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"source_asset" varchar(8) DEFAULT 'PUSD' NOT NULL,
	"source_network" varchar(16) DEFAULT 'chipnet' NOT NULL,
	"source_amount_atomic" varchar(80) NOT NULL,
	"deposit_address" varchar(128) NOT NULL,
	"source_txid" varchar(128),
	"destination_network" varchar(24) DEFAULT 'stellar-testnet' NOT NULL,
	"destination_asset" varchar(8) DEFAULT 'XLM' NOT NULL,
	"destination_address" varchar(80) NOT NULL,
	"expected_output_atomic" varchar(80) NOT NULL,
	"quote" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'awaiting_payment' NOT NULL,
	"stellar_txid" varchar(128),
	"stellar_signed_xdr" text,
	"failure_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crosschain_intents_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "crosschain_intents" ADD CONSTRAINT "crosschain_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crosschain_intents" ADD CONSTRAINT "crosschain_intents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crosschain_intents_workspace_created_idx" ON "crosschain_intents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crosschain_intents_source_txid_idx" ON "crosschain_intents" USING btree ("source_txid");--> statement-breakpoint
CREATE UNIQUE INDEX "crosschain_intents_stellar_txid_idx" ON "crosschain_intents" USING btree ("stellar_txid");

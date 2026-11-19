CREATE TABLE "payment_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"asset" varchar(8) NOT NULL,
	"network" varchar(16) DEFAULT 'mainnet' NOT NULL,
	"address" varchar(128) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_destinations" ADD CONSTRAINT "payment_destinations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_destinations_user_asset_idx" ON "payment_destinations" USING btree ("user_id","asset","network");
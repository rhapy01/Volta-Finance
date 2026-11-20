CREATE TABLE "evm_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"network" varchar(24) NOT NULL,
	"asset" varchar(8) NOT NULL,
	"address" varchar(42) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evm_destinations" ADD CONSTRAINT "evm_destinations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evm_destinations_user_network_asset_address_unique" ON "evm_destinations" USING btree ("user_id","network","asset","address");--> statement-breakpoint
CREATE INDEX "evm_destinations_user_network_asset_idx" ON "evm_destinations" USING btree ("user_id","network","asset","created_at");
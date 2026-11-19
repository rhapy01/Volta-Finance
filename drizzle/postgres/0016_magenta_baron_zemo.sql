CREATE TABLE "stellar_destinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"address" varchar(56) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stellar_destinations" ADD CONSTRAINT "stellar_destinations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stellar_destinations_user_address_unique" ON "stellar_destinations" USING btree ("user_id","address");--> statement-breakpoint
CREATE INDEX "stellar_destinations_user_idx" ON "stellar_destinations" USING btree ("user_id","created_at");
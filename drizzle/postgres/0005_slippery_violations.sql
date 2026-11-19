ALTER TABLE "invoices" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recipient_user_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recipient_workspace_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recipient_email" varchar(320);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sender_name" varchar(200);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sender_email" varchar(320);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "direction" varchar(16) DEFAULT 'receivable' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recipient_workspace_id_workspaces_id_fk" FOREIGN KEY ("recipient_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_recipient_inbox_idx" ON "invoices" USING btree ("recipient_workspace_id","recipient_user_id","created_at");
ALTER TABLE "crosschain_intents" ADD COLUMN "invoice_public_id" varchar(32);--> statement-breakpoint
CREATE INDEX "crosschain_intents_invoice_idx" ON "crosschain_intents" USING btree ("invoice_public_id");--> statement-breakpoint

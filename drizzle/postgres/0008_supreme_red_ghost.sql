ALTER TABLE "invoices" ADD COLUMN "request_asset" varchar(8) DEFAULT 'USDT' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "received_amount_atomic" varchar(80);
--> statement-breakpoint
UPDATE invoices SET request_asset = asset WHERE created_at IS NOT NULL;

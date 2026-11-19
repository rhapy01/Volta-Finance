ALTER TABLE "payroll_runs" ADD COLUMN "stellar_funding_address" varchar(128);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "stellar_funding_amount_atomic" varchar(80);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "stellar_funding_txid" varchar(128);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "stellar_payout_txid" varchar(128);--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "stellar_payout_signed_xdr" text;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "stellar_payout_quote" jsonb;
ALTER TABLE "audit_events" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "crosschain_intents" ADD COLUMN "data_network" varchar(16) DEFAULT 'testnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "evm_crosschain_intents" ADD COLUMN "data_network" varchar(16) DEFAULT 'testnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
UPDATE "audit_events" SET "data_network" = 'testnet';--> statement-breakpoint
UPDATE "invoices" SET "data_network" = 'testnet';--> statement-breakpoint
UPDATE "payment_intents" SET "data_network" = 'testnet';--> statement-breakpoint
UPDATE "payroll_runs" SET "data_network" = 'testnet';--> statement-breakpoint
UPDATE "ledger_entries" SET "data_network" = 'testnet';

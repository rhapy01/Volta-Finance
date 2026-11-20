ALTER TABLE "notifications" ADD COLUMN "data_network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "public_pay_intents" ADD COLUMN "data_network" varchar(16) DEFAULT 'testnet' NOT NULL;--> statement-breakpoint
UPDATE "notifications" SET "data_network" = 'testnet';--> statement-breakpoint
UPDATE "public_pay_intents" SET "data_network" = 'testnet';

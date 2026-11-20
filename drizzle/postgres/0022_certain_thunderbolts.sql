DROP INDEX "stellar_destinations_user_address_unique";--> statement-breakpoint
ALTER TABLE "evm_destinations" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_destinations" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stellar_destinations" ADD COLUMN "network" varchar(24) DEFAULT 'stellar-testnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "stellar_destinations" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stellar_destinations_user_network_address_unique" ON "stellar_destinations" USING btree ("user_id","network","address");
--> statement-breakpoint
-- Keep the old test network profile data for reference while making reusable
-- public addresses available as separate active Mainnet profile entries.
UPDATE "payment_destinations" SET "is_archived" = true WHERE "network" = 'chipnet';
--> statement-breakpoint
UPDATE "wallets" SET "is_archived" = true WHERE "network" IN ('chipnet', 'testnet');
--> statement-breakpoint
INSERT INTO "stellar_destinations" ("user_id", "label", "address", "network", "is_default", "is_archived")
SELECT "user_id", "label", "address", 'stellar-mainnet', "is_default", false FROM "stellar_destinations" WHERE "network" = 'stellar-testnet'
ON CONFLICT ("user_id", "network", "address") DO NOTHING;
--> statement-breakpoint
UPDATE "stellar_destinations" SET "is_archived" = true, "is_default" = false WHERE "network" = 'stellar-testnet';
--> statement-breakpoint
INSERT INTO "evm_destinations" ("user_id", "label", "network", "asset", "address", "is_default", "is_archived")
SELECT "user_id", "label", CASE "network" WHEN 'base-sepolia' THEN 'base-mainnet' ELSE 'arc-mainnet' END, "asset", "address", "is_default", false
FROM "evm_destinations" WHERE "network" IN ('base-sepolia', 'arc-testnet')
ON CONFLICT ("user_id", "network", "asset", "address") DO NOTHING;
--> statement-breakpoint
UPDATE "evm_destinations" SET "is_archived" = true, "is_default" = false WHERE "network" IN ('base-sepolia', 'arc-testnet');

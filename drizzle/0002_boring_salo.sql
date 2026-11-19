CREATE TABLE `blockchainTransactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`intentId` int,
	`txid` varchar(128),
	`status` enum('unsigned','signed','broadcast','confirmed','failed') NOT NULL DEFAULT 'unsigned',
	`network` enum('mainnet','chipnet','testnet') NOT NULL DEFAULT 'mainnet',
	`unsignedTxHex` text,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `blockchainTransactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `paymentIntents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publicId` varchar(40) NOT NULL,
	`workspaceId` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`payerAsset` enum('BCH','PUSD','MUSD') NOT NULL,
	`recipientAsset` enum('BCH','PUSD','MUSD') NOT NULL,
	`inputAmountAtomic` varchar(80) NOT NULL,
	`expectedOutputAtomic` varchar(80) NOT NULL,
	`status` enum('quoted','awaiting_funding','awaiting_signature','broadcast','pending_verification','completed','failed') NOT NULL DEFAULT 'quoted',
	`quote` json NOT NULL,
	`txid` varchar(128),
	`failureReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `paymentIntents_id` PRIMARY KEY(`id`),
	CONSTRAINT `paymentIntents_publicId_unique` UNIQUE(`publicId`)
);

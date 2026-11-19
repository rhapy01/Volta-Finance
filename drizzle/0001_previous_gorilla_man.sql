CREATE TABLE `auditEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`actorUserId` int NOT NULL,
	`action` varchar(120) NOT NULL,
	`entityType` varchar(80) NOT NULL,
	`entityId` varchar(128),
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publicId` varchar(32) NOT NULL,
	`workspaceId` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`clientName` varchar(200) NOT NULL,
	`amountAtomic` varchar(80) NOT NULL,
	`displayAmount` varchar(80) NOT NULL,
	`asset` enum('BCH','PUSD','MUSD') NOT NULL,
	`dueDate` varchar(40) NOT NULL,
	`status` enum('draft','awaiting_payment','awaiting_verification','paid','expired','cancelled') NOT NULL DEFAULT 'draft',
	`externalInvoiceId` varchar(128),
	`paymentTxid` varchar(128),
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_publicId_unique` UNIQUE(`publicId`)
);
--> statement-breakpoint
CREATE TABLE `ledgerEntries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`invoiceId` int,
	`asset` enum('BCH','PUSD','MUSD') NOT NULL,
	`amountAtomic` varchar(80) NOT NULL,
	`direction` enum('debit','credit') NOT NULL,
	`state` enum('pending','posted','reversed') NOT NULL DEFAULT 'pending',
	`externalTxid` varchar(128),
	`account` varchar(120) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledgerEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`provider` varchar(64) NOT NULL,
	`network` enum('mainnet','chipnet','testnet') NOT NULL DEFAULT 'mainnet',
	`connectionStatus` enum('pending','connected','disconnected') NOT NULL DEFAULT 'pending',
	`xpub` text,
	`address` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wallets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaceMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','admin','employee') NOT NULL DEFAULT 'employee',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspaceMembers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ownerUserId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`)
);

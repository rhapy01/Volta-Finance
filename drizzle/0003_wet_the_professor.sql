CREATE TABLE `employees` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`fullName` varchar(200) NOT NULL,
	`email` varchar(320),
	`roleTitle` varchar(120) NOT NULL,
	`walletAddress` varchar(128),
	`preferredAsset` enum('BCH','PUSD','MUSD') NOT NULL,
	`monthlyAmountAtomic` varchar(80) NOT NULL,
	`monthlyDisplayAmount` varchar(80) NOT NULL,
	`active` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employees_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payrollItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`employeeId` int NOT NULL,
	`amountAtomic` varchar(80) NOT NULL,
	`displayAmount` varchar(80) NOT NULL,
	`asset` enum('BCH','PUSD','MUSD') NOT NULL,
	`status` enum('pending','quoted','awaiting_signature','broadcast','verified','failed') NOT NULL DEFAULT 'pending',
	`intentId` int,
	`txid` varchar(128),
	`failureReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payrollItems_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payrollRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publicId` varchar(40) NOT NULL,
	`workspaceId` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`period` varchar(40) NOT NULL,
	`sourceAsset` enum('BCH','PUSD','MUSD') NOT NULL,
	`totalAmountAtomic` varchar(80) NOT NULL,
	`status` enum('draft','approved','processing','completed','partial','failed') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payrollRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `payrollRuns_publicId_unique` UNIQUE(`publicId`)
);
--> statement-breakpoint
CREATE TABLE `payslips` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publicId` varchar(40) NOT NULL,
	`workspaceId` int NOT NULL,
	`runId` int NOT NULL,
	`payrollItemId` int NOT NULL,
	`employeeId` int NOT NULL,
	`status` enum('pending','available') NOT NULL DEFAULT 'pending',
	`documentHtml` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payslips_id` PRIMARY KEY(`id`),
	CONSTRAINT `payslips_publicId_unique` UNIQUE(`publicId`)
);

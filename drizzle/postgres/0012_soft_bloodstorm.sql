ALTER TABLE "employees" ADD COLUMN "monthly_amount_unit" varchar(8) DEFAULT 'BCH' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "requested_amount_atomic" varchar(80) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD COLUMN "requested_amount_unit" varchar(8) DEFAULT 'BCH' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD COLUMN "total_amount_unit" varchar(8) DEFAULT 'BCH' NOT NULL;
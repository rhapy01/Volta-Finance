ALTER TABLE "workspaces" ADD COLUMN "type" varchar(20) DEFAULT 'personal' NOT NULL;--> statement-breakpoint
UPDATE workspaces SET type = CASE WHEN lower(name) IN ('personal workspace', 'personal account') THEN 'personal' ELSE 'organization' END;--> statement-breakpoint
UPDATE workspaces SET name = 'Personal account' WHERE type = 'personal' AND lower(name) = 'personal workspace';

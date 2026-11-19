import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export type Asset = "BCH" | "PUSD" | "MUSD";
export type PayrollAsset = Asset | "XLM" | "USDC";
export type TreasuryPlanConfiguration = {
  allocations: { tax: number; savings: number; payroll: number; operating: number };
  reserveGoal: { amount: string; asset: Asset; targetDate: string | null } | null;
  recurringPlan: { purpose: "tax" | "savings" | "payroll" | "operating"; amount: string; asset: Asset; cadence: "weekly" | "monthly" } | null;
};
/** TOKEN stores one CashTokens-compatible receive address, valid for PUSD and MUSD. */
export type PaymentDestinationAsset = Asset | "TOKEN";
export type Network = "mainnet" | "chipnet" | "testnet";

const updatedAt = (name: string) => timestamp(name, { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull();
const createdAt = (name = "created_at") => timestamp(name, { withTimezone: true }).defaultNow().notNull();
const enumText = <T extends string>(name: string, length = 40) => varchar(name, { length }).$type<T>();

/** App-owned email/password accounts. Passwords are stored only as scrypt hashes. */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  loginMethod: varchar("login_method", { length: 64 }).default("email_password").notNull(),
  role: enumText<"user" | "admin">("role", 16).default("user").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
  lastSignedIn: createdAt("last_signed_in"),
});

/** Opaque session tokens are never stored in plaintext. */
export const userSessions = pgTable("user_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [index("user_sessions_user_id_idx").on(table.userId), index("user_sessions_expires_at_idx").on(table.expiresAt)]);

export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  ownerUserId: integer("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  type: enumText<"personal" | "organization">("type", 20).default("personal").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("workspaces_owner_user_id_idx").on(table.ownerUserId)]);

export const workspaceMembers = pgTable("workspace_members", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: enumText<"owner" | "admin" | "employee">("role", 16).default("employee").notNull(),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId), index("workspace_members_user_id_idx").on(table.userId)]);

export const userWorkspacePreferences = pgTable("user_workspace_preferences", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  updatedAt: updatedAt("updated_at"),
});

/** Personal treasury planning targets. These are configuration, not wallet balances or transfers. */
export const treasuryPlans = pgTable("treasury_plans", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().unique().references(() => workspaces.id, { onDelete: "cascade" }),
  configuration: jsonb("configuration").$type<TreasuryPlanConfiguration>().notNull(),
  updatedByUserId: integer("updated_by_user_id").notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
});

export const workspaceInvites = pgTable("workspace_invites", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  role: enumText<"admin" | "employee">("role", 16).default("employee").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  invitedByUserId: integer("invited_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("workspace_invites_workspace_created_idx").on(table.workspaceId, table.createdAt), index("workspace_invites_email_idx").on(table.email)]);

/** Multiple WizardConnect-compatible wallet accounts can be linked to a user. */
export const wallets = pgTable("wallets", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 64 }).notNull(),
  network: enumText<Network>("network", 16).default("mainnet").notNull(),
  connectionStatus: enumText<"pending" | "connected" | "disconnected">("connection_status", 16).default("connected").notNull(),
  address: varchar("address", { length: 128 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [uniqueIndex("wallets_user_network_address_unique").on(table.userId, table.network, table.address), index("wallets_workspace_user_idx").on(table.workspaceId, table.userId)]);

/** User-managed payment destinations; kept separate from WizardConnect signing sessions. */
export const paymentDestinations = pgTable("payment_destinations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 80 }).notNull(),
  asset: enumText<PaymentDestinationAsset>("asset", 8).notNull(),
  network: enumText<Network>("network", 16).default("mainnet").notNull(),
  address: varchar("address", { length: 128 }).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("payment_destinations_user_asset_idx").on(table.userId, table.asset, table.network)]);

/** Stellar Testnet public receiving addresses saved by the account owner. */
export const stellarDestinations = pgTable("stellar_destinations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  label: varchar("label", { length: 80 }).notNull(),
  address: varchar("address", { length: 56 }).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [uniqueIndex("stellar_destinations_user_address_unique").on(table.userId, table.address), index("stellar_destinations_user_idx").on(table.userId, table.createdAt)]);

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  publicId: varchar("public_id", { length: 32 }).notNull().unique(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").references(() => users.id),
  recipientUserId: integer("recipient_user_id").references(() => users.id, { onDelete: "set null" }),
  recipientWorkspaceId: integer("recipient_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  recipientEmail: varchar("recipient_email", { length: 320 }),
  senderName: varchar("sender_name", { length: 200 }),
  senderEmail: varchar("sender_email", { length: 320 }),
  description: text("description"),
  direction: enumText<"receivable" | "payable">("direction", 16).default("receivable").notNull(),
  clientName: varchar("client_name", { length: 200 }).notNull(),
  amountAtomic: varchar("amount_atomic", { length: 80 }).notNull(),
  displayAmount: varchar("display_amount", { length: 80 }).notNull(),
  requestAsset: enumText<"USDT" | Asset>("request_asset", 8).default("USDT").notNull(),
  receivedAmountAtomic: varchar("received_amount_atomic", { length: 80 }),
  asset: enumText<Asset>("asset", 8).notNull(),
  deliveryAsset: enumText<"XLM">("delivery_asset", 8),
  deliveryNetwork: enumText<"stellar-testnet">("delivery_network", 24),
  dueDate: varchar("due_date", { length: 40 }).notNull(),
  receivingAddress: varchar("receiving_address", { length: 128 }),
  status: enumText<"draft" | "submitted" | "awaiting_payment" | "awaiting_verification" | "paid" | "expired" | "cancelled">("status", 32).default("draft").notNull(),
  externalInvoiceId: varchar("external_invoice_id", { length: 128 }),
  paymentTxid: varchar("payment_txid", { length: 128 }),
  receiptHtml: text("receipt_html"),
  metadata: jsonb("metadata"),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("invoices_workspace_created_idx").on(table.workspaceId, table.createdAt), index("invoices_external_invoice_id_idx").on(table.externalInvoiceId), index("invoices_recipient_inbox_idx").on(table.recipientWorkspaceId, table.recipientUserId, table.createdAt)]);

export const paymentIntents = pgTable("payment_intents", {
  id: serial("id").primaryKey(),
  publicId: varchar("public_id", { length: 40 }).notNull().unique(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  payerAsset: enumText<Asset>("payer_asset", 8).notNull(),
  recipientAsset: enumText<Asset>("recipient_asset", 8).notNull(),
  recipientAddress: varchar("recipient_address", { length: 128 }),
  inputAmountAtomic: varchar("input_amount_atomic", { length: 80 }).notNull(),
  expectedOutputAtomic: varchar("expected_output_atomic", { length: 80 }).notNull(),
  status: enumText<"quoted" | "awaiting_funding" | "awaiting_signature" | "broadcast" | "pending_verification" | "completed" | "failed">("status", 32).default("quoted").notNull(),
  quote: jsonb("quote").notNull(),
  txid: varchar("txid", { length: 128 }),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("payment_intents_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const crosschainIntents = pgTable("crosschain_intents", {
  id: serial("id").primaryKey(),
  publicId: varchar("public_id", { length: 40 }).notNull().unique(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  sourceAsset: enumText<"BCH" | "PUSD">("source_asset", 8).default("PUSD").notNull(),
  sourceNetwork: enumText<"chipnet">("source_network", 16).default("chipnet").notNull(),
  sourceAmountAtomic: varchar("source_amount_atomic", { length: 80 }).notNull(),
  invoicePublicId: varchar("invoice_public_id", { length: 32 }),
  depositAddress: varchar("deposit_address", { length: 128 }).notNull(),
  sourceTxid: varchar("source_txid", { length: 128 }),
  destinationNetwork: enumText<"stellar-testnet">("destination_network", 24).default("stellar-testnet").notNull(),
  destinationAsset: enumText<"XLM">("destination_asset", 8).default("XLM").notNull(),
  destinationAddress: varchar("destination_address", { length: 80 }).notNull(),
  expectedOutputAtomic: varchar("expected_output_atomic", { length: 80 }).notNull(),
  quote: jsonb("quote").notNull(),
  status: enumText<"awaiting_payment" | "pending_verification" | "paying" | "completed" | "failed" | "expired">("status", 32).default("awaiting_payment").notNull(),
  stellarTxid: varchar("stellar_txid", { length: 128 }),
  stellarSignedXdr: text("stellar_signed_xdr"),
  failureReason: text("failure_reason"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
  }, (table) => [index("crosschain_intents_workspace_created_idx").on(table.workspaceId, table.createdAt), index("crosschain_intents_invoice_idx").on(table.invoicePublicId), uniqueIndex("crosschain_intents_source_txid_idx").on(table.sourceTxid), uniqueIndex("crosschain_intents_stellar_txid_idx").on(table.stellarTxid)]);

export const blockchainTransactions = pgTable("blockchain_transactions", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  intentId: integer("intent_id").references(() => paymentIntents.id),
  txid: varchar("txid", { length: 128 }),
  status: enumText<"unsigned" | "signed" | "broadcast" | "confirmed" | "failed">("status", 16).default("unsigned").notNull(),
  network: enumText<Network>("network", 16).default("mainnet").notNull(),
  unsignedTxHex: text("unsigned_tx_hex"),
  metadata: jsonb("metadata"),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("blockchain_transactions_intent_idx").on(table.intentId)]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoices.id),
  asset: enumText<Asset>("asset", 8).notNull(),
  amountAtomic: varchar("amount_atomic", { length: 80 }).notNull(),
  direction: enumText<"debit" | "credit">("direction", 8).notNull(),
  state: enumText<"pending" | "posted" | "reversed">("state", 16).default("pending").notNull(),
  externalTxid: varchar("external_txid", { length: 128 }),
  account: varchar("account", { length: 120 }).notNull(),
  createdAt: createdAt(),
}, (table) => [index("ledger_entries_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const auditEvents = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id").notNull().references(() => users.id),
  action: varchar("action", { length: 120 }).notNull(),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: varchar("entity_id", { length: 128 }),
  metadata: jsonb("metadata"),
  createdAt: createdAt(),
}, (table) => [index("audit_events_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

/** Inbox events belong to an email/password account, never to a wallet connection. */
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  recipientUserId: integer("recipient_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  category: enumText<"invoice" | "payment" | "payroll" | "team" | "system">("category", 16).notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  body: text("body").notNull(),
  href: varchar("href", { length: 240 }),
  entityType: varchar("entity_type", { length: 64 }),
  entityId: varchar("entity_id", { length: 128 }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("notifications_recipient_created_idx").on(table.recipientUserId, table.createdAt), index("notifications_recipient_read_idx").on(table.recipientUserId, table.readAt)]);

export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fullName: varchar("full_name", { length: 200 }).notNull(),
  email: varchar("email", { length: 320 }),
  roleTitle: varchar("role_title", { length: 120 }).notNull(),
  walletAddress: varchar("wallet_address", { length: 128 }),
  preferredAsset: enumText<PayrollAsset>("preferred_asset", 8).notNull(),
  monthlyAmountAtomic: varchar("monthly_amount_atomic", { length: 80 }).notNull(),
  monthlyDisplayAmount: varchar("monthly_display_amount", { length: 80 }).notNull(),
  monthlyAmountUnit: enumText<"USDT" | Asset>("monthly_amount_unit", 8).default("BCH").notNull(),
  active: integer("active").default(1).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("employees_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const payrollRuns = pgTable("payroll_runs", {
  id: serial("id").primaryKey(),
  publicId: varchar("public_id", { length: 40 }).notNull().unique(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
  period: varchar("period", { length: 40 }).notNull(),
  sourceAsset: enumText<Asset>("source_asset", 8).notNull(),
  totalAmountAtomic: varchar("total_amount_atomic", { length: 80 }).notNull(),
  totalAmountUnit: enumText<"USDT" | Asset>("total_amount_unit", 8).default("BCH").notNull(),
  stellarFundingAddress: varchar("stellar_funding_address", { length: 128 }),
  stellarFundingAmountAtomic: varchar("stellar_funding_amount_atomic", { length: 80 }),
  stellarFundingTxid: varchar("stellar_funding_txid", { length: 128 }),
  stellarPayoutTxid: varchar("stellar_payout_txid", { length: 128 }),
  stellarPayoutSignedXdr: text("stellar_payout_signed_xdr"),
  stellarPayoutQuote: jsonb("stellar_payout_quote"),
  status: enumText<"draft" | "approved" | "processing" | "completed" | "partial" | "failed" | "cancelled">("status", 16).default("draft").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("payroll_runs_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const payrollItems = pgTable("payroll_items", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => payrollRuns.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  payoutAddress: varchar("payout_address", { length: 128 }),
  amountAtomic: varchar("amount_atomic", { length: 80 }).notNull(),
  requestedAmountAtomic: varchar("requested_amount_atomic", { length: 80 }).default("0").notNull(),
  displayAmount: varchar("display_amount", { length: 80 }).notNull(),
  requestedAmountUnit: enumText<"USDT" | Asset>("requested_amount_unit", 8).default("BCH").notNull(),
  asset: enumText<PayrollAsset>("asset", 8).notNull(),
  status: enumText<"pending" | "quoted" | "awaiting_signature" | "broadcast" | "verified" | "failed">("status", 24).default("pending").notNull(),
  intentId: integer("intent_id").references(() => paymentIntents.id),
  txid: varchar("txid", { length: 128 }),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt("updated_at"),
}, (table) => [index("payroll_items_run_idx").on(table.workspaceId, table.runId)]);

export const payslips = pgTable("payslips", {
  id: serial("id").primaryKey(),
  publicId: varchar("public_id", { length: 40 }).notNull().unique(),
  workspaceId: integer("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: integer("run_id").notNull().references(() => payrollRuns.id, { onDelete: "cascade" }),
  payrollItemId: integer("payroll_item_id").notNull().references(() => payrollItems.id),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  status: enumText<"pending" | "available">("status", 16).default("pending").notNull(),
  documentHtml: text("document_html"),
  createdAt: createdAt(),
}, (table) => [index("payslips_workspace_run_idx").on(table.workspaceId, table.runId)]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type PaymentDestination = typeof paymentDestinations.$inferSelect;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type BlockchainTransaction = typeof blockchainTransactions.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type PayrollItem = typeof payrollItems.$inferSelect;
export type Payslip = typeof payslips.$inferSelect;

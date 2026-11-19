# Volta Finance delivery TODO

## 1. Shared BCH financial workspace foundation
- [x] Provide one interconnected application with shared navigation, asset terminology, wallet/integration status, transaction status, and records language across Payments and Invoicing, Global Payroll, Smart Treasury, Local Currency Access, and Financial Records.
- [x] Establish a premium financial application rather than a cryptocurrency trading terminal: clean, modern, professional, responsive desktop/mobile layouts, consistent navigation, clear dashboards, reusable components, and useful empty, loading, success, and error states.
- [x] Keep Bitcoin Cash as the only blockchain context and use BCH, PUSD, and MUSD as the supported assets; do not introduce NEAR, multichain architecture, cross-chain bridges, or external blockchain settlement.
- [x] Never present invented wallet balances, transactions, confirmations, or fiat settlement. Clearly distinguish actual blockchain balances, pending transactions, and internal accounting allocations.

## 2. Payments and invoicing workflow
- [x] Create and manage invoice drafts from the workspace; allow a requested receiving asset of BCH, PUSD, or MUSD; show the payer/recipient route and state when verification is still pending.
- [x] Deliver in-platform invoices to registered Volta Finance recipients, let unauthenticated suppliers submit invoice details to a registered recipient for review, and keep paid receipts on the same recipient/sender dashboard record without document uploads or downloads.
- [x] Support direct same-asset invoice batch payments for up to five invoices, verify every recipient output, retain the correct HD signing paths, and skip Cauldron liquidity when payer and requested assets match.
- [x] Expose the three-asset payment router across all BCH/PUSD/MUSD payer-to-recipient combinations, with asset identification, quote state, route, fee/slippage disclosure, and recipient settlement status represented in the UI.
- [x] Connect the route quote request to the public Cauldron Router WebSocket for live BCH↔CashToken quotes, using exact smallest-unit amounts, the verified PUSD/MUSD category IDs, provider pool counts, and explicit error states.
- [x] Add and compile CashScript covenant primitives for treasury withdrawal/recovery, recurring payroll, and non-custodial P2P escrow; keep deployment Chipnet-first until contracts are tested and reviewed.
- [x] Derive a bounded BCH receive-address range from WizardConnect public keys, follow Electrum address history with a 20-address gap rule, retain each UTXO's HD index for signing, and expose authenticated UTXOs to payments, payroll, and wallet balance views.
- [x] Implement the official WizardConnect sign-request shape and Cauldron broadcast helper; require explicit user wallet approval and never handle seed phrases or private keys.
- [x] Persist quoted payment intents and blockchain transaction lifecycle state in additive managed-database tables with workspace ownership checks.
- [x] Implement the provider-backed execution controller: select actual wallet UTXOs, build the Cauldron transaction, map funding inputs to WizardConnect HD paths, request explicit signing, broadcast, poll confirmations, verify the exact recipient locking script and BCH/CashToken category/amount, and post final double-entry ledger records; token/token intents execute as two sequential BCH-intermediate legs.
- [x] Create real Payment Hub invoice links from saved invoices, persist the external invoice ID/payment URL, accept only signature-verified webhooks, move paid events to awaiting verification, verify the supplied transaction against the invoice recipient address/asset/amount/confirmation, post idempotent double-entry invoice ledger records, and provide a downloadable verified receipt document.
- [ ] Run funded Chipnet and then production acceptance transactions with real wallets, available pool liquidity, explicit slippage limits, and independent reconciliation before enabling mainnet operations.
- [x] Show verified invoice receipts in the in-platform inbox and sent-invoice record.

## 3. Global payroll
- [x] Provide a payroll workspace surface for employee records, wallet-address requirements, asset preferences, batch approval, and successful/pending/failed states without claiming payouts occurred.
- [x] Add CSV employee upload, decimal-safe payroll calculation, batch approval, provider-backed BCH/CashToken payout execution through the shared wallet/intent controller, per-item status tracking, and durable payslip records.
- [ ] Run a funded payroll batch on Chipnet and then production, including at least one BCH payout and one CashToken payout, with independent reconciliation and downloadable PDF rendering.

## 4. Smart treasury
- [x] Keep Smart Treasury and wallet actions in personal workspaces; organization workspaces use invoices and payroll for team funds.
- [x] Provide treasury categories for tax, savings, payroll, and operating allocations, configuration affordances, reserve/savings-goal surfaces, and recurring-operation status.
- [x] Keep internal allocations visually separate from on-chain balances and show wallet balance state as unavailable until an actual BCH/CashToken wallet connection is verified.
- [ ] Add provider-backed balance reads, actual transfers, recurring execution, and downloadable financial reports.

## 5. Local currency access and P2P evaluation
- [x] Provide a provider-agnostic Local Currency Access surface that explains the proposed Paytaca P2P Exchange route, non-custodial escrow, external settlement evidence, and partner/liquidity prerequisites without assuming a geography or fiat provider.
- [ ] Investigate and implement an official Paytaca P2P Exchange integration when its third-party capabilities, credentials, and settlement contract are confirmed; do not build another P2P exchange or simulate fiat settlement.

## 6. Financial records and permissions
- [x] Provide unified activity and financial record surfaces covering invoices, payments, payroll, treasury, document availability, and audit language.
- [x] Keep Financial Records available to both personal and organization workspaces; invoice and payroll workflows remain in their respective workspace areas.
- [x] Persist organizations, memberships, wallets, invoices, ledger entries, audit events, and active-workspace preferences in Neon; scope workspace queries to validated memberships, restrict organization-wide financial data and writes to owners/admins, and expose each employee only their email-matched payroll records and payslips.
- [ ] Add downloadable verified receipts, payslips, reports, and audit exports.

## 7. Infrastructure and verification
- [x] Replace hosted OAuth with Volta Finance email/password signup and sign-in, hashed passwords, opaque database sessions, and a personal workspace on registration.
- [x] Replace MySQL runtime persistence with Neon PostgreSQL/Drizzle, generate the first PostgreSQL schema migration, and document pooled runtime/direct migration URLs.
- [x] Add and apply the Neon migration for each user's active organization workspace.
- [x] Pair multiple BCH wallets after account sign-in through independent WizardConnect sessions and persist linked wallet addresses to the user's workspace.
- [x] Keep the local health endpoint and route manifest; make the development command work from Windows PowerShell.
- [ ] Configure real Neon pooled/direct URLs and apply the generated migration; exercise signup, signin, logout, workspace persistence, wallet linking, and reconnect against that database.
- [ ] Run funded Chipnet acceptance journeys across swaps, invoices, payroll, and ledger reconciliation, then repeat with reviewed production configuration.

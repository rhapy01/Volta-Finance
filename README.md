# Volta Finance

Volta Finance is a BCH-native financial workspace for organizations and individuals. It brings invoicing, BCH and CashToken payments, staff payroll, treasury planning, and transaction-backed financial records into one application. Users sign in to a Volta workspace separately from their BCH wallet; the wallet remains in the user's control and is connected through WizardConnect when an on-chain action needs approval.

## What it does

- **Invoices and payments:** Create and send invoices, accept incoming invoices, and pay BCH, PUSD, or MUSD invoices. Payment flows build a transaction, request an explicit wallet signature, broadcast it, and verify the recipient output before recording settlement. BCH and CashToken routes use Cauldron where a swap is needed.
- **Staff Payroll:** Organizations invite staff, maintain monthly USDT-denominated payroll amounts and payout preferences, prepare payroll runs, and track per-recipient payout status. BCH and CashToken payroll is composed as a combined Chipnet transaction. Stellar Testnet payouts use a separate PUSD funding and Stellar settlement flow.
- **Treasury and records:** Save treasury plans, view activity, and keep financial records tied to verified transaction outcomes.
- **Workspaces and access:** Personal and organization workspaces, invitations, organization roles, and employee payroll views.
- **Wallet connection:** WizardConnect pairs compatible BCH wallets. Volta requests public address and transaction data needed for the selected action; signing remains with the wallet.
- **Stellar Testnet settlement:** Supports XLM and USDC destinations on the same Stellar account address. Recipients must enable the USDC trustline in their Stellar wallet to receive USDC.

## Network support

The application supports BCH mainnet and Chipnet paths for eligible BCH/CashToken invoice and payment flows. Payroll's combined BCH/CashToken transaction composer is Chipnet-only. The current Stellar settlement integration targets Stellar Testnet. Check the selected invoice network and asset before approving a transaction in your wallet.

CashScript contracts and compiled artifacts are included in `contracts/`. They are experimental contract primitives; their presence does not imply a production audit or mainnet deployment. See [`docs/onchain-architecture.md`](docs/onchain-architecture.md) for the on-chain boundaries and current architecture notes.

## Technology

- React, TypeScript, Vite, Tailwind CSS
- Express and tRPC
- PostgreSQL with Drizzle ORM (Neon-compatible configuration)
- WizardConnect for BCH wallet pairing and signing
- CashScript and Libauth for BCH/CashToken transaction work
- Stellar SDK for Stellar Testnet settlement

## Run locally

Requirements: Node.js, pnpm, and a PostgreSQL database.

1. Copy `.env.example` to `.env` and set the database connection values.
2. Install dependencies with `pnpm install`.
3. Start the app with `pnpm dev` (defaults to port `3000`).

The app uses `DATABASE_URL` for pooled application traffic and `DATABASE_URL_UNPOOLED` for schema migrations. Apply the PostgreSQL migrations with `pnpm db:migrate`. Generate a new migration after schema changes with `pnpm db:generate`.

Configure the optional mail and blockchain integrations in `.env` as needed. Keep credentials and signing secrets server-side; never commit `.env`.

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the application in development |
| `pnpm check` | Run TypeScript diagnostics |
| `pnpm build` | Build the client and server |
| `pnpm start` | Run the production build |
| `pnpm db:generate` | Generate Drizzle migrations |
| `pnpm db:migrate` | Apply PostgreSQL migrations |
| `pnpm test` | Run the unit test suite |

## Project layout

- `client/src/` — React application and feature pages
- `server/` — Express/tRPC API, database access, and payment integrations
- `shared/` — Shared types and application constants
- `drizzle/postgres/` — PostgreSQL migration history
- `contracts/` — CashScript sources and compiled contract artifacts
- `docs/` — Architecture and integration notes

Legacy migration files outside `drizzle/postgres/` are retained for reference and are not used by the Neon PostgreSQL setup.

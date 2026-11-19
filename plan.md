# Volta Finance implementation plan

## Product slice

Volta Finance will ship as a premium financial workspace for BCH-native money movement. The first build prioritizes the defining experience: an operator can understand the wallet state, create an invoice with a requested receiving asset, inspect a three-asset conversion route, and see the invoice reflected in shared financial records. The UI will make the distinction between verified on-chain state, pending work, and workspace configuration explicit. No fabricated balances, transactions, or confirmations will be shown.

### Workspace boundaries

Personal accounts use Smart Treasury for personal-fund actions and allocation planning. Organization accounts focus on sending and receiving invoices and managing staff payroll; they do not expose Smart Treasury. Financial Records remains available in both personal and organization workspaces as the shared history of verified invoices, payments, payroll, and treasury activity. Treasury actions must not be presented as financial records or inferred balances.

The initial build includes the dashboard shell, Payments & Invoicing, Smart Treasury, Global Payroll, Financial Records, and Local Currency Access views with responsive navigation and functional interactions. These surfaces share common asset, transaction, invoice, and integration-boundary types. The server remains the source of truth for real persistence as the Drizzle schema is extended. WizardConnect pairing and the public Cauldron BCH↔CashToken quote path are live; wallet balances, signed swaps, recipient settlement, and fiat cash-out remain gated on their provider responses and external identifiers.

## Architecture and implementation

- **Frontend**: React + TypeScript + Wouter + Tailwind, reusing the initialized starter and UI primitives. A single `AppShell` owns navigation, workspace header, responsive sidebar, toast feedback, and route-level view selection.
- **Shared domain model**: TypeScript asset, invoice, payment route, ledger status, and integration status types in the client layer. Amounts are represented as decimal strings in the UI; no floating-point money arithmetic is used for financial state.
- **Backend boundary**: Volta Finance owns email/password sign-in and database-backed sessions. WizardConnect pairs wallets separately after sign-in. Public UI reads use an honest empty/pending state rather than invented wallet data.
- **Database**: extend Drizzle with organizations, wallets, invoices, invoice payments, ledger entries, and audit events. Store asset code, decimal amount strings, status, and external transaction identifiers separately. Migrations are additive and intended for the shared managed database.
- **Blockchain integration boundary**: use WizardConnect for wallet pairing and Cauldron Router for public BCH↔CashToken quotes. Provider results must include verification state and external IDs before an invoice can become paid. Payment Hub invoice creation/webhooks are implemented behind optional merchant configuration; Paytaca P2P Exchange and fiat settlement remain documented as evaluation boundaries, not mocked as completed integrations.
- **Documents**: keep invoice/receipt/payslip/report export as clearly labeled integration points in this first slice; the records UI exposes download affordances only for persisted documents and reports their unavailable state when no file exists.
- **Deployment**: run the Windows-compatible `pnpm dev` server on the configured port, serve `public/app-routes.json`, and retain the Dockerfile/health endpoint for the server + database project.

## Design direction

### Alternatives considered

- Swiss ledger minimalism — probability 0.06. Precise, white, and restrained with near-invisible chrome.
- Neo-brutalist operations desk — probability 0.04. High-contrast panels, loud borders, and utilitarian density.
- **Chosen: warm editorial finance** — probability 0.90. A calm, premium operator console with ink-dark navigation, bone-white surfaces, and a warm apricot signal color for money movement.

### Chosen design system

- **Design Movement**: warm editorial finance — the quiet confidence of a private banking statement combined with the clarity of a modern operations tool.
- **Core Principles**: state before decoration; money movement gets the visual signal; every surface explains what is verified; progressive density from overview to detail.
- **Color Philosophy**: ink navy and paper create trust and legibility, mint indicates confirmed operational health, and apricot is reserved for action, routing, and attention so conversion is unmistakable.
- **Layout Paradigm**: a fixed, ink-dark navigation rail anchors the workspace while content flows in asymmetrical editorial bands: greeting and status, a dominant balance surface, then a two-column route/activity workbench.
- **Signature Elements**: compact asset chips with precise decimals; slim status rails on cards; a small route diagram that shows payer asset → Volta Finance route → recipient asset.
- **Interaction Philosophy**: actions are direct and reversible. Forms explain the next verification step, dialogs carry the context of the asset route, and disabled or unavailable states always say why.
- **Animation**: use restrained 160–220ms fades and 1–2px lifts for hover/focus only. No looping motion in financial data surfaces; loading uses a quiet shimmer or spinner.
- **Typography System**: use a system sans stack for dense numeric UI and a high-contrast serif fallback for editorial page titles. Large values are tabular and tight; labels are uppercase, letter-spaced, and small.
- **Brand Essence**: the operating system for BCH-native money — for independent operators and teams who need payments to land in the asset they chose. Personality: calm, exact, enabling.
- **Brand Voice**: headlines are concise and confident; CTAs describe the action, not a generic aspiration. Example lines: “Your money, in the right denomination.” and “Create an invoice that settles how you mean it.”
- **Wordmark & Logo**: the Volta Finance wordmark paired with a three-notch monogram suggesting a route through three assets.
- **Signature Brand Color**: apricot orange `#F07F4F`, used sparingly for movement and primary action.

## Project structure

- `client/src/App.tsx`: route map and application providers.
- `client/src/pages/Home.tsx`: main shell and dashboard experience.
- `client/src/index.css`: Volta Finance design tokens, layout utilities, responsive behavior, and custom chart styling.
- `server/routers.ts`: tRPC surface for authenticated persistence, public Cauldron quoting, and optional Payment Hub link creation alongside starter auth/system routes.
- `drizzle/schema.ts`: users plus tenant, wallet, invoice, ledger, and audit records.
- `client/public/app-routes.json`: page route manifest for previews and publishing.

## Honest integration constraints

The interface will not present a balance, signed transaction, swap, or cash-out as real without a provider response carrying a verifiable external identifier. Public quote responses are shown as quotes, not settlement. The dashboard creates durable workspace invoice drafts when signed in, and a Payment Hub URL is created only when real merchant configuration is present. A complete BCH settlement path still needs transaction building/signing/broadcast, CashToken output verification, recipient settlement, and any approved P2P/fiat partner contract.

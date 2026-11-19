# Volta Finance BCH integration research

Research checked 11 November 2026. This file records the implementation boundaries used by the application.

## Wallet connection

Volta Finance uses the documented WizardConnect path for BCH wallet pairing. The browser dapp creates a QR connection URI; a compatible wallet scans it, returns public wallet information, and retains private keys. Signing remains an explicit wallet approval. Volta Finance does not request seed phrases or private keys.

## Stellar testnet project wallet

Volta Finance's local testnet destination account is `GCW3HQ5C2YXLGHD26QQXS6DPD64P5W3CKP25V3Q3LKZ7JHKSXMSWU7U4`. It was created and funded with Stellar Friendbot on the Test SDF network. The account currently has 10,000 test XLM. Its private identity is stored in the Windows secure store using Stellar CLI alias `trezu-testnet`; do not export or commit its secret key. Local non-secret endpoint settings are in `.env` and `.env.example`.

Friendbot test XLM is only testnet gas/liquidity; it is not production funds and does not represent PUSD.

The server reads this account through Stellar Horizon and can send native XLM on Testnet. Locally, the app reads only the public key with `stellar keys public-key trezu-testnet` and signs payout XDR with `stellar tx sign --sign-with-key trezu-testnet`; it never asks the secure store to reveal the secret. Deployments may inject `STELLAR_TESTNET_SECRET_KEY` through their server-side secret manager instead. The crosschain experiment is in the accepted invoice payment flow, not Global Payroll or Smart Treasury: users save Stellar Testnet public addresses in Profile settings and select one while creating or editing an invoice. The selected address is saved on the invoice, then the payer pays the invoice's USDT amount as PUSD on Chipnet. Volta Finance verifies that payment and sends the quoted XLM to the address saved on the invoice. A unique source-transaction constraint prevents a single PUSD deposit from funding more than one intent. The PUSD remains in Volta Finance's Chipnet receiving wallet; this is a custodial testnet flow and does not yet implement refunds, deposit sweeping, market-priced PUSD redemption, production liquidity, or mainnet operation.

The Chipnet source deposit address is `bchtest:zqfm0r5vaeulnndzn3ec77g5eq47jhyhuurhcuxgrl`. Its signing key is stored only in the ignored local `.env` for future recovery work; it is not used to make the Stellar payout. The Stellar treasury must have sufficient XLM before creating quotes. Quotes assume 1 PUSD = 1 USD and reference a live XLM/USD market price; neither assumption establishes a redeemable testnet market price.

- Paytaca wallet: https://github.com/paytaca/paytaca-app
- WizardConnect React integration: https://docs.riftenlabs.com/wizardconnect/react/
- WizardConnect dapp protocol: https://gitlab.com/riftenlabs/lib/wizardconnect/-/blob/master/docs/dapp.md

## Cauldron Router

Volta Finance calls the public Cauldron Router WebSocket for native BCH↔CashToken quotes. The live request requires `sell`, `buy`, `amount`, and `side: "sell"`; amounts are sent in smallest units. The beta router currently supports BCH↔CashToken routes, not a guaranteed direct token↔token route. Quotes are returned with current input/output amounts, pool count, and market price. The application does not mark a payment settled from a quote.

- Router overview: https://docs.riftenlabs.com/router/
- Quote contract: https://docs.riftenlabs.com/router/api/route.quote/
- Transaction build contract: https://docs.riftenlabs.com/router/api/tx.build/
- Broadcast contract: https://docs.riftenlabs.com/cauldron/API/broadcast/

## Supported CashToken identity

Volta Finance matches assets by exact CashToken category ID, not symbol alone. The current allowlist uses:

- PUSD: `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`
- MUSD: `b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366`

PUSD is documented by ParyonUSD; MUSD is documented by Moria. The MUSD category ID requires independent on-chain verification before production settlement. Token amounts are stored as integer strings; the current protocol examples use two decimal display places for PUSD/MUSD and eight for BCH.

- ParyonUSD: https://paryonusd.com/
- Moria developer resources: https://docs.moria.money/developer-resources/
- CashTokens specification: https://cashtokens.org/docs/spec/chip/
- CashTokens BCMR metadata standard: https://cashtokens.org/docs/bcmr/chip/

## Paytaca Payment Hub

Payment Hub exposes current v1 invoice, supported-token, store, API-key, and webhook documentation. Store webhooks use Ed25519 signatures and require raw payload verification, idempotency, and HTTPS. A store is created/configured in the Paytaca Wallet Payment Hub app. Volta Finance leaves the merchant credentials as optional project configuration; no credential is fabricated or requested from the user in chat.

- Current v1 docs: https://paymenthub.paytaca.com/api/v1/docs/
- v1 schema: https://paymenthub.paytaca.com/api/v1/schema/
- Webhook verification: https://paymenthub.paytaca.com/webhook-docs/
- Product page: https://www.paytaca.com/platforms/payment-hub

## Paytaca P2P Exchange

The product page describes a counterparty fiat-to-BCH ramp with non-custodial BCH escrow. Fiat moves directly between counterparties; Paytaca is not described as the fiat intermediary. The public source contains an authenticated backend, but no supported third-party P2P API or partner credentials were verified. Volta Finance therefore presents a complete product surface for offer discovery, escrow/release/refund evidence, fiat confirmation, disputes, and partner requirements while labeling the route “under evaluation / coming soon.” It does not hard-code a country, payment provider, vendor liquidity, or settlement completion.

- Official P2P product page: https://www.paytaca.com/platforms/p2p-exchange
- WatchTower source: https://github.com/paytaca/watchtower-cash
- WatchTower API docs: https://watchtower.cash/api/docs/

## Explicit non-goals

No generic BCH indexer token or URL is assumed. No P2P credentials are assumed. No fiat vendor integration is simulated. No rate, balance, transaction, confirmation, swap, or cash-out is marked complete without a corresponding provider or blockchain response.

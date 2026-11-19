# Volta Finance on-chain architecture

## Verified sources

CashScript is a high-level language and TypeScript SDK for Bitcoin Cash smart contracts, including native introspection and CashTokens: https://cashscript.org/docs/basics/about and https://github.com/CashScript/cashscript.

CashScript covenants constrain how BCH or CashToken UTXOs may be spent. Native introspection exposes input/output values, locking bytecode, token categories, token amounts, NFT commitments, and transaction locktime: https://cashscript.org/docs/design/covenants.

CashScript documents WizardConnect transaction signing. The dapp builds a BCH WalletConnect transaction object and adds `inputPaths` entries in the form `[inputIndex, pathName, addressIndex]`. WizardConnect paths include receive, change, and defi. The wallet returns the signed transaction; the dapp can request broadcast: https://cashscript.org/docs/guides/walletconnect and https://docs.riftenlabs.com/wizardconnect/dapp/.

## Contract boundaries

Volta Finance uses standard wallet outputs for ordinary invoices and direct payments. Custom CashScript contracts are used where funds need enforceable on-chain rules: treasury withdrawal/recovery, recurring payroll streams, and non-custodial BCH escrow. Fiat movement and P2P counterparty confirmation are external; a covenant cannot prove a fiat transfer that never appears on BCH.

The initial contract sources are in `contracts/`: `treasury_vault.cash`, `payroll_stream.cash`, and `p2p_escrow.cash`. They compile with CashScript 0.14.0 into artifacts under `contracts/artifacts/`. These are Chipnet-first contract primitives, not a claim that mainnet deployment or production audit has occurred.

## Intent payment state machine

For every payer/recipient combination of BCH, PUSD, and MUSD, Volta Finance must identify the exact CashToken category, normalize amounts into smallest units, request a live route, show quote expiry/slippage/fees, resolve funding UTXOs, build a transaction, request wallet signing with accurate HD input paths, broadcast the signed transaction, observe the txid, verify recipient outputs and token category/amount, then post the ledger entry. A quote alone is never a payment.

Cauldron Router currently provides live BCH↔CashToken quotes and an unsigned transaction build contract. The application must connect `route.quote` to `tx.build`, then to WizardConnect signing and broadcast. Token↔token intent requires a verified BCH-intermediate route or another verified combined route; the current quote adapter must not pretend that direct token↔token liquidity exists.

## Current implementation status

Volta Finance now has the wallet adapter for WizardConnect public-key/address derivation, public CashScript Electrum UTXO reads, Cauldron quote and unsigned transaction-build procedures, WizardConnect sign-request construction, broadcast helper, and durable quoted/payment-intent plus blockchain-transaction state. Funding discovery scans the receive chain using Electrum address history and a 20-address gap rule, bounded to derived indexes 0–99; each UTXO retains its receive index so WizardConnect receives the matching HD signing path. The payment router selects real funding UTXOs, asks the wallet for explicit approval, broadcasts the signed transaction, polls confirmations, verifies the recipient locking script and exact BCH/CashToken category/amount, and posts the final double-entry ledger records. Token/token intents execute as two sequential BCH-intermediate legs and are not marked complete until the final leg verifies.

The controller requires a signed-in workspace, a connected WizardConnect wallet, an explicit recipient CashAddress, live router liquidity, and spendable funding UTXOs. It fails closed on missing UTXOs, invalid recipient addresses, unavailable routes, wallet rejection, broadcast errors, confirmation timeout, or output mismatch. Token/token intents are modeled as two BCH-intermediate legs because the official Router beta documents native token↔BCH routing while combined token↔token routing is not part of the beta contract.

CashScript contracts still need Chipnet unit/integration tests, deployment tooling, and independent production review before any mainnet use.

## In-app invoices and batch settlement

Invoice records can be delivered to a registered Volta Finance user and appear in that user's active workspace inbox. Unregistered senders can submit invoice details through `/submit-invoice`; the receiving user reviews and accepts the submission before it becomes payable. Sender identity is self-reported and recipient review is required. Invoice descriptions, addresses, payment state, and verified receipts remain in the app; the flow does not require document upload or receipt download.

The inbox can batch up to five accepted invoices when they request the same asset. BCH batches send several BCH outputs in one signed transaction. PUSD/MUSD batches use CashToken outputs of the exact category and BCH funding for output dust and miner fees. These same-asset batches use direct transactions and do not contact Cauldron pools. The server verifies every recipient address and summed amount after confirmation before atomically marking the invoices paid and posting issuer and payer ledger entries. Different-asset invoice settlement remains a separate routed payment flow.

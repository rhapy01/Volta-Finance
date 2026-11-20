import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

const TESTNET_HORIZON = process.env.STELLAR_TESTNET_HORIZON_URL || "https://horizon-testnet.stellar.org";
const TESTNET_NETWORK = Networks.TESTNET;
const XLM_SCALE = 10_000_000n;
const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ASSET = new Asset("USDC", TESTNET_USDC_ISSUER);
const SDK_IDENTITY = process.env.STELLAR_TESTNET_IDENTITY || "trezu-testnet";
const horizon = new Horizon.Server(TESTNET_HORIZON);

let cachedTreasuryPublicKey: string | undefined;

function getConfiguredTreasuryKeypair() {
  const phrase = process.env.STELLAR_TESTNET_SEED_PHRASE?.trim();
  if (phrase) {
    const mnemonic = phrase.normalize("NFKD").trim().split(/\s+/).join(" ");
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("STELLAR_TESTNET_SEED_PHRASE is not a valid English BIP-39 recovery phrase.");
    const passphrase = (process.env.STELLAR_TESTNET_SEED_PASSPHRASE || "").normalize("NFKD");
    let node = createHmac("sha512", "ed25519 seed").update(mnemonicToSeedSync(mnemonic, passphrase)).digest();
    let key = node.subarray(0, 32);
    let chainCode = node.subarray(32);
    for (const index of [44, 148, 0]) {
      const child = Buffer.alloc(37);
      child[0] = 0;
      key.copy(child, 1);
      child.writeUInt32BE(0x80000000 + index, 33);
      node = createHmac("sha512", chainCode).update(child).digest();
      key = node.subarray(0, 32);
      chainCode = node.subarray(32);
    }
    return Keypair.fromRawEd25519Seed(new Uint8Array(key));
  }
  const secret = process.env.STELLAR_TESTNET_SECRET_KEY?.trim();
  return secret ? Keypair.fromSecret(secret) : undefined;
}

export function validateStellarPublicKey(address: string) {
  try { StrKey.decodeEd25519PublicKey(address); return true; }
  catch { return false; }
}

function getTreasuryPublicKey() {
  if (cachedTreasuryPublicKey) return cachedTreasuryPublicKey;
  const configuredPublicKey = process.env.STELLAR_TESTNET_PUBLIC_KEY?.trim();
  // Read-only operations (such as quote and treasury balance checks) only need
  // the public address. Production serverless functions do not have the Stellar
  // CLI installed, and should not need the treasury signing key just to quote.
  const configuredKeypair = getConfiguredTreasuryKeypair();
  const publicKey = configuredKeypair
    ? configuredKeypair.publicKey()
    : configuredPublicKey || execFileSync("stellar", ["keys", "public-key", SDK_IDENTITY], { encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
  try { StrKey.decodeEd25519PublicKey(publicKey); }
  catch { throw new Error("The configured Stellar treasury identity did not return a valid public address."); }
  if (configuredPublicKey && publicKey !== configuredPublicKey) {
    throw new Error("The Stellar treasury signing identity does not match STELLAR_TESTNET_PUBLIC_KEY.");
  }
  cachedTreasuryPublicKey = publicKey;
  return publicKey;
}

function signTreasuryTransaction(transaction: ReturnType<TransactionBuilder["build"]>) {
  const configuredKeypair = getConfiguredTreasuryKeypair();
  if (configuredKeypair) {
    const expectedPublicKey = process.env.STELLAR_TESTNET_PUBLIC_KEY?.trim();
    if (expectedPublicKey && configuredKeypair.publicKey() !== expectedPublicKey) {
      throw new Error("The configured Stellar seed phrase does not derive the configured treasury address.");
    }
    transaction.sign(configuredKeypair);
    return transaction;
  }
  const signedXdr = execFileSync("stellar", ["--quiet", "tx", "sign", "--network", "testnet", "--sign-with-key", SDK_IDENTITY, transaction.toXDR()], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  }).trim();
  return TransactionBuilder.fromXDR(signedXdr, TESTNET_NETWORK);
}

export function formatStellarXlmAtomic(atomic: string | bigint) {
  const value = BigInt(atomic);
  const whole = value / XLM_SCALE;
  const fraction = (value % XLM_SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function isNotFound(error: unknown) {
  const details = error as { response?: { status?: number }; status?: number };
  return details?.response?.status === 404 || details?.status === 404;
}

export async function getStellarTestnetTreasuryStatus() {
  if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "testnet") {
    throw new Error("The project Stellar treasury is restricted to Testnet.");
  }
  const publicKey = getTreasuryPublicKey();
  const account = await horizon.loadAccount(publicKey);
  const native = account.balances.find((balance) => balance.asset_type === "native");
  const usdc = account.balances.find((balance) => "asset_code" in balance && balance.asset_code === "USDC" && balance.asset_issuer === TESTNET_USDC_ISSUER);
  const balanceXlm = native?.balance || "0";
  return {
    network: "testnet" as const,
    publicKey,
    balanceXlm,
    balanceUsdc: usdc?.balance || "0",
    horizonUrl: TESTNET_HORIZON,
  };
}

function stellarAmountToAtomic(amount: string) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole || "0") * XLM_SCALE + BigInt(fraction.padEnd(7, "0").slice(0, 7) || "0");
}

export async function quotePusdToStellarUsdc(sourceAmountAtomic: string) {
  if (!/^\d+$/.test(sourceAmountAtomic) || BigInt(sourceAmountAtomic) <= 0n) throw new Error("PUSD quote amount must be a positive integer in cents.");
  const status = await getStellarTestnetTreasuryStatus();
  const destinationAmountAtomic = (BigInt(sourceAmountAtomic) * 100_000n).toString();
  return { provider: "pre-funded Stellar Testnet treasury" as const, sourceAsset: "PUSD" as const, sourceAmountAtomic, sourceUsdAssumption: "1 PUSD = 1 USD (testnet quote assumption)" as const, destinationNetwork: "stellar-testnet" as const, destinationAsset: "USDC" as const, destinationAmountAtomic, usdcIssuer: TESTNET_USDC_ISSUER, treasuryBalanceUsdc: status.balanceUsdc, quotedAt: new Date().toISOString() };
}

async function getLiveXlmUsdPrice() {
  const providers = [
    async (signal: AbortSignal) => {
      const response = await fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol=XLMUSDT", { signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
      const payload = await response.json() as { symbol?: string; price?: string };
      const price = Number(payload.price);
      if (payload.symbol !== "XLMUSDT" || !Number.isFinite(price) || price <= 0) throw new Error("Binance returned an invalid XLM/USDT price.");
      return { priceUsd: price, marketUpdatedAt: null as string | null, provider: "Binance XLM/USDT spot" as const };
    },
    async (signal: AbortSignal) => {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd&include_last_updated_at=true", { signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`CoinGecko returned HTTP ${response.status}.`);
      const payload = await response.json() as { stellar?: { usd?: number; last_updated_at?: number } };
      const price = payload.stellar?.usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("CoinGecko returned an invalid XLM/USD price.");
      const updatedAt = payload.stellar?.last_updated_at;
      return { priceUsd: price, marketUpdatedAt: updatedAt ? new Date(updatedAt * 1000).toISOString() : null, provider: "CoinGecko XLM/USD spot" as const };
    },
  ];
  for (const provider of providers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      return await provider(controller.signal);
    } catch {
      // Try the next public price source if the preferred one is unavailable.
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  throw new Error("The live XLM price services timed out or are unavailable. No payment was sent; try again shortly.");
}

async function getLiveBchUsdPrice() {
  const providers = [
    async (signal: AbortSignal) => {
      const response = await fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol=BCHUSDT", { signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Binance returned HTTP ${response.status}.`);
      const payload = await response.json() as { symbol?: string; price?: string };
      const price = Number(payload.price);
      if (payload.symbol !== "BCHUSDT" || !Number.isFinite(price) || price <= 0) throw new Error("Binance returned an invalid BCH/USDT price.");
      return { priceUsd: price, marketUpdatedAt: null as string | null, provider: "Binance BCH/USDT spot" as const };
    },
    async (signal: AbortSignal) => {
      const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd&include_last_updated_at=true", { signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`CoinGecko returned HTTP ${response.status}.`);
      const payload = await response.json() as { "bitcoin-cash"?: { usd?: number; last_updated_at?: number } };
      const price = payload["bitcoin-cash"]?.usd;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) throw new Error("CoinGecko returned an invalid BCH/USD price.");
      const updatedAt = payload["bitcoin-cash"]?.last_updated_at;
      return { priceUsd: price, marketUpdatedAt: updatedAt ? new Date(updatedAt * 1000).toISOString() : null, provider: "CoinGecko BCH/USD spot" as const };
    },
  ];
  for (const provider of providers) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try { return await provider(controller.signal); }
    catch { /* Try the backup public price source. */ }
    finally { clearTimeout(timeout); controller.abort(); }
  }
  throw new Error("The live BCH price services timed out or are unavailable. No payment was sent; try again shortly.");
}

export async function quotePusdToStellarXlm(sourceAmountAtomic: string) {
  if (!/^\d+$/.test(sourceAmountAtomic) || BigInt(sourceAmountAtomic) <= 0n) throw new Error("PUSD quote amount must be a positive integer in cents.");
  const market = await getLiveXlmUsdPrice();
    const priceUsd = market.priceUsd;
    const priceUsdAtomic = BigInt(Math.round(priceUsd * 100_000_000));
    const outputAmountAtomic = (BigInt(sourceAmountAtomic) * 10_000_000_000_000n / priceUsdAtomic).toString();
    if (BigInt(outputAmountAtomic) <= 0n) throw new Error("PUSD amount is too small for a positive XLM payout.");
    const status = await getStellarTestnetTreasuryStatus();
    return {
      provider: market.provider,
      sourceAsset: "PUSD" as const,
      sourceAmountAtomic,
      sourceUsdAssumption: "1 PUSD = 1 USD (testnet quote assumption)" as const,
      destinationNetwork: "stellar-testnet" as const,
      destinationAsset: "XLM" as const,
      destinationAmountAtomic: outputAmountAtomic,
      xlmUsd: priceUsd,
      marketUpdatedAt: market.marketUpdatedAt,
      treasuryBalanceXlm: status.balanceXlm,
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
}

/** Invoice XLM is valued in the requested USDT unit; the payer funds the same USD cents as PUSD. */
export async function quoteUsdtToStellarXlm(requestedUsdtAtomic: string) {
  const quote = await quotePusdToStellarXlm(requestedUsdtAtomic);
  return {
    ...quote,
    sourceAsset: "PUSD" as const,
    paymentAsset: "PUSD" as const,
    sourceUsdAssumption: "1 USDT = 1 USD; PUSD payment uses the same USD value" as const,
  };
}

/** Quote a USDT-denominated invoice paid with BCH and delivered as XLM. */
export async function quoteBchToStellarXlm(requestedUsdtAtomic: string) {
  if (!/^\d+$/.test(requestedUsdtAtomic) || BigInt(requestedUsdtAtomic) <= 0n) throw new Error("Invoice amount must be a positive integer in USDT cents.");
  const [bchMarket, xlmMarket] = await Promise.all([getLiveBchUsdPrice(), getLiveXlmUsdPrice()]);
  const bchPriceAtomic = BigInt(Math.round(bchMarket.priceUsd * 100_000_000));
  const xlmPriceAtomic = BigInt(Math.round(xlmMarket.priceUsd * 100_000_000));
  // USDT cents -> BCH satoshis; round the source amount up so it covers the request.
  const bchNumerator = BigInt(requestedUsdtAtomic) * 100_000_000_000_000n;
  const sourceAmountAtomic = ((bchNumerator + bchPriceAtomic - 1n) / bchPriceAtomic).toString();
  // USDT cents -> XLM stroops, rounded down to avoid paying above the quoted value.
  const destinationAmountAtomic = (BigInt(requestedUsdtAtomic) * 10_000_000_000_000n / xlmPriceAtomic).toString();
  if (BigInt(destinationAmountAtomic) <= 0n) throw new Error("Invoice amount is too small for a positive XLM payout.");
  const treasury = await getStellarTestnetTreasuryStatus();
  if (Number(formatStellarXlmAtomic(destinationAmountAtomic)) + 0.00001 > Number(treasury.balanceXlm)) throw new Error("Volta Finance’s Stellar testnet wallet does not have enough XLM for this quote.");
  return {
    provider: `${bchMarket.provider} + ${xlmMarket.provider}`,
    sourceAsset: "BCH" as const,
    paymentAsset: "BCH" as const,
    sourceAmountAtomic,
    invoiceAmountUsdtAtomic: requestedUsdtAtomic,
    sourceUsdAssumption: `BCH amount uses live ${bchMarket.provider} pricing; invoice value remains denominated in USDT`,
    destinationNetwork: "stellar-testnet" as const,
    destinationAsset: "XLM" as const,
    destinationAmountAtomic,
    bchUsd: bchMarket.priceUsd,
    xlmUsd: xlmMarket.priceUsd,
    marketUpdatedAt: xlmMarket.marketUpdatedAt || bchMarket.marketUpdatedAt,
    treasuryBalanceXlm: treasury.balanceXlm,
    quotedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

/** Send project-held test XLM. Call only after the corresponding source-chain payment is verified. */
export async function sendStellarTestnetXlm(input: { destination: string; amountAtomic: string }) {
  if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "testnet") {
    throw new Error("Stellar treasury sends are restricted to Testnet.");
  }
  if (!/^\d+$/.test(input.amountAtomic)) throw new Error("XLM amount must be a positive integer in stroops.");
  const amountAtomic = BigInt(input.amountAtomic);
  if (amountAtomic <= 0n) throw new Error("XLM amount must be greater than zero.");
  if (amountAtomic > 100n * XLM_SCALE) throw new Error("A single testnet treasury send is limited to 100 XLM.");
  let destination: string;
  try {
    StrKey.decodeEd25519PublicKey(input.destination);
    destination = input.destination;
  } catch {
    throw new Error("Enter a valid Stellar account address starting with G.");
  }

  const sourcePublicKey = getTreasuryPublicKey();
  if (destination === sourcePublicKey) throw new Error("Choose a different Stellar recipient address.");
  const sourceAccount = await horizon.loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: TESTNET_NETWORK });
  try {
    await horizon.loadAccount(destination);
    builder.addOperation(Operation.payment({ destination, asset: Asset.native(), amount: formatStellarXlmAtomic(amountAtomic) }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (amountAtomic < XLM_SCALE) throw new Error("A new Stellar account needs at least 1 XLM to be created.");
    builder.addOperation(Operation.createAccount({ destination, startingBalance: formatStellarXlmAtomic(amountAtomic) }));
  }

  const transaction = builder.setTimeout(60).build();
  const txid = Buffer.from(transaction.hash()).toString("hex");
  const signedTransaction = signTreasuryTransaction(transaction);
  if (Buffer.from(signedTransaction.hash()).toString("hex") !== txid) throw new Error("The secure-store signer returned a different Stellar transaction.");
  return {
    txid,
    signedXdr: signedTransaction.toXDR(),
    destination,
    amountXlm: formatStellarXlmAtomic(amountAtomic),
    network: "testnet" as const,
  };
}

/** Prepare one idempotently retryable Stellar transaction with multiple payroll outputs. */
export async function sendStellarTestnetXlmBatch(input: { payouts: Array<{ destination: string; amountAtomic: string }> }) {
  if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "testnet") throw new Error("Stellar treasury sends are restricted to Testnet.");
  if (!input.payouts.length || input.payouts.length > 100) throw new Error("A Stellar payroll batch must contain between 1 and 100 payouts.");
  const sourcePublicKey = getTreasuryPublicKey();
  const sourceAccount = await horizon.loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: TESTNET_NETWORK });
  let totalAtomic = 0n;
  for (const payout of input.payouts) {
    if (!/^\d+$/.test(payout.amountAtomic) || BigInt(payout.amountAtomic) <= 0n) throw new Error("Every XLM payroll amount must be a positive integer in stroops.");
    const amountAtomic = BigInt(payout.amountAtomic);
    if (amountAtomic > 100n * XLM_SCALE) throw new Error("A single payroll payout is limited to 100 XLM.");
    totalAtomic += amountAtomic;
    try { StrKey.decodeEd25519PublicKey(payout.destination); }
    catch { throw new Error("A payroll recipient has an invalid Stellar public address."); }
    if (payout.destination === sourcePublicKey) throw new Error("A payroll recipient cannot be the Stellar treasury account.");
    try {
      await horizon.loadAccount(payout.destination);
      builder.addOperation(Operation.payment({ destination: payout.destination, asset: Asset.native(), amount: formatStellarXlmAtomic(amountAtomic) }));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (amountAtomic < XLM_SCALE) throw new Error("A new Stellar recipient account needs at least 1 XLM.");
      builder.addOperation(Operation.createAccount({ destination: payout.destination, startingBalance: formatStellarXlmAtomic(amountAtomic) }));
    }
  }
  const treasury = await getStellarTestnetTreasuryStatus();
  if (totalAtomic > BigInt(Math.floor(Number(treasury.balanceXlm) * Number(XLM_SCALE))) - BigInt(input.payouts.length) * BigInt(BASE_FEE)) {
    throw new Error("The Stellar Testnet treasury does not have enough XLM for this payroll batch and its network fees.");
  }
  const transaction = builder.setTimeout(60).build();
  const txid = Buffer.from(transaction.hash()).toString("hex");
  const signedTransaction = signTreasuryTransaction(transaction);
  if (Buffer.from(signedTransaction.hash()).toString("hex") !== txid) throw new Error("The secure-store signer returned a different Stellar transaction.");
  return { txid, signedXdr: signedTransaction.toXDR(), network: "testnet" as const };
}

export async function sendStellarTestnetPayrollBatch(input: { payouts: Array<{ destination: string; amountAtomic: string; asset: "XLM" | "USDC" }> }) {
  if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "testnet") throw new Error("Stellar treasury sends are restricted to Testnet.");
  if (!input.payouts.length || input.payouts.length > 100) throw new Error("A Stellar payroll batch must contain between 1 and 100 payouts.");
  const sourcePublicKey = getTreasuryPublicKey();
  const sourceAccount = await horizon.loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase: TESTNET_NETWORK });
  let totalXlmAtomic = 0n;
  let totalUsdcAtomic = 0n;
  for (const payout of input.payouts) {
    if (!/^\d+$/.test(payout.amountAtomic) || BigInt(payout.amountAtomic) <= 0n) throw new Error(`Every ${payout.asset} payroll amount must be a positive integer.`);
    const amountAtomic = BigInt(payout.amountAtomic);
    if (payout.asset === "XLM") {
      if (amountAtomic > 100n * XLM_SCALE) throw new Error("A single payroll payout is limited to 100 XLM.");
      totalXlmAtomic += amountAtomic;
    } else {
      totalUsdcAtomic += amountAtomic;
    }
    try { StrKey.decodeEd25519PublicKey(payout.destination); }
    catch { throw new Error("A payroll recipient has an invalid Stellar public address."); }
    if (payout.destination === sourcePublicKey) throw new Error("A payroll recipient cannot be the Stellar treasury account.");
    if (payout.asset === "USDC") {
      builder.addOperation(Operation.payment({ destination: payout.destination, asset: USDC_ASSET, amount: formatStellarXlmAtomic(amountAtomic) }));
      continue;
    }
    try { await horizon.loadAccount(payout.destination); }
    catch (error) {
      if (!isNotFound(error)) throw error;
      if (amountAtomic < XLM_SCALE) throw new Error("A new Stellar recipient account needs at least 1 XLM.");
      builder.addOperation(Operation.createAccount({ destination: payout.destination, startingBalance: formatStellarXlmAtomic(amountAtomic) }));
      continue;
    }
    builder.addOperation(Operation.payment({ destination: payout.destination, asset: Asset.native(), amount: formatStellarXlmAtomic(amountAtomic) }));
  }
  const treasury = await getStellarTestnetTreasuryStatus();
  const availableXlm = stellarAmountToAtomic(treasury.balanceXlm) - BigInt(input.payouts.length) * BigInt(BASE_FEE);
  if (totalXlmAtomic > availableXlm) throw new Error("The Stellar Testnet treasury does not have enough XLM for this payroll batch and its network fees.");
  if (totalUsdcAtomic > stellarAmountToAtomic(treasury.balanceUsdc)) throw new Error("The Stellar Testnet treasury does not have enough Circle USDC for this payroll batch.");
  const transaction = builder.setTimeout(60).build();
  const txid = Buffer.from(transaction.hash()).toString("hex");
  const signedTransaction = signTreasuryTransaction(transaction);
  if (Buffer.from(signedTransaction.hash()).toString("hex") !== txid) throw new Error("The secure-store signer returned a different Stellar transaction.");
  return { txid, signedXdr: signedTransaction.toXDR(), network: "testnet" as const };
}

export async function broadcastStellarTestnetXlm(input: { signedXdr: string; expectedTxid: string }) {
  if (process.env.STELLAR_NETWORK && process.env.STELLAR_NETWORK !== "testnet") throw new Error("Stellar treasury sends are restricted to Testnet.");
  const transaction = TransactionBuilder.fromXDR(input.signedXdr, TESTNET_NETWORK);
  if (Buffer.from(transaction.hash()).toString("hex") !== input.expectedTxid) throw new Error("Saved Stellar transaction hash does not match its signed transaction.");
  try {
    const existing = await horizon.transactions().transaction(input.expectedTxid).call();
    if (!existing.successful) throw new StellarTransactionFailedError();
    return { txid: existing.hash, ledger: existing.ledger };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    const result = await horizon.submitTransaction(transaction);
    if (!result.successful) throw new StellarTransactionFailedError();
    return { txid: result.hash, ledger: result.ledger };
  } catch (error) {
    try {
      const existing = await horizon.transactions().transaction(input.expectedTxid).call();
      if (!existing.successful) throw new StellarTransactionFailedError();
      return { txid: existing.hash, ledger: existing.ledger };
    } catch (lookupError) {
      if (lookupError instanceof StellarTransactionFailedError) throw lookupError;
      throw error;
    }
  }
}

export class StellarTransactionFailedError extends Error {
  readonly code = "STELLAR_TX_FAILED";
  constructor() {
    super("Stellar Testnet rejected this payout. USDC recipients need the Circle USDC trustline before retrying; a failed batch pays none of its Stellar recipients.");
    this.name = "StellarTransactionFailedError";
  }
}

export async function getStellarTestnetTransactionStatus(txid: string) {
  try {
    const transaction = await horizon.transactions().transaction(txid).call();
    return { found: true as const, successful: Boolean(transaction.successful) };
  } catch (error) {
    if (isNotFound(error)) return { found: false as const, successful: false };
    throw error;
  }
}

export async function sendStellarTestnetXlmWithRecovery(input: {
  destination: string;
  amountAtomic: string;
  existingSignedXdr?: string | null;
  existingTxid?: string | null;
  onPrepared?: (prepared: { signedXdr: string; txid: string }) => Promise<void>;
}) {
  const prepared = input.existingSignedXdr && input.existingTxid
    ? { signedXdr: input.existingSignedXdr, txid: input.existingTxid }
    : await sendStellarTestnetXlm({ destination: input.destination, amountAtomic: input.amountAtomic });
  if (!input.existingSignedXdr) await input.onPrepared?.({ signedXdr: prepared.signedXdr, txid: prepared.txid });
  const sent = await broadcastStellarTestnetXlm({ signedXdr: prepared.signedXdr, expectedTxid: prepared.txid });
  return {
    txid: sent.txid,
    ledger: sent.ledger,
    network: "testnet" as const,
  };
}

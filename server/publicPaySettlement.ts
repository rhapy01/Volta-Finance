import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import { publicPayIntents, type EvmReceiveNetwork } from "../drizzle/schema";
import { getDb } from "./db";
import { getCashTokenCategories } from "./integrations/cauldron";
import { getLiveCauldronBchBuyQuote } from "./integrations/chipnetCauldron";
import { getTransactionStatus, verifyRecipientOutput } from "./integrations/electrum";
import { isValidEvmAddress, sendEvmTestnetPayout, getEvmTestnetTransactionStatus, verifyEvmTestnetPayout } from "./integrations/evm";
import { isEvmMainnet } from "./integrations/evmNetworks";
import { quotePusdToStellarUsdc, quotePusdToStellarXlm, sendStellarTestnetPayrollBatch, broadcastStellarTestnetXlm, getStellarTestnetTransactionStatus } from "./integrations/stellar";

export type PublicPaySourceAsset = "BCH" | "PUSD";
export type PublicPayDestination = "XLM" | "USDC_STELLAR" | "USDC_BASE" | "USDC_ARC" | "USDC_BASE_MAINNET" | "USDC_ARC_MAINNET";
const evmDestinations: Record<"USDC_BASE" | "USDC_ARC" | "USDC_BASE_MAINNET" | "USDC_ARC_MAINNET", EvmReceiveNetwork> = { USDC_BASE: "base-sepolia", USDC_ARC: "arc-testnet", USDC_BASE_MAINNET: "base-mainnet", USDC_ARC_MAINNET: "arc-mainnet" };

function decimalToAtomic(value: string, decimals: number) {
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`This amount supports up to ${decimals} decimal places.`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")).toString();
}

export function getPublicPayDepositAddress(asset: PublicPaySourceAsset, sourceNetwork: "mainnet" | "chipnet") {
  const address = sourceNetwork === "chipnet"
    ? (asset === "BCH" ? process.env.CHIPNET_CROSSCHAIN_BCH_ADDRESS || process.env.CHIPNET_CROSSCHAIN_DEPOSIT_ADDRESS : process.env.CHIPNET_CROSSCHAIN_PUSD_ADDRESS || process.env.CHIPNET_CROSSCHAIN_DEPOSIT_ADDRESS)?.trim()
    : (asset === "BCH" ? process.env.MAINNET_CROSSCHAIN_BCH_ADDRESS || process.env.MAINNET_CROSSCHAIN_DEPOSIT_ADDRESS : process.env.MAINNET_CROSSCHAIN_PUSD_ADDRESS || process.env.MAINNET_CROSSCHAIN_DEPOSIT_ADDRESS)?.trim();
  if (!address) throw new Error(`Configure the ${sourceNetwork} ${asset} intake address before using cross-network Pay.`);
  const decoded = cashAddressToLockingBytecode(address);
  const prefix = sourceNetwork === "mainnet" ? "bitcoincash" : "bchtest";
  if (typeof decoded === "string" || decoded.prefix !== prefix || (asset === "PUSD" && !decoded.tokenSupport)) throw new Error(`The ${sourceNetwork} ${asset} intake address is not compatible.`);
  if (asset === "PUSD" && !getCashTokenCategories(sourceNetwork).PUSD) throw new Error(`PUSD is not configured on ${sourceNetwork}.`);
  return address;
}

export async function quotePublicCrosschainPay(input: { sourceAsset: PublicPaySourceAsset; sourceNetwork: "mainnet" | "chipnet"; amount: string; destination: PublicPayDestination; recipientAddress: string }) {
  if (!/^\d+(\.\d+)?$/.test(input.amount)) throw new Error("Enter a valid payment amount.");
  const sourceAmountAtomic = decimalToAtomic(input.amount, input.sourceAsset === "BCH" ? 8 : 2);
  if (BigInt(sourceAmountAtomic) <= 0n) throw new Error("The payment amount must be greater than zero.");
  const fundingAsset = "PUSD" as const;
  const fundingAmountAtomic = input.sourceAsset === "BCH"
    ? (await getLiveCauldronBchBuyQuote({ buy: "PUSD", amountAtomic: sourceAmountAtomic, network: input.sourceNetwork })).outputAmount
    : sourceAmountAtomic;
  let expectedOutputAtomic: string;
  let quote: Record<string, unknown>;
  let destinationNetwork: "stellar-testnet" | EvmReceiveNetwork;
  let destinationAsset: "XLM" | "USDC";
  if (input.destination === "XLM" || input.destination === "USDC_STELLAR") {
    const { validateStellarPublicKey, quotePusdToStellarUsdc: quoteStellarUsdc } = await import("./integrations/stellar");
    if (!validateStellarPublicKey(input.recipientAddress)) throw new Error("Enter a valid Stellar Testnet address.");
    const usdCents = BigInt(fundingAmountAtomic);
    if (input.destination === "XLM") {
      const result = await quotePusdToStellarXlm(usdCents.toString());
      expectedOutputAtomic = result.destinationAmountAtomic;
      quote = { ...result, sourceAsset: input.sourceAsset, sourceAmountAtomic, destinationAddress: input.recipientAddress };
      destinationAsset = "XLM";
    } else {
      const result = await quoteStellarUsdc(usdCents.toString());
      expectedOutputAtomic = result.destinationAmountAtomic;
      quote = { ...result, sourceAsset: input.sourceAsset, sourceAmountAtomic, destinationAddress: input.recipientAddress };
      destinationAsset = "USDC";
    }
    destinationNetwork = "stellar-testnet";
  } else {
    if (!isValidEvmAddress(input.recipientAddress)) throw new Error("Enter a valid EVM address.");
    const evmDest = input.destination as keyof typeof evmDestinations;
    destinationNetwork = evmDestinations[evmDest];
    destinationAsset = "USDC";
    const usdCents = BigInt(fundingAmountAtomic);
    expectedOutputAtomic = (usdCents * 10_000n).toString();
    quote = { provider: "Cauldron BCH/PUSD intent quote", sourceAsset: input.sourceAsset, sourceAmountAtomic, usdCents: usdCents.toString(), destinationNetwork, destinationAsset, destinationAddress: input.recipientAddress, outputAmountAtomic: expectedOutputAtomic, quotedAt: new Date().toISOString() };
  }
  if ((input.destination === "USDC_BASE_MAINNET" || input.destination === "USDC_ARC_MAINNET") && input.sourceNetwork !== "mainnet") throw new Error("Mainnet USDC payouts require a Bitcoin Cash mainnet source payment.");
  if ((input.destination === "USDC_BASE" || input.destination === "USDC_ARC" || input.destination === "USDC_STELLAR" || input.destination === "XLM") && input.sourceNetwork !== "chipnet") throw new Error("Testnet and Stellar payouts require a Chipnet source payment.");
  return { sourceAsset: input.sourceAsset, sourceNetwork: input.sourceNetwork, sourceAmountAtomic, fundingAsset, fundingAmountAtomic, depositAddress: getPublicPayDepositAddress(fundingAsset, input.sourceNetwork), destinationNetwork, destinationAsset, destinationAddress: input.recipientAddress, expectedOutputAtomic, quote: { ...quote, sourceNetwork: input.sourceNetwork, fundingAsset, fundingAmountAtomic } };
}

export async function createPublicCrosschainPayIntent(input: Awaited<ReturnType<typeof quotePublicCrosschainPay>>) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available.");
  const [intent] = await db.insert(publicPayIntents).values({ publicId: `PAY-${nanoid(12).toUpperCase()}`, sourceAsset: input.sourceAsset, sourceAmountAtomic: input.sourceAmountAtomic, depositAddress: input.depositAddress, destinationNetwork: input.destinationNetwork, destinationAsset: input.destinationAsset, destinationAddress: input.destinationAddress, expectedOutputAtomic: input.expectedOutputAtomic, quote: input.quote, status: "awaiting_funding", dataNetwork: input.sourceNetwork === "mainnet" ? "mainnet" : "testnet" }).returning();
  return intent;
}

export async function recordPublicPayFunding(input: { publicId: string; txid: string }) {
  const db = await getDb(); if (!db) throw new Error("Database is not available.");
  const [intent] = await db.select().from(publicPayIntents).where(eq(publicPayIntents.publicId, input.publicId)).limit(1);
  if (!intent) throw new Error("Pay intent was not found.");
  if (intent.sourceTxid && intent.sourceTxid !== input.txid) throw new Error("This Pay intent already has a different funding transaction.");
  const [updated] = await db.update(publicPayIntents).set({ sourceTxid: input.txid, status: "pending_verification", updatedAt: new Date() }).where(and(eq(publicPayIntents.id, intent.id), isNull(publicPayIntents.sourceTxid))).returning();
  return updated ?? intent;
}

export async function settlePublicPayIntent(publicId: string) {
  const db = await getDb(); if (!db) throw new Error("Database is not available.");
  const [intent] = await db.select().from(publicPayIntents).where(eq(publicPayIntents.publicId, publicId)).limit(1);
  if (!intent) throw new Error("Pay intent was not found.");
  if (intent.status === "completed") return { status: intent.status, txid: intent.payoutTxid };
  if (!intent.sourceTxid) throw new Error("Send the quoted payment before checking settlement.");
  const quote = intent.quote && typeof intent.quote === "object" ? intent.quote as Record<string, unknown> : {};
  const sourceNetwork = quote.sourceNetwork === "mainnet" ? "mainnet" : "chipnet";
  const sourceStatus = await getTransactionStatus({ txid: intent.sourceTxid, network: sourceNetwork });
  if (!sourceStatus.found || sourceStatus.confirmations < 1) return { status: "pending" as const, txid: null, confirmations: sourceStatus.confirmations };
  const fundingAsset = quote.fundingAsset === "PUSD" ? "PUSD" : intent.sourceAsset;
  const fundingAmountAtomic = typeof quote.fundingAmountAtomic === "string" ? quote.fundingAmountAtomic : intent.sourceAmountAtomic;
  const verifiedSource = await verifyRecipientOutput({ txid: intent.sourceTxid, recipientAddress: intent.depositAddress, expectedAsset: fundingAsset, expectedAmountAtomic: fundingAmountAtomic, tokenCategory: fundingAsset === "PUSD" ? getCashTokenCategories(sourceNetwork).PUSD : undefined, network: sourceNetwork });
  if (!verifiedSource.verified) throw new Error(`The confirmed ${sourceNetwork} transaction does not match this Pay intent.`);
  if (intent.destinationNetwork === "stellar-testnet") {
    let payoutTxid = intent.payoutTxid;
    let signedPayload = intent.payoutSignedPayload;
    if (!payoutTxid || !signedPayload) {
      const prepared = await sendStellarTestnetPayrollBatch({ payouts: [{ destination: intent.destinationAddress, amountAtomic: intent.expectedOutputAtomic, asset: intent.destinationAsset }] });
      payoutTxid = prepared.txid; signedPayload = prepared.signedXdr;
      await db.update(publicPayIntents).set({ payoutTxid, payoutSignedPayload: signedPayload, status: "paying", updatedAt: new Date() }).where(eq(publicPayIntents.id, intent.id));
    }
    await broadcastStellarTestnetXlm({ signedXdr: signedPayload, expectedTxid: payoutTxid });
    const status = await getStellarTestnetTransactionStatus(payoutTxid);
    if (!status.found || !status.successful) return { status: "pending" as const, txid: payoutTxid };
    await db.update(publicPayIntents).set({ status: "completed", payoutSignedPayload: null, updatedAt: new Date() }).where(eq(publicPayIntents.id, intent.id));
    return { status: "completed" as const, txid: payoutTxid };
  }
  const network = intent.destinationNetwork as EvmReceiveNetwork;
  let payoutTxid = intent.payoutTxid;
  if (!payoutTxid) {
    const payout = await sendEvmTestnetPayout({ network, asset: "USDC", destination: intent.destinationAddress, amountAtomic: intent.expectedOutputAtomic });
    payoutTxid = payout.txid;
    await db.update(publicPayIntents).set({ payoutTxid, status: "paying", updatedAt: new Date() }).where(eq(publicPayIntents.id, intent.id));
  }
  const status = await getEvmTestnetTransactionStatus({ network, txid: payoutTxid });
  if (!status.found) return { status: "pending" as const, txid: payoutTxid };
  if (!status.successful) throw new Error("The USDC payout failed on the destination network.");
  const result = await verifyEvmTestnetPayout({ network, asset: "USDC", txid: payoutTxid, destination: intent.destinationAddress, amountAtomic: intent.expectedOutputAtomic });
  if (!result.verified) throw new Error("The destination transaction does not contain the quoted USDC payout.");
  await db.update(publicPayIntents).set({ status: "completed", updatedAt: new Date() }).where(eq(publicPayIntents.id, intent.id));
  return { status: "completed" as const, txid: payoutTxid };
}

import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, publicProcedure } from "./_core/trpc";
import { buildCauldronSwap, getCashTokenCategories, getIntentQuote } from "./integrations/cauldron";
import { buildChipnetCauldronBuy, buildChipnetCauldronSell, buildPayrollBatch } from "./integrations/chipnetCauldron";
import { broadcastChipnetTransaction, getProvider, getTransactionStatus, getWalletUtxosForAddresses, verifyChipnetTransactionInputs, verifyRecipientOutput } from "./integrations/electrum";
import { createPublicCrosschainPayIntent, getPublicPayDepositAddress, quotePublicCrosschainPay, recordPublicPayFunding, settlePublicPayIntent } from "./publicPaySettlement";

const asset = z.enum(["BCH", "PUSD", "MUSD"]);
const network = z.enum(["mainnet", "chipnet"]);
const fundingInput = z.object({
  txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
  vout: z.number().int().nonnegative(),
  value: z.string().regex(/^\d+$/),
  scriptHex: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/),
  addressPath: z.enum(["receive", "change", "defi"]).optional(),
  addressIndex: z.number().int().min(0).max(99).optional(),
  token: z.object({ category: z.string().regex(/^[0-9a-fA-F]{64}$/), amount: z.string().regex(/^\d+$/) }).optional(),
});

function assertCashAddress(address: string, selectedNetwork: "mainnet" | "chipnet", tokenRequired = false) {
  const decoded = cashAddressToLockingBytecode(address);
  const prefix = selectedNetwork === "mainnet" ? "bitcoincash" : "bchtest";
  if (typeof decoded === "string" || decoded.prefix !== prefix) throw new Error(`Enter a valid ${selectedNetwork} Bitcoin Cash address.`);
  if (tokenRequired && !decoded.tokenSupport) throw new Error("CashToken recipients must use a token-aware CashAddress.");
}

export const publicPayRouter = router({
  assetConfig: publicProcedure.query(() => ({ mainnet: getCashTokenCategories("mainnet"), chipnet: getCashTokenCategories("chipnet"), musdEnabled: process.env.MUSD?.trim().toLowerCase() !== "no" })),

  crosschainQuote: publicProcedure.input(z.object({ sourceAsset: z.enum(["BCH", "PUSD"]), sourceNetwork: z.enum(["mainnet", "chipnet"]), amount: z.string().trim().min(1).max(40), destination: z.enum(["XLM", "USDC_STELLAR", "USDC_BASE", "USDC_ARC", "USDC_BASE_MAINNET", "USDC_ARC_MAINNET"]), recipientAddress: z.string().trim().min(20).max(128) })).mutation(async ({ input }) => {
    let quote;
    try {
      quote = await quotePublicCrosschainPay(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown quote failure";
      console.error("[Public Pay] Cross-network quote failed", { stage: "quote", sourceAsset: input.sourceAsset, sourceNetwork: input.sourceNetwork, destination: input.destination, errorName: error instanceof Error ? error.name : typeof error, message });
      if (message.includes("Cauldron quote failed: route_failed")) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No live BCH-to-PUSD route can fill that amount right now. Retry shortly or try a smaller amount." });
      }
      if (/^Live .* Cauldron pools cannot fill this BCH amount/.test(message)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The current BCH-to-PUSD pools cannot fill this amount. Try a smaller amount or retry shortly." });
      }
      if (/^(Enter a valid|Enter a positive|The payment amount|This amount|Mainnet USDC|Testnet and Stellar|The .* intake address|PUSD is not configured)/i.test(message)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message });
      }
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Live exchange pricing is temporarily unavailable. Please try again in a few seconds." });
    }
    try {
      const intent = await createPublicCrosschainPayIntent(quote);
      return { ...quote, publicId: intent.publicId, status: intent.status };
    } catch (error) {
      console.error("[Public Pay] Could not save cross-network payment request", { stage: "save_intent", sourceNetwork: input.sourceNetwork, destination: input.destination, errorName: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : "Unknown database failure" });
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The payment request could not be saved. Please try again." });
    }
  }),
  buildCrosschainFunding: publicProcedure.input(z.object({
    sourceNetwork: network,
    fundingAmountAtomic: z.string().regex(/^\d+$/),
    funding: z.array(fundingInput).min(1).max(100),
    changeAddress: z.string().min(20).max(128),
  })).mutation(async ({ input }) => {
    try {
      const depositAddress = getPublicPayDepositAddress("PUSD", input.sourceNetwork);
      return await buildPayrollBatch({
        network: input.sourceNetwork,
        payouts: [{ asset: "PUSD", amountAtomic: input.fundingAmountAtomic, address: depositAddress }],
        funding: input.funding.filter((item) => !item.token).map(({ txid, vout, value, scriptHex }) => ({ txid, vout, value, scriptHex })),
        changeAddress: input.changeAddress,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Cauldron build failure";
      console.error("[Public Pay] Shared BCH/PUSD settlement build failed", {
        stage: "build_shared_payroll_settlement",
        sourceNetwork: input.sourceNetwork,
        fundingUtxoCount: input.funding.length,
        errorName: error instanceof Error ? error.name : typeof error,
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (/not enough|insufficient|cannot cover|cannot fund|no BCH funding inputs/i.test(message)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The connected wallet does not have enough BCH to fund this payout and its network fee." });
      }
      if (/already been spent|pool input|unspent|stale|current pool/i.test(message)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The live Cauldron pool changed while preparing this payment. Get a fresh quote and try again." });
      }
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The BCH-to-PUSD settlement could not be prepared. Refresh the quote and try again." });
    }
  }),
  recordCrosschainFunding: publicProcedure.input(z.object({ publicId: z.string().trim().min(1).max(40), txid: z.string().regex(/^[0-9a-fA-F]{64}$/) })).mutation(({ input }) => recordPublicPayFunding(input)),
  settleCrosschain: publicProcedure.input(z.object({ publicId: z.string().trim().min(1).max(40) })).mutation(({ input }) => settlePublicPayIntent(input.publicId)),

  quote: publicProcedure.input(z.object({
    sell: asset,
    buy: asset,
    amount: z.string().trim().min(1).max(40).regex(/^\d+(\.\d+)?$/),
    recipientAddress: z.string().trim().min(20).max(128),
  })).mutation(async ({ input }) => {
    const decoded = cashAddressToLockingBytecode(input.recipientAddress);
    if (typeof decoded === "string" || !["bitcoincash", "bchtest"].includes(decoded.prefix)) throw new Error("Enter a valid Bitcoin Cash recipient address.");
    const selectedNetwork = decoded.prefix === "bchtest" ? "chipnet" : "mainnet";
    if (input.buy !== "BCH" && !decoded.tokenSupport) throw new Error("CashToken recipients must use a token-aware CashAddress.");
    for (const selectedAsset of [input.sell, input.buy]) {
      if (selectedAsset !== "BCH" && !getCashTokenCategories(selectedNetwork)[selectedAsset]) throw new Error(`${selectedAsset} is not configured on ${selectedNetwork}.`);
    }
    const quote = await getIntentQuote({ sell: input.sell, buy: input.buy, amount: input.amount, network: selectedNetwork });
    return { quote, network: selectedNetwork, recipientAddress: input.recipientAddress };
  }),

  scanWallet: publicProcedure.input(z.object({
    addresses: z.array(z.object({ address: z.string().min(20).max(128), addressIndex: z.number().int().min(0).max(99), path: z.enum(["receive", "change"]) })).min(1).max(40),
    network,
  })).mutation(({ input }) => getWalletUtxosForAddresses(input)),

  buildSwap: publicProcedure.input(z.object({
    sell: asset,
    buy: asset,
    amount: z.string().trim().min(1).max(40).regex(/^\d+(\.\d+)?$/),
    funding: z.array(fundingInput).min(1).max(100),
    receiveAddress: z.string().min(20).max(128),
    changeAddress: z.string().min(20).max(128),
    tokenChangeAddress: z.string().min(20).max(128).optional(),
    expectedSellAmountAtomic: z.string().regex(/^\d+$/).optional(),
    network,
  })).mutation(async ({ input }) => {
    assertCashAddress(input.receiveAddress, input.network, input.buy !== "BCH");
    assertCashAddress(input.changeAddress, input.network);
    if (input.tokenChangeAddress) assertCashAddress(input.tokenChangeAddress, input.network, true);
    const built = input.network === "chipnet" && input.sell === "BCH" && input.buy !== "BCH"
      ? await buildChipnetCauldronBuy({ ...input, side: "buy" })
      : input.network === "chipnet" && input.sell !== "BCH" && input.buy === "BCH"
        ? await buildChipnetCauldronSell({ ...input, side: "buy" })
        : await buildCauldronSwap({ ...input, side: "buy" });
    if (input.network === "chipnet") {
      const prevouts = await verifyChipnetTransactionInputs(built.unsignedTxHex, built.sourceOutputs);
      if (prevouts.unavailable.length && prevouts.missing.length === 0) throw new Error("Chipnet peers could not verify the route inputs. Refresh and try again.");
      if (!prevouts.valid) throw new Error("A wallet or swap pool input has already been spent. Refresh the quote and try again.");
    }
    return built;
  }),

  broadcast: publicProcedure.input(z.object({ rawTransaction: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/).max(500_000), network })).mutation(async ({ input }) => ({
    txid: input.network === "chipnet" ? await broadcastChipnetTransaction(input.rawTransaction) : await getProvider("mainnet").sendRawTransaction(input.rawTransaction),
  })),

  verify: publicProcedure.input(z.object({
    txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
    recipientAddress: z.string().min(20).max(128),
    expectedAsset: asset,
    expectedAmountAtomic: z.string().regex(/^\d+$/),
    network,
  })).mutation(async ({ input }) => {
    assertCashAddress(input.recipientAddress, input.network, input.expectedAsset !== "BCH");
    const status = await getTransactionStatus({ txid: input.txid, network: input.network }).catch(() => ({ confirmations: 0 }));
    if (status.confirmations < 1) return { status: "pending" as const, verified: false, confirmations: status.confirmations };
    const result = await verifyRecipientOutput({ ...input, tokenCategory: input.expectedAsset === "BCH" ? undefined : getCashTokenCategories(input.network)[input.expectedAsset] });
    return { status: result.verified ? "verified" as const : "rejected" as const, verified: result.verified, confirmations: status.confirmations, receivedAmountAtomic: result.amountAtomic };
  }),
});

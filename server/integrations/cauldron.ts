import WebSocket from "ws";

export const CASH_TOKEN_CATEGORIES = {
  PUSD: "2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544",
  MUSD: "b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366",
} as const;

const CHIPNET_CAULDRON_ROUTER_URL = "wss://router-chipnet.riften.net/v1/route";
const CHIPNET_PUSD_CATEGORY = "dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b";
export type BchNetwork = "mainnet" | "chipnet";
const configuredCategory = (value?: string) => value && /^[0-9a-fA-F]{64}$/.test(value.trim()) ? value.trim().toLowerCase() : "";
export function getCashTokenCategories(network: BchNetwork = "mainnet") {
  return network === "mainnet" ? CASH_TOKEN_CATEGORIES : {
    PUSD: configuredCategory(process.env.CHIPNET_PUSD_CATEGORY || CHIPNET_PUSD_CATEGORY),
    MUSD: configuredCategory(process.env.CHIPNET_MUSD_CATEGORY),
  };
}
export function getChipnetAssetReadiness() {
  const categories = getCashTokenCategories("chipnet");
  return { PUSD: Boolean(categories.PUSD), MUSD: Boolean(categories.MUSD), swaps: Boolean(process.env.CAULDRON_CHIPNET_ROUTER_URL || CHIPNET_CAULDRON_ROUTER_URL) };
}

export type CauldronAsset = "BCH" | "PUSD" | "MUSD";
export type IntentLeg = { sell: CauldronAsset; buy: CauldronAsset; inputAmount: string; outputAmount: string; pools: number; marketPrePrice?: string; marketPostPrice?: string };

function routerAsset(asset: CauldronAsset, network: BchNetwork = "mainnet") {
  if (asset === "BCH") return "bch";
  const category = getCashTokenCategories(network)[asset];
  if (!category) throw new Error(`${asset} Chipnet token category is not configured`);
  return category;
}
function routerUrl(network: BchNetwork) {
  if (network === "chipnet") {
    return process.env.CAULDRON_CHIPNET_ROUTER_URL || CHIPNET_CAULDRON_ROUTER_URL;
  }
  return process.env.CAULDRON_ROUTER_URL || "wss://router.riften.net/v1/route";
}

export function toAtomicAmount(value: string, asset: CauldronAsset) {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Amount must be a positive decimal");
  const [whole, fraction = ""] = normalized.split(".");
  const decimals = asset === "BCH" ? 8 : 2;
  if (fraction.length > decimals) throw new Error(`${asset} supports at most ${decimals} decimal places`);
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  if (atomic <= 0n) throw new Error("Amount must be greater than zero");
  return atomic.toString();
}

export function formatAtomicAmount(value: string, asset: CauldronAsset) {
  const decimals = asset === "BCH" ? 8 : 2;
  const raw = BigInt(value).toString().padStart(decimals + 1, "0");
  const split = raw.length - decimals;
  return `${raw.slice(0, split)}.${raw.slice(split)}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function providerQuoteOnce(input: { sell: CauldronAsset; buy: CauldronAsset; amountAtomic: string; side?: "sell" | "buy"; network?: BchNetwork }) {
  if (input.sell === input.buy) throw new Error("A quote requires two different assets");
  if (input.sell !== "BCH" && input.buy !== "BCH") throw new Error("Cauldron beta quotes BCH↔CashToken legs only");
  const network = input.network || "mainnet";
  const url = routerUrl(network);
  const request = { id: Date.now(), method: "route.quote", params: { sell: routerAsset(input.sell, network), buy: routerAsset(input.buy, network), amount: input.amountAtomic, side: input.side || "sell" } };
  return new Promise<IntentLeg>((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let responseTimeout: ReturnType<typeof setTimeout> | undefined;
    const connectionTimeout = setTimeout(() => finish(new Error("Cauldron Router connection timed out")), 8_000);
    const finish = (error?: Error, result?: IntentLeg) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimeout);
      if (responseTimeout) clearTimeout(responseTimeout);
      try { socket.close(); } catch {}
      if (error) reject(error); else if (result) resolve(result);
    };
    socket.once("error", () => finish(new Error("Cauldron Router is unavailable right now")));
    socket.once("open", () => {
      clearTimeout(connectionTimeout);
      responseTimeout = setTimeout(() => finish(new Error("Cauldron Router did not return a quote within 15 seconds")), 15_000);
      socket.send(JSON.stringify(request), (error) => { if (error) finish(new Error("Could not send the quote request to Cauldron Router")); });
    });
    socket.on("message", payload => {
      try {
        const message = JSON.parse(payload.toString()) as { error?: { code?: string }; result?: Record<string, unknown> };
        if (message.error) return finish(new Error(`Cauldron quote failed: ${message.error.code || "provider_error"}`));
        const result = message.result;
        if (!result || typeof result.input_amount !== "string" || typeof result.output_amount !== "string") return;
        const fill = result.fill as { filled?: unknown } | undefined;
        const actualInput = input.side !== "buy" && typeof fill?.filled === "string" ? fill.filled : result.input_amount;
        finish(undefined, { sell: input.sell, buy: input.buy, inputAmount: actualInput, outputAmount: result.output_amount, pools: typeof result.pools === "number" ? result.pools : 0, marketPrePrice: typeof result.market_pre_price === "string" ? result.market_pre_price : undefined, marketPostPrice: typeof result.market_post_price === "string" ? result.market_post_price : undefined });
      } catch { finish(new Error("Cauldron Router returned an invalid quote")); }
    });
    socket.once("close", (code, reason) => {
      if (!settled) finish(new Error(`Cauldron Router closed the quote connection (${code}${reason.length ? `: ${reason.toString()}` : ""})`));
    });
  });
}

async function providerQuote(input: { sell: CauldronAsset; buy: CauldronAsset; amountAtomic: string; side?: "sell" | "buy"; network?: BchNetwork }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await providerQuoteOnce(input); }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt > 0 || !/timed out|unavailable|closed the quote connection|could not send/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
  throw lastError;
}

export async function getCauldronQuote(input: { sell: CauldronAsset; buy: CauldronAsset; amount: string; network?: BchNetwork }) {
  return providerQuote({ sell: input.sell, buy: input.buy, amountAtomic: toAtomicAmount(input.amount, input.sell), network: input.network }).then(result => ({ provider: "Cauldron Router" as const, ...result }));
}

/**
 * Quotes every supported intent. Direct BCH/token intents use one provider leg.
 * Token/token intents use two verified BCH-intermediate legs; execution must
 * preserve the two-leg state machine and never pretend it is one atomic swap.
 */
export async function getIntentQuote(input: { sell: CauldronAsset; buy: CauldronAsset; amount: string; network?: BchNetwork }) {
  const network = input.network || "mainnet";
  const amountAtomic = toAtomicAmount(input.amount, input.sell);
  if (input.sell === input.buy) {
    return { provider: "direct wallet transfer" as const, sell: input.sell, buy: input.buy, inputAmount: amountAtomic, outputAmount: amountAtomic, legs: [] as IntentLeg[], atomic: true };
  }
  const legs: IntentLeg[] = [];
  if (input.sell === "BCH" || input.buy === "BCH") {
    legs.push(await providerQuote({ sell: input.sell, buy: input.buy, amountAtomic, network }));
  } else {
    const first = await providerQuote({ sell: input.sell, buy: "BCH", amountAtomic, network });
    const second = await providerQuote({ sell: "BCH", buy: input.buy, amountAtomic: first.outputAmount, network });
    legs.push(first, second);
  }
  return { provider: "Cauldron Router" as const, sell: input.sell, buy: input.buy, inputAmount: legs[0].inputAmount, outputAmount: legs.at(-1)!.outputAmount, legs, atomic: legs.length === 1 };
}

/** Quote the exact amount that a payroll recipient must receive. */
export async function getPayrollQuote(input: { sell: CauldronAsset; buy: CauldronAsset; amount: string; network?: BchNetwork }) {
  const targetAtomic = toAtomicAmount(input.amount, input.buy);
  if (input.sell === input.buy) return { provider: "direct wallet transfer" as const, sell: input.sell, buy: input.buy, inputAmount: targetAtomic, outputAmount: targetAtomic, legs: [] as IntentLeg[], atomic: true, side: "buy" as const };
  if (input.sell === "BCH" || input.buy === "BCH") {
    const leg = await providerQuote({ sell: input.sell, buy: input.buy, amountAtomic: targetAtomic, side: "buy", network: input.network });
    return { provider: "Cauldron Router" as const, sell: input.sell, buy: input.buy, inputAmount: leg.inputAmount, outputAmount: targetAtomic, legs: [leg], atomic: false, side: "buy" as const };
  }
  const lastLeg = await providerQuote({ sell: "BCH", buy: input.buy, amountAtomic: targetAtomic, side: "buy", network: input.network });
  const firstLeg = await providerQuote({ sell: input.sell, buy: "BCH", amountAtomic: lastLeg.inputAmount, side: "buy", network: input.network });
  return { provider: "Cauldron Router" as const, sell: input.sell, buy: input.buy, inputAmount: firstLeg.inputAmount, outputAmount: targetAtomic, legs: [firstLeg, lastLeg], atomic: false, side: "buy" as const };
}

type FundingInput = { txid: string; vout: number; value: string; scriptHex: string; token?: { category: string; amount: string } };
export type BuiltSwap = { unsignedTxHex: string; sourceOutputs: unknown[]; inputsToSign: number[]; expectedOutput: string; feeSats: string; feeTokenAmount: string; minerFeeSats: string; sourceSpendAtomic?: string; bchCostAtomic?: string; route: unknown };

export async function buildCauldronSwap(input: { sell: CauldronAsset; buy: CauldronAsset; amount: string; funding: FundingInput[]; receiveAddress: string; changeAddress: string; side?: "sell" | "buy"; minOutput?: string; network?: BchNetwork }) {
  if (input.sell === input.buy) throw new Error("A swap requires two different assets");
  const side = input.side || "sell";
  if (input.minOutput !== undefined && (!/^\d+$/.test(input.minOutput) || BigInt(input.minOutput) <= 0n)) throw new Error("Minimum output must be a positive integer in base units");
  if (side === "buy" && input.minOutput !== undefined) throw new Error("Exact-output trades cannot set a minimum output");
  const network = input.network || "mainnet";
  const request = { id: Date.now(), method: "tx.build", params: { sell: routerAsset(input.sell, network), buy: routerAsset(input.buy, network), amount: toAtomicAmount(input.amount, side === "buy" ? input.buy : input.sell), side, funding: input.funding.map(item => ({ txid: item.txid, vout: item.vout, value: item.value, script_hex: item.scriptHex, ...(item.token ? { token: item.token } : {}) })), receive_addr: input.receiveAddress, change_addr: input.changeAddress, ...(input.minOutput ? { min_output: input.minOutput } : {}) } };
  const url = routerUrl(network);
  return new Promise<BuiltSwap>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Cauldron transaction build timed out")); }, 10_000);
    const finish = (error?: Error, result?: BuiltSwap) => { clearTimeout(timeout); try { socket.close(); } catch {} if (error) reject(error); else if (result) resolve(result); };
    socket.once("error", () => finish(new Error("Cauldron transaction builder is unavailable")));
    socket.once("open", () => socket.send(JSON.stringify(request)));
    socket.on("message", payload => {
      try {
        const message = JSON.parse(payload.toString()) as { error?: { code?: string }; result?: Record<string, unknown> };
        if (message.error) return finish(new Error(`Cauldron build failed: ${message.error.code || "build_failed"}`));
        const result = message.result;
        if (!result || typeof result.unsigned_tx_hex !== "string" || !Array.isArray(result.source_outputs)) return;
        finish(undefined, { unsignedTxHex: result.unsigned_tx_hex, sourceOutputs: result.source_outputs, inputsToSign: Array.isArray(result.inputs_to_sign) ? result.inputs_to_sign.filter((item): item is number => typeof item === "number") : [], expectedOutput: String(result.expected_output || "0"), feeSats: String(result.fee_sats || "0"), feeTokenAmount: String(result.fee_token_amount || "0"), minerFeeSats: String(result.miner_fee_sats || "0"), route: result.route || null });
      } catch { finish(new Error("Cauldron returned an invalid transaction build")); }
    });
  });
}

export async function broadcastSignedTransaction(signedTxHex: string) {
  const response = await fetch(process.env.CAULDRON_BROADCAST_URL || "https://broadcast.cauldron.quest/broadcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: signedTxHex }) });
  if (!response.ok) throw new Error(`Broadcast failed with HTTP ${response.status}`);
  const payload = await response.json() as { txid?: string; error?: string };
  if (!payload.txid) throw new Error(payload.error || "Broadcast did not return a transaction id");
  return { txid: payload.txid };
}

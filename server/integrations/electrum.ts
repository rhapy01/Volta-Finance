import { decodeTransactionCommon, cashAddressToLockingBytecode, binToHex, encodeCashAddress, hexToBin } from "@bitauth/libauth";
import { ElectrumNetworkProvider, Network, type SpendableUtxo } from "cashscript";
import type { CauldronAsset } from "./cauldron";

const providers = new Map<string, ElectrumNetworkProvider>();
const chipnetBroadcastProviders = new Map<string, ElectrumNetworkProvider>();

export function getProvider(network: "mainnet" | "chipnet") {
  const key = network;
  const current = providers.get(key);
  if (current) return current;
  const provider = new ElectrumNetworkProvider(network === "chipnet" ? Network.CHIPNET : Network.MAINNET);
  providers.set(key, provider);
  return provider;
}

/**
 * Chipnet has no published Cauldron broadcast gateway. Try independent Electrum
 * peers in sequence so a stale pool view on one peer does not end the payment.
 * Mainnet Cauldron swaps use Riften's multi-node broadcaster from cauldron.ts.
 */
export async function broadcastChipnetTransaction(rawTransaction: string) {
  const configuredHosts = (process.env.CHIPNET_BROADCAST_ELECTRUM_HOSTS || "chipnet.bch.ninja,chipnet.imaginary.cash")
    .split(",").map((host) => host.trim()).filter(Boolean);
  const failures: string[] = [];
  const peers: Array<{ host: string; provider: ElectrumNetworkProvider }> = [];
  for (const host of configuredHosts) {
    let provider = chipnetBroadcastProviders.get(host);
    if (!provider) {
      provider = host === "chipnet.bch.ninja" ? getProvider("chipnet") : new ElectrumNetworkProvider(Network.CHIPNET, { hostname: host });
      chipnetBroadcastProviders.set(host, provider);
    }
    peers.push({ host, provider });
    try {
      return await provider.sendRawTransaction(rawTransaction);
    } catch (error) {
      failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let inputDetails = "";
  const decoded = decodeTransactionCommon(Uint8Array.from(rawTransaction.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []));
  if (typeof decoded !== "string") {
    const statusByPeer = await Promise.all(peers.map(async ({ host, provider }) => {
      const missing = await Promise.all(decoded.inputs.map(async (input) => {
        const txid = binToHex(input.outpointTransactionHash);
        const key = `${txid}:${input.outpointIndex}`;
        try {
          const parentHex = await provider.getRawTransaction(txid);
          const parent = decodeTransactionCommon(Uint8Array.from(parentHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []));
          if (typeof parent === "string" || !parent.outputs[input.outpointIndex]) return key;
          const live = await provider.getUtxosForLockingBytecode(parent.outputs[input.outpointIndex].lockingBytecode);
          return live.some((utxo) => utxo.txid.toLowerCase() === txid.toLowerCase() && utxo.vout === input.outpointIndex) ? null : key;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/no such mempool or blockchain transaction/i.test(message)) {
            return `${key} (parent transaction not found on this peer)`;
          }
          return `${key} (could not verify: ${message})`;
        }
      }));
      return `${host}: ${missing.filter(Boolean).length ? missing.filter(Boolean).join(", ") : "all transaction inputs currently appear unspent"}`;
    }));
    inputDetails = ` Input check: ${statusByPeer.join(" | ")}.`;
  }
  throw new Error(`Chipnet rejected the transaction through every configured Electrum peer. ${failures.join(" | ")}.${inputDetails}`);
}

export async function getWalletUtxos(input: { address: string; network?: "mainnet" | "chipnet"; asset?: CauldronAsset }) {
  const provider = getProvider(input.network || "mainnet");
  const utxos = await provider.getUtxos(input.address);
  return utxos
    .filter((utxo: SpendableUtxo) => input.asset === "BCH" || !input.asset || utxo.token?.category)
    .map((utxo: SpendableUtxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.satoshis.toString(),
      scriptHex: utxo.lockingBytecode,
      token: utxo.token ? {
        category: utxo.token.category,
        amount: utxo.token.amount.toString(),
        ...(utxo.token.nft ? { nft: utxo.token.nft } : {}),
      } : undefined,
    }));
}

/** Scan every explicitly requested address derived by the connected WizardConnect wallet.
 * The caller bounds the scan; applying the BIP44 gap limit again here skipped funded HD
 * addresses after the first 20 empty addresses (common on Chipnet wallets used for testing).
 */
export async function getWalletUtxosForAddresses(input: { addresses: Array<{ address: string; addressIndex: number; path?: "receive" | "change" | "defi" }>; network?: "mainnet" | "chipnet"; asset?: CauldronAsset }) {
  if (!input.addresses.length) return [];
  const results: Array<Awaited<ReturnType<typeof getWalletUtxos>>[number] & { addressIndex: number; addressPath: "receive" | "change" | "defi"; address: string }> = [];
  for (const path of ["receive", "change", "defi"] as const) {
    const unique = new Map<string, { address: string; addressIndex: number; path: typeof path }>();
    for (const item of input.addresses.filter((candidate) => (candidate.path || "receive") === path).sort((a, b) => a.addressIndex - b.addressIndex)) {
      if (!unique.has(item.address)) unique.set(item.address, { ...item, path });
    }
    const addresses = [...unique.values()];
    // A small in-flight window keeps public Chipnet Electrum peers responsive
    // without serializing every address or overwhelming their WebSocket.
    for (let offset = 0; offset < addresses.length; offset += 4) {
      const batch = addresses.slice(offset, offset + 4);
      const checked = await Promise.all(batch.map(async (item) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const utxos = await getWalletUtxos({ address: item.address, network: input.network, asset: input.asset });
            return { item, utxos };
          } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        throw lastError;
      }));
      for (const result of checked) {
        results.push(...result.utxos.map((utxo) => ({ ...utxo, addressIndex: result.item.addressIndex, addressPath: path, address: result.item.address })));
      }
    }
  }
  return results;
}

/** Verify Cauldron's Chipnet prevouts before asking the user to sign. The router
 * and public Electrum peers can briefly disagree about pool mempool state; never
 * ask a wallet to approve a transaction whose inputs neither peer can spend.
 */
export async function verifyChipnetTransactionInputs(unsignedTxHex: string, sourceOutputs: unknown[]) {
  const bytes = Uint8Array.from(unsignedTxHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
  const decoded = decodeTransactionCommon(bytes);
  if (typeof decoded === "string") throw new Error(`Cauldron returned an invalid Chipnet transaction: ${decoded}`);
  if (sourceOutputs.length !== decoded.inputs.length) throw new Error("Cauldron source outputs do not match its Chipnet transaction inputs");
  const inputs = decoded.inputs.map((input, index) => {
    const source = sourceOutputs[index] as { locking_script_hex?: unknown };
    if (typeof source?.locking_script_hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(source.locking_script_hex)) {
      throw new Error(`Cauldron did not provide a valid source script for Chipnet input ${index}`);
    }
    return { key: `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`, scriptHex: source.locking_script_hex };
  });
  const peers: Array<{ host: string; provider: ElectrumNetworkProvider }> = [
    { host: "chipnet.bch.ninja", provider: getProvider("chipnet") },
    { host: "chipnet.imaginary.cash", provider: new ElectrumNetworkProvider(Network.CHIPNET, { hostname: "chipnet.imaginary.cash" }) },
  ];
  const peerResults = await Promise.all(peers.map(async ({ host, provider }) => {
    try {
      const statuses = await Promise.all(inputs.map(async (input) => {
        const utxos = await provider.getUtxosForLockingBytecode(input.scriptHex);
        return { key: input.key, unspent: utxos.some((utxo) => `${utxo.txid.toLowerCase()}:${utxo.vout}` === input.key.toLowerCase()) };
      }));
      return { host, statuses };
    } catch (error) {
      return { host, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const unavailable = peerResults.filter((result) => "error" in result);
  const healthy = peerResults.filter((result): result is { host: string; statuses: Array<{ key: string; unspent: boolean }> } => Array.isArray(result.statuses));
  if (!healthy.length) return { valid: false, unavailable: peerResults.map((peer) => `${peer.host}: ${"error" in peer ? peer.error : "query failed"}`), missing: [] as string[] };
  const missing = inputs.filter((input) => !healthy.some((peer) => peer.statuses.some((status) => status.key === input.key && status.unspent))).map((input) => input.key);
  return { valid: missing.length === 0, unavailable: unavailable.map((peer) => `${peer.host}: ${"error" in peer ? peer.error : "query failed"}`), missing };
}

export async function getTransactionStatus(input: { txid: string; network?: "mainnet" | "chipnet" }) {
  const provider = getProvider(input.network || "mainnet");
  const response = await provider.performRequest("blockchain.transaction.get", input.txid, true) as { confirmations?: number; blockheight?: number; hex?: string } | string;
  if (typeof response === "string") return { found: true, confirmations: 0, blockheight: null, rawHex: response };
  return { found: Boolean(response?.hex), confirmations: Number(response?.confirmations || 0), blockheight: response?.blockheight ?? null, rawHex: response?.hex || null };
}

/** Resolve the previous-output addresses that funded a public BCH transaction. */
export async function getTransactionInputSources(input: { txid: string; network: "mainnet" | "chipnet" }) {
  const provider = getProvider(input.network);
  const rawHex = await provider.getRawTransaction(input.txid);
  const decoded = decodeTransactionCommon(Uint8Array.from(rawHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []));
  if (typeof decoded === "string") throw new Error(`Unable to decode transaction ${input.txid}: ${decoded}`);
  const prefix = input.network === "chipnet" ? "bchtest" : "bitcoincash";
  const describeOutput = (output: (typeof decoded.outputs)[number]) => {
    const script = binToHex(output.lockingBytecode);
    let type: "p2pkh" | "p2sh" | undefined;
    let payload: string | undefined;
    if (script.startsWith("76a914") && script.endsWith("88ac") && script.length === 50) { type = "p2pkh"; payload = script.slice(6, -4); }
    else if (script.startsWith("a914") && script.endsWith("87") && script.length === 46) { type = "p2sh"; payload = script.slice(4, -2); }
    else if (script.startsWith("aa20") && script.endsWith("87") && script.length === 70) { type = "p2sh"; payload = script.slice(4, -2); }
    let address: string | null = null;
    if (type && payload) {
      try { const encoded = encodeCashAddress({ prefix, type, payload: hexToBin(payload) }); address = typeof encoded === "string" ? null : encoded.address; } catch { address = null; }
    }
    return { address, valueAtomic: output.valueSatoshis.toString(), asset: output.token ? "CashToken" : "BCH", tokenCategory: output.token ? binToHex(output.token.category) : null, tokenAmount: output.token?.amount.toString() ?? null };
  };
  const results: Array<{ outpoint: string; address: string | null; valueAtomic: string; asset: string; tokenCategory: string | null; tokenAmount: string | null }> = [];
  for (let offset = 0; offset < decoded.inputs.length; offset += 4) {
    const batch = decoded.inputs.slice(offset, offset + 4);
    const batchResults = await Promise.all(batch.map(async (txInput) => {
      const previousTxid = binToHex(txInput.outpointTransactionHash);
      if (/^0+$/.test(previousTxid)) return { outpoint: "Coinbase", address: null, valueAtomic: "0", asset: "Unknown", tokenCategory: null, tokenAmount: null };
      try {
        const previousHex = await provider.getRawTransaction(previousTxid);
        const previous = decodeTransactionCommon(Uint8Array.from(previousHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []));
        if (typeof previous === "string" || !previous.outputs[txInput.outpointIndex]) return { outpoint: `${previousTxid}:${txInput.outpointIndex}`, address: null, valueAtomic: "0", asset: "Unknown", tokenCategory: null, tokenAmount: null };
        return { outpoint: `${previousTxid}:${txInput.outpointIndex}`, ...describeOutput(previous.outputs[txInput.outpointIndex]) };
      } catch { return { outpoint: `${previousTxid}:${txInput.outpointIndex}`, address: null, valueAtomic: "0", asset: "Unknown", tokenCategory: null, tokenAmount: null }; }
    }));
    results.push(...batchResults);
  }
  return results;
}

export async function verifyRecipientOutput(input: { txid: string; recipientAddress: string; expectedAsset: CauldronAsset; expectedAmountAtomic: string; tokenCategory?: string; network?: "mainnet" | "chipnet" }) {
  const provider = getProvider(input.network || "mainnet");
  const rawHex = await provider.getRawTransaction(input.txid);
  const decoded = decodeTransactionCommon(Uint8Array.from(rawHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []));
  if (typeof decoded === "string") throw new Error(`Unable to decode transaction ${input.txid}: ${decoded}`);
  const expectedLocking = cashAddressToLockingBytecode(input.recipientAddress);
  if (typeof expectedLocking === "string") throw new Error(`Invalid recipient address: ${expectedLocking}`);
  const expectedScript = binToHex(expectedLocking.bytecode);
  const expectedAmount = BigInt(input.expectedAmountAtomic);
  const receivedAmount = decoded.outputs.reduce((total, output) => {
    const outputScript = binToHex(output.lockingBytecode);
    if (outputScript !== expectedScript) return total;
    if (input.expectedAsset === "BCH") return output.token ? total : total + output.valueSatoshis;
    const token = output.token;
    return token && binToHex(token.category) === input.tokenCategory ? total + token.amount : total;
  }, 0n);
  return { verified: receivedAmount >= expectedAmount, amountAtomic: receivedAmount.toString(), txid: input.txid, recipientAddress: input.recipientAddress, expectedAsset: input.expectedAsset, expectedAmountAtomic: input.expectedAmountAtomic };
}

import type { DappConnectionManager } from "@wizardconnect/dapp";
import { sourceOutputToRelay } from "@wizardconnect/core/hdwalletv1-serialize";
import type { WcSourceOutput } from "cashscript";
import { binToHex, cashAddressToLockingBytecode, decodeTransactionCommon, encodeTransactionCommon, hexToBin } from "@bitauth/libauth";

const BCH_DUST_SATS = 546n;
// CashToken prefixes enlarge the serialized output script; use headroom above
// the standard P2PKH dust threshold for token outputs and token change.
const CASHTOKEN_DUST_SATS = 1_000n;

export type WizardInputPath = [number, "receive" | "change" | "defi", number];

export type SignableTransaction = {
  transaction: string;
  sourceOutputs: WcSourceOutput[];
  inputsToSign: number[];
};

export function normalizeCauldronSourceOutputs(sourceOutputs: unknown[], unsignedTxHex: string): WcSourceOutput[] {
  const transaction = decodeTransactionCommon(hexToBin(unsignedTxHex));
  if (typeof transaction === "string") throw new Error(`Cauldron returned an invalid unsigned transaction: ${transaction}`);
  if (sourceOutputs.length !== transaction.inputs.length) throw new Error("Router prevout details do not match the built transaction inputs");
  return sourceOutputs.map((raw, index) => {
    const output = raw as { value?: string; locking_script_hex?: string; token?: { category: string; amount: string; nft?: { capability: "none" | "mutable" | "minting"; commitment: string } } };
    if (!output.value || !output.locking_script_hex) throw new Error("Router returned an incomplete source output");
    const input = transaction.inputs[index];
    return {
      outpointIndex: input.outpointIndex,
      outpointTransactionHash: input.outpointTransactionHash,
      sequenceNumber: input.sequenceNumber,
      unlockingBytecode: new Uint8Array(),
      valueSatoshis: BigInt(output.value),
      lockingBytecode: hexToBin(output.locking_script_hex),
      ...(output.token ? { token: { category: hexToBin(output.token.category), amount: BigInt(output.token.amount), ...(output.token.nft ? { nft: { capability: output.token.nft.capability, commitment: hexToBin(output.token.nft.commitment) } } : {}) } } : {}),
    } as WcSourceOutput;
  });
}

export function cauldronInputPaths(unsignedTxHex: string, inputsToSign: number[], funding: Array<{ txid: string; vout: number; addressPath?: "receive" | "change" | "defi"; addressIndex?: number }>): WizardInputPath[] {
  const transaction = decodeTransactionCommon(hexToBin(unsignedTxHex));
  if (typeof transaction === "string") throw new Error(`Cauldron returned an invalid unsigned transaction: ${transaction}`);
  const fundingByOutpoint = new Map(funding.map((item) => [`${item.txid.toLowerCase()}:${item.vout}`, item]));
  return inputsToSign.map((inputIndex) => {
    const input = transaction.inputs[inputIndex];
    if (!input) throw new Error("Cauldron requested a signature for an input that does not exist");
    const txid = binToHex(input.outpointTransactionHash).toLowerCase();
    const ownedInput = fundingByOutpoint.get(`${txid}:${input.outpointIndex}`);
    if (!ownedInput) throw new Error("Cauldron requested a signature for a funding input not supplied by this wallet");
    return [inputIndex, ownedInput.addressPath || "receive", ownedInput.addressIndex ?? 0];
  });
}

export function buildDirectBchPayment(input: { funding: Array<{ txid: string; vout: number; value: string; scriptHex: string }>; amountAtomic: string; recipientAddress: string; changeAddress: string }) {
  const recipient = cashAddressToLockingBytecode(input.recipientAddress);
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof recipient === "string" || typeof change === "string") throw new Error("Invalid BCH recipient or change address");
  const total = input.funding.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
  const amount = BigInt(input.amountAtomic);
  const fee = 1000n;
  if (total < amount + fee) throw new Error("Insufficient BCH funding for the payment amount and miner fee.");
  let changeAmount = total - amount - fee;
  const outputs: Array<{ valueSatoshis: bigint; lockingBytecode: Uint8Array }> = [{ valueSatoshis: amount, lockingBytecode: recipient.bytecode }];
  if (changeAmount >= 546n) outputs.push({ valueSatoshis: changeAmount, lockingBytecode: change.bytecode });
  else changeAmount = 0n;
  // Libauth reverses display-order txids when serializing; keep them in display order here.
  const transaction = encodeTransactionCommon({ version: 2, locktime: 0, inputs: input.funding.map((utxo) => ({ outpointIndex: utxo.vout, outpointTransactionHash: hexToBin(utxo.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })), outputs });
  return {
    unsignedTxHex: binToHex(transaction),
    sourceOutputs: input.funding.map((utxo) => ({ outpointIndex: utxo.vout, outpointTransactionHash: hexToBin(utxo.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(), valueSatoshis: BigInt(utxo.value), lockingBytecode: hexToBin(utxo.scriptHex) })) as WcSourceOutput[],
    inputsToSign: input.funding.map((_, index) => index),
    expectedOutput: amount.toString(),
    feeSats: (total - amount - changeAmount).toString(),
  };
}

export function buildDirectCashTokenPayment(input: { funding: Array<{ txid: string; vout: number; value: string; scriptHex: string; token?: { category: string; amount: string } }>; amountAtomic: string; category: string; recipientAddress: string; changeAddress: string }) {
  const recipient = cashAddressToLockingBytecode(input.recipientAddress);
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof recipient === "string" || typeof change === "string") throw new Error("Invalid CashToken recipient or change address");
  const totalSats = input.funding.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n);
  const totalTokens = input.funding.reduce((sum, utxo) => sum + BigInt(utxo.token?.amount || "0"), 0n);
  const amount = BigInt(input.amountAtomic);
  const recipientSats = CASHTOKEN_DUST_SATS;
  const fee = 1000n;
  if (totalTokens < amount || totalSats < recipientSats + fee) throw new Error("Insufficient CashToken funding for the payment amount and miner fee.");
  const tokenChange = totalTokens - amount;
  const changeSats = totalSats - recipientSats - fee;
  const outputs: Array<{ valueSatoshis: bigint; lockingBytecode: Uint8Array; token?: { category: Uint8Array; amount: bigint } }> = [{ valueSatoshis: recipientSats, lockingBytecode: recipient.bytecode, token: { category: hexToBin(input.category), amount } }];
  if (tokenChange > 0n) {
    if (changeSats < CASHTOKEN_DUST_SATS) throw new Error("Insufficient BCH dust for CashToken change");
    outputs.push({ valueSatoshis: changeSats, lockingBytecode: change.bytecode, token: { category: hexToBin(input.category), amount: tokenChange } });
  } else if (changeSats >= BCH_DUST_SATS) outputs.push({ valueSatoshis: changeSats, lockingBytecode: change.bytecode });
  const transaction = encodeTransactionCommon({ version: 2, locktime: 0, inputs: input.funding.map((utxo) => ({ outpointIndex: utxo.vout, outpointTransactionHash: hexToBin(utxo.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })), outputs });
  return {
    unsignedTxHex: binToHex(transaction),
    sourceOutputs: input.funding.map((utxo) => ({ outpointIndex: utxo.vout, outpointTransactionHash: hexToBin(utxo.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(), valueSatoshis: BigInt(utxo.value), lockingBytecode: hexToBin(utxo.scriptHex), ...(utxo.token ? { token: { category: hexToBin(utxo.token.category), amount: BigInt(utxo.token.amount) } } : {}) })) as WcSourceOutput[],
    inputsToSign: input.funding.map((_, index) => index),
    expectedOutput: amount.toString(),
    feeSats: fee.toString(),
  };
}

export type DirectBatchOutput = { address: string; amountAtomic: string };
export type BatchFunding = { txid: string; vout: number; value: string; scriptHex: string; addressIndex?: number; addressPath?: "receive" | "change" | "defi"; token?: { category: string; amount: string; nft?: { capability: "none" | "mutable" | "minting"; commitment: string } } };

export function selectDirectInvoiceBatchFunding(input: { funding: BatchFunding[]; outputs: DirectBatchOutput[]; asset: "BCH" | "PUSD" | "MUSD"; category?: string; preserveTokenCategories?: string[] }) {
  const feeFor = (inputs: number, extraOutputs = 0) => 1000n + BigInt(Math.max(0, inputs - 1) * 100 + Math.max(0, input.outputs.length + extraOutputs - 1) * 100);
  if (input.asset === "BCH") {
    const candidates = input.funding.filter((item) => !item.token).sort((a, b) => { const diff = BigInt(b.value) - BigInt(a.value); return diff > 0n ? 1 : diff < 0n ? -1 : 0; });
    const target = input.outputs.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
    const selected: BatchFunding[] = [];
    let total = 0n;
    for (const candidate of candidates) {
      selected.push(candidate);
      total += BigInt(candidate.value);
      if (total >= target + feeFor(selected.length)) return selected;
    }
    const allowedCategories = new Set(input.preserveTokenCategories || []);
    const tokenCandidates = input.funding.filter((item) => item.token !== undefined && !item.token.nft && allowedCategories.has(item.token.category)).sort((a, b) => {
      const diff = BigInt(b.value) - BigInt(a.value);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });
    const tokenCategories = new Set(selected.flatMap((item) => item.token ? [item.token.category] : []));
    for (const candidate of tokenCandidates) {
      selected.push(candidate);
      total += BigInt(candidate.value);
      tokenCategories.add(candidate.token!.category);
      const tokenDust = BigInt(tokenCategories.size) * CASHTOKEN_DUST_SATS;
      if (total >= target + feeFor(selected.length, tokenCategories.size) + tokenDust) return selected;
    }
    throw new Error("Insufficient BCH funding for the selected invoices and miner fee");
  }
  if (!input.category) throw new Error("CashToken category is missing");
  const targetTokens = input.outputs.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
  const tokenCandidates = input.funding.filter((item) => item.token !== undefined && item.token.category === input.category && !item.token.nft).sort((a, b) => { const diff = BigInt(b.token!.amount) - BigInt(a.token!.amount); return diff > 0n ? 1 : diff < 0n ? -1 : 0; });
  const selected: BatchFunding[] = [];
  let tokenTotal = 0n;
  let satTotal = 0n;
  for (const candidate of tokenCandidates) {
    selected.push(candidate);
    tokenTotal += BigInt(candidate.token!.amount);
    satTotal += BigInt(candidate.value);
    if (tokenTotal >= targetTokens) break;
  }
  if (tokenTotal < targetTokens) throw new Error(`The wallet does not hold enough ${input.asset} to pay this batch`);
  const bchCandidates = input.funding.filter((item) => !item.token).sort((a, b) => { const diff = BigInt(b.value) - BigInt(a.value); return diff > 0n ? 1 : diff < 0n ? -1 : 0; });
  const dust = BigInt(input.outputs.length) * CASHTOKEN_DUST_SATS;
  const requiresTokenChangeDust = tokenTotal > targetTokens;
  for (const candidate of bchCandidates) {
    if (satTotal >= dust + feeFor(selected.length) + (requiresTokenChangeDust ? CASHTOKEN_DUST_SATS : 0n)) break;
    selected.push(candidate);
    satTotal += BigInt(candidate.value);
  }
  if (satTotal < dust + feeFor(selected.length) + (requiresTokenChangeDust ? CASHTOKEN_DUST_SATS : 0n)) throw new Error("The wallet needs more BCH to cover token output dust, change, and the miner fee");
  return selected;
}

export function buildDirectBchBatchPayment(input: { funding: BatchFunding[]; outputs: DirectBatchOutput[]; changeAddress: string; tokenChangeAddress?: string }) {
  if (!input.outputs.length || input.outputs.length > 50) throw new Error("A direct BCH batch must contain one to fifty recipients");
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof change === "string") throw new Error("Invalid BCH change address");
  const totalInput = input.funding.reduce((sum, item) => sum + BigInt(item.value), 0n);
  const outputs: Array<{ valueSatoshis: bigint; lockingBytecode: Uint8Array; token?: { category: Uint8Array; amount: bigint } }> = input.outputs.map((item) => {
    const recipient = cashAddressToLockingBytecode(item.address);
    const amount = BigInt(item.amountAtomic);
    if (typeof recipient === "string" || amount < BCH_DUST_SATS) throw new Error("Each BCH invoice payment must use a valid address and meet the dust limit");
    return { valueSatoshis: amount, lockingBytecode: recipient.bytecode };
  });
  const tokenTotals = new Map<string, bigint>();
  for (const item of input.funding) {
    if (!item.token) continue;
    if (item.token.nft) throw new Error("This BCH payment cannot spend NFT-bearing outputs yet; keep those tokens in the wallet");
    tokenTotals.set(item.token.category, (tokenTotals.get(item.token.category) || 0n) + BigInt(item.token.amount));
  }
  if (tokenTotals.size && !input.tokenChangeAddress) throw new Error("A token-aware change address is needed to preserve CashTokens while paying BCH");
  const tokenChangeAddress = input.tokenChangeAddress ? cashAddressToLockingBytecode(input.tokenChangeAddress) : null;
  if (typeof tokenChangeAddress === "string") throw new Error("Invalid CashToken change address");
  const tokenChange = [...tokenTotals.entries()].map(([category, amount]) => ({
    valueSatoshis: CASHTOKEN_DUST_SATS,
    lockingBytecode: tokenChangeAddress!.bytecode,
    token: { category: hexToBin(category), amount },
  }));
  const tokenDust = BigInt(tokenChange.length) * CASHTOKEN_DUST_SATS;
  const fee = 1000n + BigInt(Math.max(0, input.funding.length - 1) * 100 + Math.max(0, outputs.length + tokenChange.length - 1) * 100);
  const totalOutput = outputs.reduce((sum, item) => sum + item.valueSatoshis, 0n);
  if (totalInput < totalOutput + fee + tokenDust) throw new Error("Insufficient BCH funding for invoice outputs, CashToken preservation, and miner fee");
  const changeAmount = totalInput - totalOutput - fee - tokenDust;
  const changeIsSent = changeAmount >= BCH_DUST_SATS;
  outputs.push(...tokenChange);
  if (changeIsSent) outputs.push({ valueSatoshis: changeAmount, lockingBytecode: change.bytecode });
  const transaction = encodeTransactionCommon({ version: 2, locktime: 0, inputs: input.funding.map((item) => ({ outpointIndex: item.vout, outpointTransactionHash: hexToBin(item.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })), outputs });
  return { unsignedTxHex: binToHex(transaction), sourceOutputs: input.funding.map((item) => ({ outpointIndex: item.vout, outpointTransactionHash: hexToBin(item.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(), valueSatoshis: BigInt(item.value), lockingBytecode: hexToBin(item.scriptHex), ...(item.token ? { token: { category: hexToBin(item.token.category), amount: BigInt(item.token.amount) } } : {}) })) as WcSourceOutput[], inputsToSign: input.funding.map((_, index) => index), feeSats: (changeIsSent ? fee : totalInput - totalOutput - tokenDust).toString() };
}

export function buildDirectCashTokenBatchPayment(input: { funding: BatchFunding[]; outputs: DirectBatchOutput[]; category: string; changeAddress: string }) {
  if (!input.outputs.length || input.outputs.length > 50) throw new Error("A direct CashToken batch must contain one to fifty recipients");
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof change === "string") throw new Error("Invalid CashToken change address");
  const tokenInputs = input.funding.reduce((sum, item) => {
    if (item.token && item.token.category !== input.category) throw new Error("Funding contains a different CashToken category");
    return sum + BigInt(item.token?.amount || "0");
  }, 0n);
  const totalSats = input.funding.reduce((sum, item) => sum + BigInt(item.value), 0n);
  const outputs: Array<{ valueSatoshis: bigint; lockingBytecode: Uint8Array; token?: { category: Uint8Array; amount: bigint } }> = input.outputs.map((item) => {
    const recipient = cashAddressToLockingBytecode(item.address);
    const amount = BigInt(item.amountAtomic);
    if (typeof recipient === "string" || !recipient.tokenSupport) throw new Error("PUSD/MUSD invoice destination must be a CashTokens-aware address");
    if (amount <= 0n) throw new Error("CashToken invoice amount must be positive");
    return { valueSatoshis: CASHTOKEN_DUST_SATS, lockingBytecode: recipient.bytecode, token: { category: hexToBin(input.category), amount } };
  });
  const requestedTokens = input.outputs.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
  const dust = BigInt(outputs.length) * CASHTOKEN_DUST_SATS;
  const fee = 1000n + BigInt(Math.max(0, input.funding.length - 1) * 100 + Math.max(0, outputs.length - 1) * 100);
  if (tokenInputs < requestedTokens) throw new Error("Selected wallet does not hold enough of the invoice asset");
  if (totalSats < dust + fee) throw new Error("The wallet needs BCH to cover CashToken output dust and miner fee");
  const tokenChange = tokenInputs - requestedTokens;
  const changeSats = totalSats - dust - fee;
  if (tokenChange > 0n) {
    if (changeSats < CASHTOKEN_DUST_SATS) throw new Error("Insufficient BCH dust to return the remaining CashTokens");
    outputs.push({ valueSatoshis: changeSats, lockingBytecode: change.bytecode, token: { category: hexToBin(input.category), amount: tokenChange } });
  } else if (changeSats >= BCH_DUST_SATS) outputs.push({ valueSatoshis: changeSats, lockingBytecode: change.bytecode });
  const actualFee = tokenChange > 0n || changeSats >= 546n ? fee : totalSats - dust;
  const transaction = encodeTransactionCommon({ version: 2, locktime: 0, inputs: input.funding.map((item) => ({ outpointIndex: item.vout, outpointTransactionHash: hexToBin(item.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() })), outputs });
  const sourceOutputs = input.funding.map((item) => ({ outpointIndex: item.vout, outpointTransactionHash: hexToBin(item.txid), sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(), valueSatoshis: BigInt(item.value), lockingBytecode: hexToBin(item.scriptHex), ...(item.token ? { token: { category: hexToBin(item.token.category), amount: BigInt(item.token.amount) } } : {}) })) as WcSourceOutput[];
  return { unsignedTxHex: binToHex(transaction), sourceOutputs, inputsToSign: input.funding.map((_, index) => index), feeSats: actualFee.toString() };
}

/** Request explicit wallet approval. The wallet remains the only signer. */
export async function signWithWizardConnect(manager: DappConnectionManager, built: SignableTransaction, inputPaths: WizardInputPath[]) {
  if (!built.transaction || !Array.isArray(built.sourceOutputs)) throw new Error("The unsigned transaction is incomplete");
  if (built.inputsToSign.some((inputIndex) => !inputPaths.some(([index]) => index === inputIndex))) {
    throw new Error("Every funding input must have a matching WizardConnect HD path");
  }
  // Relay messages use JSON; BigInt and Uint8Array source-output values must be
  // encoded with WizardConnect's canonical hdwalletv1 wire format before sending.
  const relaySourceOutputs = built.sourceOutputs.map(sourceOutputToRelay) as unknown as WcSourceOutput[];
  let response: Awaited<ReturnType<typeof manager.signTransaction>>;
  try {
    response = await manager.signTransaction({
      transaction: { transaction: built.transaction, sourceOutputs: relaySourceOutputs, broadcast: false, userPrompt: "Approve Volta Finance intent payment" },
      inputPaths,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/publish timed out|failed to publish .*all relays|relay connection closed/i.test(message)) {
      throw new Error("WizardConnect could not deliver the signing request to your wallet. The transaction was not broadcast. Keep the wallet paired, wait for the relay to reconnect, then try again.");
    }
    throw error;
  }
  if (!response.signedTransaction) throw new Error("Wallet did not return a signed transaction");
  return response.signedTransaction;
}

export async function broadcastSignedTransaction(signedTransaction: string) {
  const response = await fetch("https://broadcast.cauldron.quest/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx: signedTransaction }),
  });
  const payload = await response.json() as { txid?: string; error?: string };
  if (!response.ok || !payload.txid) throw new Error(payload.error || `Broadcast failed with HTTP ${response.status}`);
  return payload.txid;
}

import { randomBytes } from "node:crypto";
import { Contract } from "cashscript";
import { binToHex, cashAddressToLockingBytecode, decodeTransactionCommon, encodeTransactionCommon, hexToBin } from "@bitauth/libauth";
import { computeOptimalBuy, computeOptimalSell, getCauldronPools, prepareBuyTokens, prepareSellTokens, type CauldronActivePool } from "@mr-zwets/cauldron-swap-sdk";
import { cauldronArtifactWithPkh } from "@mr-zwets/cauldron-swap-sdk/dist/utils.js";
import { getProvider } from "./electrum";
import { getCashTokenCategories, toAtomicAmount, type BuiltSwap, type CauldronAsset } from "./cauldron";

// Wallet signing adds unlocking scripts that are larger than the builder's
// unsigned size estimate. Leave room so payroll transactions clear the
// default 1 sat/byte relay floor with a small safety margin.
const PAYROLL_FEE_SATS_PER_ESTIMATED_BYTE = 1.5;

type ChipnetBuyInput = {
  sell: CauldronAsset;
  buy: CauldronAsset;
  amount: string;
  funding: Array<{ txid: string; vout: number; value: string; scriptHex: string; token?: { category: string; amount: string } }>;
  receiveAddress: string;
  changeAddress: string;
  side?: "sell" | "buy";
  network?: "mainnet" | "chipnet";
};

export type ChipnetPayrollPayout = { asset: CauldronAsset; amountAtomic: string; address: string };

function outpointKey(txid: string, vout: number) {
  return `${txid.toLowerCase()}:${vout}`;
}

async function getCurrentPools(tokenId: string) {
  const provider = getProvider("chipnet");
  const indexedPools = await getCauldronPools(tokenId, "chipnet");
  if (!indexedPools.length) throw new Error("Cauldron's Chipnet indexer returned no pool owners for this token");

  const pools = (await Promise.all(indexedPools.map(async (indexedPool) => {
    const contract = new Contract(cauldronArtifactWithPkh(indexedPool.owner_pkh), [], { provider, contractType: "p2sh32" });
    const utxos = await provider.getUtxos(contract.tokenAddress);
    const currentTokenOutputs = utxos.filter((utxo) => utxo.token?.category.toLowerCase() === tokenId && !utxo.token?.nft);
    return currentTokenOutputs.map((utxo) => {
      const sats = Number(utxo.satoshis);
      const tokens = Number(utxo.token!.amount);
      if (!Number.isSafeInteger(sats) || !Number.isSafeInteger(tokens)) throw new Error("A live Chipnet pool amount exceeds safe SDK precision");
      const script = cashAddressToLockingBytecode(contract.tokenAddress);
      if (typeof script === "string") throw new Error(`Could not encode a live Chipnet pool script: ${script}`);
      return {
        pool: { ...indexedPool, txid: utxo.txid, tx_pos: utxo.vout, sats, tokens },
        scriptHex: binToHex(script.bytecode),
        address: contract.tokenAddress,
      };
    });
  }))).flat();

  if (!pools.length) throw new Error("The discovered Cauldron pools have no live unspent outputs on Chipnet");
  return { provider, pools };
}

/**
 * Compose an entire BCH-funded payroll into one Chipnet transaction. CashToken
 * swaps are aggregated by token category so a pool UTXO is never spent twice;
 * each resulting token amount is then split into the employees' exact outputs.
 */
export async function buildChipnetPayrollBatch(input: {
  payouts: ChipnetPayrollPayout[];
  funding: Array<{ txid: string; vout: number; value: string; scriptHex: string }>;
  changeAddress: string;
}): Promise<BuiltSwap> {
  if (!input.payouts.length || input.payouts.length > 50) throw new Error("A BCH payroll batch must contain one to fifty payouts");
  if (!input.funding.length) throw new Error("No BCH funding inputs were supplied for this payroll batch");
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof change === "string" || change.prefix !== "bchtest") throw new Error("Payroll change address must be a valid Chipnet address");
  const fundingKeys = new Set<string>();
  const walletUtxos = input.funding.map((item) => {
    const key = outpointKey(item.txid, item.vout);
    if (fundingKeys.has(key)) throw new Error("Payroll funding contains a duplicate BCH input");
    fundingKeys.add(key);
    return { txid: item.txid, vout: item.vout, satoshis: BigInt(item.value), lockingBytecode: hexToBin(item.scriptHex) };
  });
  const directOutputs = input.payouts.filter((item) => item.asset === "BCH").map((item) => {
    const recipient = cashAddressToLockingBytecode(item.address);
    const amount = BigInt(item.amountAtomic);
    if (typeof recipient === "string" || recipient.prefix !== "bchtest" || amount < 546n) throw new Error("Each BCH payroll payout needs a valid Chipnet address and must meet the BCH dust limit");
    return { to: item.address, amount };
  });
  const grouped = new Map<"PUSD" | "MUSD", ChipnetPayrollPayout[]>();
  for (const payout of input.payouts) {
    if (payout.asset === "BCH") continue;
    const decoded = cashAddressToLockingBytecode(payout.address);
    if (typeof decoded === "string" || decoded.prefix !== "bchtest" || !decoded.tokenSupport) throw new Error(`${payout.asset} payroll requires a token-aware Chipnet receiving address`);
    const group = grouped.get(payout.asset) || [];
    group.push(payout);
    grouped.set(payout.asset, group);
  }

  const placeholderKey = new Uint8Array(randomBytes(32));
  let composed: any = null; // All grouped builders come from the same Cauldron SDK CashScript version.
  const composedInputs = new Map<string, any>();
  const addedWalletInputs = new Set<string>();
  const reservedWalletKeys = new Set<string>();
  const poolSources = new Map<string, { value: string; locking_script_hex: string; token: { category: string; amount: string } }>();
  const poolKeys = new Set<string>();
  const poolOutputs: Array<{ to: string; amount: bigint; token?: { category: string; amount: bigint } }> = [];
  const tokenRecipients: Array<{ to: string; amount: bigint; category: string }> = [];
  const fees: bigint[] = [];

  for (const [asset, recipients] of grouped) {
    const category = getCashTokenCategories("chipnet")[asset];
    if (!category) throw new Error(`${asset} has no configured Chipnet token category`);
    const totalAmount = recipients.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
    const { provider: liveProvider, pools } = await getCurrentPools(category);
    const representativeAddress = recipients[0].address;
    const availableWalletUtxos = walletUtxos.filter((item) => !reservedWalletKeys.has(outpointKey(item.txid, item.vout)));
    const built = await prepareBuyTokens(
      pools.map(({ pool }) => pool), totalAmount, representativeAddress,
      placeholderKey, liveProvider, availableWalletUtxos,
    );
    composed ||= built.transactionBuilder;

    for (const item of built.transactionBuilder.inputs) {
      const key = outpointKey(item.txid, item.vout);
      if (fundingKeys.has(key)) {
        if (!addedWalletInputs.has(key)) {
          addedWalletInputs.add(key);
          reservedWalletKeys.add(key);
          composedInputs.set(key, item);
        }
        continue;
      }
      if (poolKeys.has(key)) throw new Error("Two payroll routes unexpectedly selected the same Cauldron pool input; rebuild the batch from current pool outputs");
      poolKeys.add(key);
      composedInputs.set(key, item);
      const sourcePool = pools.find(({ pool }) => outpointKey(pool.txid, pool.tx_pos) === key);
      if (!sourcePool) throw new Error(`Could not identify Cauldron pool input ${key}`);
      poolSources.set(key, { value: sourcePool.pool.sats.toString(), locking_script_hex: sourcePool.scriptHex, token: { category, amount: sourcePool.pool.tokens.toString() } });
    }

    for (const output of built.transactionBuilder.outputs) {
      if (output.to === representativeAddress) continue; // Remove SDK's single-recipient token output and BCH change.
      poolOutputs.push(output as typeof poolOutputs[number]);
    }
    for (const item of recipients) tokenRecipients.push({ to: item.address, amount: BigInt(item.amountAtomic), category });
    fees.push(built.totalFees);
  }

  if (!grouped.size) throw new Error("The combined Cauldron composer needs at least one CashToken payout; use the direct BCH batch path for BCH-only payroll");
  if (!addedWalletInputs.size) throw new Error("Cauldron did not select any BCH wallet funding inputs");
  if (!composed) throw new Error("No Cauldron route was prepared for this payroll batch");
  // Reuse the SDK's own builder instance/version. It regenerates every contract
  // unlocker for the final input indexes when build() runs.
  composed.inputs = [
    ...[...poolKeys].map((key) => composedInputs.get(key)),
    ...[...addedWalletInputs].map((key) => composedInputs.get(key)),
  ];
  const fixedOutputs = [
    ...poolOutputs,
    ...directOutputs,
    ...tokenRecipients.map((item) => ({ to: item.to, amount: 1_000n, token: { category: item.category, amount: item.amount } })),
  ];
  const totalInputSats = [...composedInputs.values()].reduce((sum, item) => sum + BigInt(item.satoshis), 0n);
  const fixedOutputSats = fixedOutputs.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const changeOutput = { to: input.changeAddress, amount: 546n };
  composed.outputs = [...fixedOutputs, changeOutput];
  const estimatedFee = BigInt(Math.ceil(Number(composed.getTransactionSize()) * PAYROLL_FEE_SATS_PER_ESTIMATED_BYTE));
  const changeAmount = totalInputSats - fixedOutputSats - estimatedFee;
  if (changeAmount < 0n) throw new Error("The available BCH UTXOs cannot cover all payroll payouts, CashToken dust, and the miner fee in one transaction");
  if (changeAmount >= 546n) changeOutput.amount = changeAmount;
  else composed.outputs = fixedOutputs;

  const signedHex = composed.build();
  const transaction = decodeTransactionCommon(hexToBin(signedHex));
  if (typeof transaction === "string") throw new Error(`Could not serialize the combined payroll transaction: ${transaction}`);
  const fundingByOutpoint = new Map(input.funding.map((item) => [outpointKey(item.txid, item.vout), item]));
  const inputsToSign: number[] = [];
  const sourceOutputs = transaction.inputs.map((txInput, index) => {
    const key = outpointKey(binToHex(txInput.outpointTransactionHash), txInput.outpointIndex);
    const walletInput = fundingByOutpoint.get(key);
    if (walletInput) {
      inputsToSign.push(index);
      txInput.unlockingBytecode = new Uint8Array();
      return { value: walletInput.value, locking_script_hex: walletInput.scriptHex };
    }
    const poolInput = poolSources.get(key);
    if (!poolInput) throw new Error(`Combined payroll transaction includes an unrecognized input ${key}`);
    return poolInput;
  });

  // Fail closed if CashScript/libauth serialization or the composed outputs do
  // not preserve every requested recipient payout and fungible token unit.
  for (const payout of input.payouts) {
    const recipient = cashAddressToLockingBytecode(payout.address);
    if (typeof recipient === "string") throw new Error("A payroll recipient address became invalid during transaction validation");
    const expectedCategory = payout.asset === "BCH" ? undefined : getCashTokenCategories("chipnet")[payout.asset];
    const paid = transaction.outputs
      .filter((output) => binToHex(output.lockingBytecode) === binToHex(recipient.bytecode)
        && (expectedCategory === undefined ? !output.token : output.token?.category && binToHex(output.token.category) === expectedCategory))
      .reduce((sum, output) => sum + (output.token ? output.token.amount : output.valueSatoshis), 0n);
    if (paid < BigInt(payout.amountAtomic)) throw new Error(`The composed transaction does not include the full ${payout.asset} payout for ${payout.address}`);
  }
  const inputTokenTotals = new Map<string, bigint>();
  for (const output of sourceOutputs as Array<{ token?: { category: string; amount: string } }>) {
    if (output.token) inputTokenTotals.set(output.token.category, (inputTokenTotals.get(output.token.category) || 0n) + BigInt(output.token.amount));
  }
  const outputTokenTotals = new Map<string, bigint>();
  for (const output of transaction.outputs) {
    if (output.token) {
      const category = binToHex(output.token.category);
      outputTokenTotals.set(category, (outputTokenTotals.get(category) || 0n) + output.token.amount);
    }
  }
  const tokenCategories = new Set([...inputTokenTotals.keys(), ...outputTokenTotals.keys()]);
  for (const category of tokenCategories) {
    if ((inputTokenTotals.get(category) || 0n) !== (outputTokenTotals.get(category) || 0n)) {
      throw new Error(`The composed payroll transaction does not conserve CashToken category ${category}`);
    }
  }

  const walletInputSats = inputsToSign.reduce((sum, index) => sum + BigInt((sourceOutputs[index] as { value: string }).value), 0n);
  const walletChangeSats = transaction.outputs.filter((output) => binToHex(output.lockingBytecode) === binToHex(change.bytecode)).reduce((sum, output) => sum + output.valueSatoshis, 0n);
  const bchSourceSpend = walletInputSats - walletChangeSats;
  if (bchSourceSpend < 0n) throw new Error("The composed payroll transaction returns more BCH to the wallet than it takes from its funding inputs");

  return {
    unsignedTxHex: binToHex(encodeTransactionCommon(transaction)),
    sourceOutputs,
    inputsToSign,
    expectedOutput: input.payouts.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n).toString(),
    feeSats: "0",
    feeTokenAmount: "0",
    minerFeeSats: (totalInputSats - fixedOutputSats - (changeAmount >= 546n ? changeAmount : 0n)).toString(),
    sourceSpendAtomic: bchSourceSpend.toString(),
    bchCostAtomic: "0",
    route: { source: "single Chipnet Cauldron payroll composition", tokenGroups: grouped.size, cauldronFees: fees.map(String) },
  };
}

/** One PUSD-funded transaction for direct PUSD payouts plus BCH recipients. */
export async function buildChipnetPusdPayrollBatch(input: {
  payouts: ChipnetPayrollPayout[];
  funding: Array<{ txid: string; vout: number; value: string; scriptHex: string; token?: { category: string; amount: string } }>;
  changeAddress: string;
}): Promise<BuiltSwap> {
  if (!input.payouts.length || input.payouts.length > 50) throw new Error("A PUSD payroll batch must contain one to fifty payouts");
  if (input.payouts.some((item) => item.asset === "MUSD")) throw new Error("A PUSD-to-MUSD payroll payout needs a second swap route; this one-transaction batch supports BCH and direct PUSD recipients.");
  const category = getCashTokenCategories("chipnet").PUSD;
  if (!category) throw new Error("PUSD has no configured Chipnet token category");
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof change === "string" || change.prefix !== "bchtest" || !change.tokenSupport) throw new Error("PUSD payroll requires a token-aware Chipnet change address");
  const bchRecipients = input.payouts.filter((item) => item.asset === "BCH");
  const pusdRecipients = input.payouts.filter((item) => item.asset === "PUSD");
  const targetSats = bchRecipients.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
  for (const payout of bchRecipients) {
    const address = cashAddressToLockingBytecode(payout.address);
    if (typeof address === "string" || address.prefix !== "bchtest" || BigInt(payout.amountAtomic) < 546n) throw new Error("Every BCH payroll payout needs a valid Chipnet address and must meet the BCH dust limit");
  }
  for (const payout of pusdRecipients) {
    const address = cashAddressToLockingBytecode(payout.address);
    if (typeof address === "string" || address.prefix !== "bchtest" || !address.tokenSupport) throw new Error("PUSD payroll requires token-aware Chipnet recipient addresses");
  }
  if (targetSats === 0n) throw new Error("This batch has no BCH payout; use the direct PUSD batch path");

  const { provider, pools } = await getCurrentPools(category);
  const poolQuote = quoteLiveSell(pools.map(({ pool }) => pool), category, "PUSD", targetSats);
  const directPusd = pusdRecipients.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n);
  const tokenFunding = input.funding.filter((item) => item.token?.category.toLowerCase() === category);
  const requiredTokenTotal = BigInt(poolQuote.inputAmount) + directPusd;
  const selectedTokenFunding: typeof tokenFunding = [];
  let selectedTokenAmount = 0n;
  for (const item of [...tokenFunding].sort((a, b) => {
    const diff = BigInt(b.token!.amount) - BigInt(a.token!.amount);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  })) {
    selectedTokenFunding.push(item);
    selectedTokenAmount += BigInt(item.token!.amount);
    if (selectedTokenAmount >= requiredTokenTotal) break;
  }
  if (selectedTokenAmount < requiredTokenTotal) throw new Error("The connected wallet does not have enough PUSD for the BCH conversion and direct PUSD payroll payouts");

  const usedKeys = new Set<string>();
  const selectedForSdk = [
    ...selectedTokenFunding,
    ...input.funding.filter((item) => !item.token),
  ].map((item) => ({
    txid: item.txid,
    vout: item.vout,
    satoshis: BigInt(item.value),
    lockingBytecode: hexToBin(item.scriptHex),
    ...(item.token ? { token: { category: item.token.category, amount: BigInt(item.token.amount) } } : {}),
  }));
  const placeholderKey = new Uint8Array(randomBytes(32));
  const built = await prepareSellTokens(pools.map(({ pool }) => pool), BigInt(poolQuote.inputAmount), input.changeAddress, placeholderKey, provider, selectedForSdk);
  if (built.totalSatsReceived < targetSats) throw new Error("The live PUSD pool output no longer covers every BCH payroll payout. Refresh the route and retry.");

  const builder = built.transactionBuilder as any;
  const inputByKey = new Map(input.funding.map((item) => [outpointKey(item.txid, item.vout), item]));
  const sdkWalletInputs = builder.inputs.filter((item: { txid: string; vout: number }) => inputByKey.has(outpointKey(item.txid, item.vout)));
  const walletUnlocker = sdkWalletInputs.find((item: { token?: { category: string } }) => item.token?.category?.toLowerCase() === category)?.unlocker
    || sdkWalletInputs[0]?.unlocker;
  if (!walletUnlocker) throw new Error("Cauldron did not select a wallet input for the PUSD payroll transaction");
  const allWalletInputs = new Map<string, any>();
  for (const item of sdkWalletInputs) allWalletInputs.set(outpointKey(item.txid, item.vout), item);
  for (const funding of selectedTokenFunding) {
    const key = outpointKey(funding.txid, funding.vout);
    if (!allWalletInputs.has(key)) {
      const sdkInput = selectedForSdk.find((item) => outpointKey(item.txid, item.vout) === key);
      if (!sdkInput) throw new Error(`Could not select PUSD funding input ${key}`);
      allWalletInputs.set(key, { ...sdkInput, unlocker: walletUnlocker });
    }
  }

  const livePoolByOutpoint = new Map(pools.map(({ pool, scriptHex }) => [outpointKey(pool.txid, pool.tx_pos), { pool, scriptHex }]));
  const poolInputs = builder.inputs.filter((item: { txid: string; vout: number }) => livePoolByOutpoint.has(outpointKey(item.txid, item.vout)));
  if (!poolInputs.length) throw new Error("The PUSD-to-BCH route did not select any current Cauldron pool inputs");
  builder.inputs = [...poolInputs, ...allWalletInputs.values()];

  const poolScripts = new Set(pools.map(({ scriptHex }) => scriptHex.toLowerCase()));
  const poolOutputs = builder.outputs.filter((output: { to: string | Uint8Array }) => {
    if (typeof output.to !== "string") return false;
    const decoded = cashAddressToLockingBytecode(output.to);
    return typeof decoded !== "string" && poolScripts.has(binToHex(decoded.bytecode).toLowerCase());
  });
  if (!poolOutputs.length) throw new Error("The PUSD-to-BCH builder did not preserve Cauldron's required pool outputs");
  const poolInputTokens = poolInputs.reduce((sum: bigint, item: { token?: { amount: bigint } }) => sum + BigInt(item.token?.amount || 0), 0n);
  const poolOutputTokens = poolOutputs.reduce((sum: bigint, item: { token?: { amount: bigint } }) => sum + BigInt(item.token?.amount || 0), 0n);
  const walletTokenInputs = [...allWalletInputs.values()].reduce((sum, item) => sum + (item.token?.category?.toLowerCase() === category ? BigInt(item.token.amount) : 0n), 0n);
  const tokenChange = BigInt(poolInputTokens) + BigInt(walletTokenInputs) - BigInt(poolOutputTokens) - BigInt(directPusd);
  if (tokenChange < 0n) throw new Error("The selected PUSD inputs cannot cover the swap and all direct PUSD payouts");

  const fixedOutputs = [
    ...poolOutputs,
    ...pusdRecipients.map((item) => ({ to: item.address, amount: 1_000n, token: { category, amount: BigInt(item.amountAtomic) } })),
    ...(tokenChange > 0n ? [{ to: input.changeAddress, amount: 1_000n, token: { category, amount: tokenChange } }] : []),
    ...bchRecipients.map((item) => ({ to: item.address, amount: BigInt(item.amountAtomic) })),
  ];
  const fixedSats = fixedOutputs.reduce((sum: bigint, item: { amount: bigint }) => sum + BigInt(item.amount), 0n);
  const bchChange = { to: input.changeAddress, amount: 546n };
  builder.outputs = [...fixedOutputs, bchChange];
  const walletBchCandidates = input.funding
    .filter((item) => !item.token)
    .sort((a, b) => BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0);
  const usedWalletKeys = new Set(allWalletInputs.keys());
  let inputSats: bigint = 0n;
  for (const item of [...poolInputs, ...allWalletInputs.values()]) inputSats += BigInt(item.satoshis);
  let estimatedFee = BigInt(Math.ceil(Number(builder.getTransactionSize()) * PAYROLL_FEE_SATS_PER_ESTIMATED_BYTE));
  let changeAmount = inputSats - fixedSats - estimatedFee;
  for (const funding of walletBchCandidates) {
    if (changeAmount >= 0n) break;
    const key = outpointKey(funding.txid, funding.vout);
    if (usedWalletKeys.has(key)) continue;
    const sdkInput = selectedForSdk.find((item) => outpointKey(item.txid, item.vout) === key);
    if (!sdkInput) continue;
    allWalletInputs.set(key, { ...sdkInput, unlocker: walletUnlocker });
    usedWalletKeys.add(key);
    builder.inputs = [...poolInputs, ...allWalletInputs.values()];
    inputSats += BigInt(funding.value);
    estimatedFee = BigInt(Math.ceil(Number(builder.getTransactionSize()) * PAYROLL_FEE_SATS_PER_ESTIMATED_BYTE));
    changeAmount = inputSats - fixedSats - estimatedFee;
  }
  if (changeAmount < 0n) throw new Error(`Selected PUSD swap and wallet inputs are short by ${-changeAmount} Chipnet satoshis for this payroll transaction`);
  if (changeAmount >= 546n) bchChange.amount = changeAmount;
  else builder.outputs = fixedOutputs;

  const signedHex = builder.build();
  const transaction = decodeTransactionCommon(hexToBin(signedHex));
  if (typeof transaction === "string") throw new Error(`Could not serialize the PUSD payroll transaction: ${transaction}`);
  const walletFunding = new Map(input.funding.map((item) => [outpointKey(item.txid, item.vout), item]));
  const sourceOutputs = transaction.inputs.map((txInput) => {
    const key = outpointKey(binToHex(txInput.outpointTransactionHash), txInput.outpointIndex);
    const walletInput = walletFunding.get(key);
    if (walletInput) return { value: walletInput.value, locking_script_hex: walletInput.scriptHex, ...(walletInput.token ? { token: walletInput.token } : {}) };
    const pool = livePoolByOutpoint.get(key);
    if (!pool) throw new Error(`The PUSD payroll transaction has an unrecognized input ${key}`);
    return { value: pool.pool.sats.toString(), locking_script_hex: pool.scriptHex, token: { category, amount: pool.pool.tokens.toString() } };
  });
  const inputsToSign = transaction.inputs.flatMap((txInput, index) => walletFunding.has(outpointKey(binToHex(txInput.outpointTransactionHash), txInput.outpointIndex)) ? [index] : []);

  for (const payout of input.payouts) {
    const recipient = cashAddressToLockingBytecode(payout.address);
    if (typeof recipient === "string") throw new Error("A payroll recipient address became invalid during transaction validation");
    const paid = transaction.outputs.filter((output) => binToHex(output.lockingBytecode) === binToHex(recipient.bytecode)
      && (payout.asset === "BCH" ? !output.token : output.token && binToHex(output.token.category) === category))
      .reduce((sum, output) => sum + (output.token ? output.token.amount : output.valueSatoshis), 0n);
    if (paid < BigInt(payout.amountAtomic)) throw new Error(`The composed transaction is missing the ${payout.asset} payout for ${payout.address}`);
  }
  const tokenInTotal = (sourceOutputs as Array<{ token?: { category: string; amount: string } }>).reduce((sum, item) => sum + (item.token?.category.toLowerCase() === category ? BigInt(item.token.amount) : 0n), 0n);
  const tokenOutTotal = transaction.outputs.reduce((sum, item) => sum + (item.token && binToHex(item.token.category).toLowerCase() === category ? item.token.amount : 0n), 0n);
  if (tokenInTotal !== tokenOutTotal) throw new Error("The composed PUSD payroll transaction does not conserve the PUSD token balance");
  const pusdSourceSpend = walletTokenInputs - tokenChange;
  if (pusdSourceSpend < 0n) throw new Error("The composed payroll transaction returns more PUSD to the wallet than it spends");
  const walletBchInputSats = inputsToSign.reduce((sum, index) => sum + BigInt((sourceOutputs[index] as { value: string }).value), 0n);
  const walletBchChangeSats = transaction.outputs.filter((output) => binToHex(output.lockingBytecode) === binToHex(change.bytecode)).reduce((sum, output) => sum + output.valueSatoshis, 0n);
  // Cauldron's PUSD sale proceeds can be returned to the same wallet change
  // address. That makes the total change output larger than the wallet's BCH
  // inputs when the pool funds some of the BCH payroll outputs; it is valid.
  const bchCost = walletBchInputSats > walletBchChangeSats ? walletBchInputSats - walletBchChangeSats : 0n;
  const totalBchInputSats = (sourceOutputs as Array<{ value: string }>).reduce((sum, output) => sum + BigInt(output.value), 0n);
  const totalBchOutputSats = transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  const actualMinerFeeSats = totalBchInputSats - totalBchOutputSats;
  if (actualMinerFeeSats < 0n) throw new Error("The composed PUSD payroll transaction outputs more BCH than all wallet and pool inputs provide");

  return {
    unsignedTxHex: binToHex(encodeTransactionCommon(transaction)), sourceOutputs, inputsToSign,
    expectedOutput: input.payouts.reduce((sum, item) => sum + BigInt(item.amountAtomic), 0n).toString(),
    feeSats: "0", feeTokenAmount: "0",
    minerFeeSats: actualMinerFeeSats.toString(),
    sourceSpendAtomic: pusdSourceSpend.toString(), bchCostAtomic: bchCost.toString(),
    route: { source: "single Chipnet PUSD-to-BCH payroll composition", poolCount: poolInputs.length, pusdInputAmount: poolQuote.inputAmount },
  };
}

export async function getChipnetCauldronBuyQuote(input: { buy: CauldronAsset; amountAtomic: string }) {
  const tokenId = getCashTokenCategories("chipnet")[input.buy as "PUSD" | "MUSD"];
  if (!tokenId) throw new Error(`${input.buy} has no configured Chipnet token category`);
  const { pools } = await getCurrentPools(tokenId);
  const allocations = computeOptimalBuy(pools.map(({ pool }) => pool), BigInt(input.amountAtomic), 2n);
  return {
    provider: "Cauldron live Chipnet pools" as const,
    sell: "BCH" as const,
    buy: input.buy,
    inputAmount: allocations.reduce((sum, allocation) => sum + allocation.supplyAmount, 0n).toString(),
    outputAmount: input.amountAtomic,
    pools: allocations.length,
  };
}

function sellOutput(pools: CauldronActivePool[], tokenAmount: bigint) {
  const allocations = computeOptimalSell(pools, tokenAmount, 2n);
  return {
    allocations,
    amount: allocations.reduce((sum, allocation) => sum + allocation.supplyAmount, 0n),
  };
}

function quoteLiveSell(pools: CauldronActivePool[], tokenId: string, sell: CauldronAsset, targetSats: bigint) {
  if (targetSats <= 0n) throw new Error("Requested BCH output must be greater than zero");
  let high = 1n;
  let result = sellOutput(pools, high);
  while (result.amount < targetSats && high < 10n ** 18n) {
    high *= 2n;
    result = sellOutput(pools, high);
  }
  if (result.amount < targetSats) throw new Error("Current Chipnet pools cannot cover the requested BCH output");
  let low = high / 2n;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    const candidate = sellOutput(pools, middle);
    if (candidate.amount >= targetSats) {
      high = middle;
      result = candidate;
    } else low = middle;
  }
  result = sellOutput(pools, high);
  return { provider: "Cauldron live Chipnet pools" as const, sell, buy: "BCH" as const, inputAmount: high.toString(), outputAmount: targetSats.toString(), pools: result.allocations.length, tokenId };
}

/** Quote Chipnet token sells against current pool outputs instead of the lagging router snapshot. */
export async function getChipnetCauldronSellQuote(input: { sell: CauldronAsset; amountAtomic: string; side?: "sell" | "buy" }) {
  if (input.sell === "BCH") throw new Error("A Chipnet BCH sell quote requires a CashToken input");
  const tokenId = getCashTokenCategories("chipnet")[input.sell as "PUSD" | "MUSD"];
  if (!tokenId) throw new Error(`${input.sell} has no configured Chipnet token category`);
  const { pools } = await getCurrentPools(tokenId);
  const livePools = pools.map(({ pool }) => pool);
  if ((input.side || "sell") === "sell") {
    const tokenAmount = BigInt(input.amountAtomic);
    const outputAmount = sellOutput(livePools, tokenAmount);
    return { provider: "Cauldron live Chipnet pools" as const, sell: input.sell, buy: "BCH" as const, inputAmount: tokenAmount.toString(), outputAmount: outputAmount.amount.toString(), pools: outputAmount.allocations.length };
  }

  return quoteLiveSell(livePools, tokenId, input.sell, BigInt(input.amountAtomic));
}

/**
 * Build exact-output Chipnet BCH -> CashToken swaps from live Electrum pool
 * outputs. The public Chipnet Cauldron indexer can lag behind the active chain;
 * use it only to discover pool owners, then replace every indexed pool outpoint
 * with the current unspent output reported by the connected Chipnet peer.
 */
export async function buildChipnetCauldronBuy(input: ChipnetBuyInput): Promise<BuiltSwap> {
  if (input.network !== "chipnet" || input.sell !== "BCH" || input.buy === "BCH" || (input.side || "sell") !== "buy") {
    throw new Error("Live Chipnet pool building supports exact-output BCH-to-CashToken swaps only");
  }

  const tokenId = getCashTokenCategories("chipnet")[input.buy as "PUSD" | "MUSD"];
  if (!tokenId) throw new Error(`${input.buy} has no configured Chipnet token category`);

  const { provider, pools } = await getCurrentPools(tokenId);

  const fundingUtxos = input.funding.map((funding) => ({
    txid: funding.txid,
    vout: funding.vout,
    satoshis: BigInt(funding.value),
    lockingBytecode: hexToBin(funding.scriptHex),
    ...(funding.token ? { token: { category: funding.token.category, amount: BigInt(funding.token.amount) } } : {}),
  }));
  const receive = cashAddressToLockingBytecode(input.receiveAddress);
  const change = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof receive === "string" || !receive.tokenSupport) throw new Error("The recipient must use a token-aware Chipnet address to receive CashTokens");
  if (typeof change === "string") throw new Error(`Invalid Chipnet change address: ${change}`);

  const placeholderKey = new Uint8Array(randomBytes(32));
  const result = await prepareBuyTokens(
    pools.map(({ pool }) => pool),
    BigInt(toAtomicAmount(input.amount, input.buy)),
    input.receiveAddress,
    placeholderKey,
    provider,
    fundingUtxos,
  );

  // The SDK uses the token recipient as its BCH change destination too. Route
  // that last BCH output back to the payer's selected change address.
  const changeOutput = result.transactionBuilder.outputs.at(-1);
  if (!changeOutput || changeOutput.token) throw new Error("Cauldron did not produce the expected BCH change output");
  changeOutput.to = input.changeAddress;

  // build() fills a temporary signature for wallet inputs so CashScript can
  // estimate their size. Strip those signatures before handing the transaction
  // to WizardConnect; only pool covenant unlocks remain populated.
  const signedHex = result.transactionBuilder.build();
  const transaction = decodeTransactionCommon(hexToBin(signedHex));
  if (typeof transaction === "string") throw new Error(`Could not serialize the Chipnet Cauldron build: ${transaction}`);

  const fundingByOutpoint = new Map(input.funding.map((item) => [outpointKey(item.txid, item.vout), item]));
  const livePoolByOutpoint = new Map(pools.map(({ pool, scriptHex }) => [outpointKey(pool.txid, pool.tx_pos), { pool, scriptHex }]));
  const inputsToSign: number[] = [];
  const sourceOutputs = transaction.inputs.map((txInput, index) => {
    const txid = binToHex(txInput.outpointTransactionHash);
    const key = outpointKey(txid, txInput.outpointIndex);
    const walletInput = fundingByOutpoint.get(key);
    if (walletInput) {
      inputsToSign.push(index);
      txInput.unlockingBytecode = new Uint8Array();
      return {
        value: walletInput.value,
        locking_script_hex: walletInput.scriptHex,
        ...(walletInput.token ? { token: walletInput.token } : {}),
      };
    }
    const pool = livePoolByOutpoint.get(key);
    if (!pool) throw new Error(`Cauldron transaction included an unrecognized input ${key}`);
    return {
      value: pool.pool.sats.toString(),
      locking_script_hex: pool.scriptHex,
      token: { category: tokenId, amount: pool.pool.tokens.toString() },
    };
  });

  const unsignedTxHex = binToHex(encodeTransactionCommon(transaction));
  return {
    unsignedTxHex,
    sourceOutputs,
    inputsToSign,
    expectedOutput: toAtomicAmount(input.amount, input.buy),
    feeSats: result.totalFees.toString(),
    feeTokenAmount: "0",
    minerFeeSats: result.transactionBuilder.calculateTransactionFee().feeSats.toString(),
    route: { source: "current Chipnet Electrum pool outputs", pools: pools.length },
  };
}

/** Build Chipnet CashToken -> BCH exact-output payments from current pool UTXOs. */
export async function buildChipnetCauldronSell(input: ChipnetBuyInput & { tokenChangeAddress?: string; expectedSellAmountAtomic?: string }): Promise<BuiltSwap> {
  if (input.network !== "chipnet" || input.sell === "BCH" || input.buy !== "BCH" || (input.side || "sell") !== "buy") {
    throw new Error("Live Chipnet pool building supports exact-output CashToken-to-BCH swaps only");
  }
  const tokenId = getCashTokenCategories("chipnet")[input.sell as "PUSD" | "MUSD"];
  if (!tokenId) throw new Error(`${input.sell} has no configured Chipnet token category`);
  const targetSats = BigInt(toAtomicAmount(input.amount, "BCH"));
  const { provider, pools } = await getCurrentPools(tokenId);
  const liveQuote = quoteLiveSell(pools.map(({ pool }) => pool), tokenId, input.sell, targetSats);
  if (input.expectedSellAmountAtomic && BigInt(input.expectedSellAmountAtomic) !== BigInt(liveQuote.inputAmount)) {
    throw new Error("The live Chipnet pool price changed after this quote. Refresh the invoice quote and try again.");
  }
  const tokenChangeAddress = input.tokenChangeAddress || input.changeAddress;
  const tokenChange = cashAddressToLockingBytecode(tokenChangeAddress);
  const recipient = cashAddressToLockingBytecode(input.receiveAddress);
  const payerChange = cashAddressToLockingBytecode(input.changeAddress);
  if (typeof tokenChange === "string" || !tokenChange.tokenSupport) throw new Error("A token-aware payer change address is required to preserve unused CashTokens");
  if (typeof recipient === "string" || recipient.prefix !== "bchtest") throw new Error("The BCH invoice must use a Chipnet receiving address");
  if (typeof payerChange === "string" || payerChange.prefix !== "bchtest") throw new Error("The wallet change address must be on Chipnet");

  const fundingUtxos = input.funding.map((funding) => ({
    txid: funding.txid,
    vout: funding.vout,
    satoshis: BigInt(funding.value),
    lockingBytecode: hexToBin(funding.scriptHex),
    ...(funding.token ? { token: { category: funding.token.category, amount: BigInt(funding.token.amount) } } : {}),
  }));
  const placeholderKey = new Uint8Array(randomBytes(32));
  const result = await prepareSellTokens(
    pools.map(({ pool }) => pool),
    BigInt(liveQuote.inputAmount),
    tokenChangeAddress,
    placeholderKey,
    provider,
    fundingUtxos,
  );
  if (result.totalSatsReceived < targetSats) throw new Error("Live Chipnet pool liquidity changed while preparing this payment. Refresh the quote and try again.");

  // The SDK builds a trader change output containing the BCH sale proceeds.
  // Split it so the invoice receives exactly its BCH amount and all excess
  // wallet BCH returns to the payer's change address.
  const builder = result.transactionBuilder;
  const outputs = builder.outputs as Array<{ to: string; amount: bigint; token?: unknown }>;
  const sdkBchChange = outputs.at(-1);
  if (sdkBchChange && !sdkBchChange.token && sdkBchChange.to === tokenChangeAddress) {
    sdkBchChange.to = input.receiveAddress;
    sdkBchChange.amount = targetSats;
  } else {
    outputs.push({ to: input.receiveAddress, amount: targetSats });
  }
  const placeholderChange = { to: input.changeAddress, amount: 1_000n };
  outputs.push(placeholderChange);
  const requiredFee = BigInt(Math.ceil(1.2 * Number(builder.getTransactionSize())));
  const totalInputs = builder.inputs.reduce((sum, item) => sum + item.satoshis, 0n);
  const fixedOutputs = outputs.slice(0, -1).reduce((sum, item) => sum + item.amount, 0n);
  const changeAmount = totalInputs - fixedOutputs - requiredFee;
  if (changeAmount < 0n) throw new Error("The live Chipnet pool output no longer covers the invoice amount and miner fee. Refresh the invoice quote and try again.");
  if (changeAmount >= 546n) placeholderChange.amount = changeAmount;
  else outputs.pop();

  const transaction = decodeTransactionCommon(hexToBin(builder.build()));
  if (typeof transaction === "string") throw new Error(`Could not serialize the live Chipnet Cauldron build: ${transaction}`);
  const fundingByOutpoint = new Map(input.funding.map((item) => [outpointKey(item.txid, item.vout), item]));
  const livePoolByOutpoint = new Map(pools.map(({ pool, scriptHex }) => [outpointKey(pool.txid, pool.tx_pos), { pool, scriptHex }]));
  const inputsToSign: number[] = [];
  const sourceOutputs = transaction.inputs.map((txInput, index) => {
    const key = outpointKey(binToHex(txInput.outpointTransactionHash), txInput.outpointIndex);
    const walletInput = fundingByOutpoint.get(key);
    if (walletInput) {
      inputsToSign.push(index);
      txInput.unlockingBytecode = new Uint8Array();
      return { value: walletInput.value, locking_script_hex: walletInput.scriptHex, ...(walletInput.token ? { token: walletInput.token } : {}) };
    }
    const pool = livePoolByOutpoint.get(key);
    if (!pool) throw new Error(`Cauldron transaction included an unrecognized live pool input ${key}`);
    return { value: pool.pool.sats.toString(), locking_script_hex: pool.scriptHex, token: { category: tokenId, amount: pool.pool.tokens.toString() } };
  });
  const unsignedTxHex = binToHex(encodeTransactionCommon(transaction));
  return {
    unsignedTxHex,
    sourceOutputs,
    inputsToSign,
    expectedOutput: targetSats.toString(),
    feeSats: result.totalFees.toString(),
    feeTokenAmount: "0",
    minerFeeSats: builder.calculateTransactionFee().feeSats.toString(),
    route: { source: "current Chipnet Electrum pool outputs", pools: liveQuote.pools },
  };
}

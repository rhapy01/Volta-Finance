import { createPublicClient, createWalletClient, decodeEventLog, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_RECEIVE_NETWORKS, getEvmAssetDecimals, getEvmNetwork, getEvmTokenAddress, isEvmMainnet, type EvmReceiveAsset, type EvmReceiveNetwork } from "./evmNetworks";

const erc20TransferAbi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function isValidEvmAddress(value: string) {
  return isAddress(value, { strict: false });
}

export function getEvmPublicClient(network: EvmReceiveNetwork) {
  return createPublicClient({ chain: getEvmNetwork(network), transport: http() });
}

function getSigner(network: EvmReceiveNetwork) {
  const privateKey = (isEvmMainnet(network) ? process.env.EVM_MAINNET_SIGNER_PRIVATE_KEY : process.env.EVM_TESTNET_SIGNER_PRIVATE_KEY)?.trim();
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`Configure the EVM ${isEvmMainnet(network) ? "Mainnet" : "Testnet"} treasury key before sending ${network} payouts.`);
  }
  return privateKeyToAccount(privateKey as Hex);
}

function assertRoute(network: EvmReceiveNetwork, asset: EvmReceiveAsset) {
  if (!EVM_RECEIVE_NETWORKS.includes(network)) throw new Error("Unsupported EVM network.");
  if (network !== "base-sepolia" && asset !== "USDC") throw new Error(`${network} payouts support USDC only.`);
  const tokenAddress = getEvmTokenAddress(network, asset);
  if (asset === "USDC" && network === "base-sepolia" && !tokenAddress) {
    throw new Error("Configure the Base Sepolia USDC token address before using Base USDC payouts.");
  }
  return tokenAddress;
}

export async function sendEvmTestnetPayout(input: { network: EvmReceiveNetwork; asset: EvmReceiveAsset; destination: string; amountAtomic: string }) {
  if (!isValidEvmAddress(input.destination)) throw new Error("The EVM payout address is invalid.");
  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n) throw new Error("The EVM payout amount must be a positive integer in atomic units.");
  const tokenAddress = assertRoute(input.network, input.asset);
  const account = getSigner(input.network);
  const chain = getEvmNetwork(input.network);
  const walletClient = createWalletClient({ account, chain, transport: http() });
  const publicClient = getEvmPublicClient(input.network);
  const destination = input.destination as Address;
  const amount = BigInt(input.amountAtomic);
  if (tokenAddress) {
    const tokenBalance = await publicClient.readContract({ address: tokenAddress, abi: erc20TransferAbi, functionName: "balanceOf", args: [account.address] });
    if (tokenBalance < amount) throw new Error(`The ${input.network} treasury needs more USDC to cover this payout.`);
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    if (nativeBalance === 0n) throw new Error(input.network === "arc-mainnet" ? "The Arc treasury needs USDC for both the payout and network fee." : `The ${input.network} treasury needs native gas funds before it can send USDC.`);
  } else {
    const nativeBalance = await publicClient.getBalance({ address: account.address });
    if (nativeBalance < amount) throw new Error(`The ${input.network} treasury does not have enough ${input.asset} for this payout and its network fee.`);
  }
  const txid = tokenAddress
    ? await walletClient.writeContract({ account, chain, address: tokenAddress, abi: erc20TransferAbi, functionName: "transfer", args: [destination, amount] })
    : await walletClient.sendTransaction({ account, chain, to: destination, value: amount });
  return { txid, network: input.network, asset: input.asset, destination: input.destination, amountAtomic: input.amountAtomic };
}

export async function getEvmTestnetTransactionStatus(input: { network: EvmReceiveNetwork; txid: string }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txid)) throw new Error("Invalid EVM transaction ID.");
  const client = getEvmPublicClient(input.network);
  try {
    const receipt = await client.getTransactionReceipt({ hash: input.txid as Hex });
    const head = await client.getBlockNumber();
    const confirmations = head >= receipt.blockNumber ? Number(head - receipt.blockNumber + 1n) : 0;
    return { found: true as const, successful: receipt.status === "success", confirmations, blockNumber: receipt.blockNumber.toString() };
  } catch {
    return { found: false as const, successful: false as const, confirmations: 0, blockNumber: null };
  }
}

export async function verifyEvmTestnetPayout(input: { network: EvmReceiveNetwork; asset: EvmReceiveAsset; txid: string; destination: string; amountAtomic: string }) {
  const tokenAddress = assertRoute(input.network, input.asset);
  const status = await getEvmTestnetTransactionStatus({ network: input.network, txid: input.txid });
  if (!status.found || !status.successful) return { ...status, verified: false };
  const client = getEvmPublicClient(input.network);
  if (!tokenAddress) {
    const tx = await client.getTransaction({ hash: input.txid as Hex });
    return { ...status, verified: tx.to?.toLowerCase() === input.destination.toLowerCase() && tx.value === BigInt(input.amountAtomic) };
  }
  const expectedAmount = BigInt(input.amountAtomic);
  const receipt = await client.getTransactionReceipt({ hash: input.txid as Hex });
  const matchingLogs = receipt.logs.filter((log) => log.address.toLowerCase() === tokenAddress.toLowerCase());
  const verified = matchingLogs.some((log) => {
    try {
      const event = decodeEventLog({ abi: erc20TransferAbi, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && (event.args.to as string).toLowerCase() === input.destination.toLowerCase() && event.args.value === expectedAmount;
    } catch { return false; }
  });
  return { ...status, verified };
}

export async function getEvmTestnetBalance(input: { network: EvmReceiveNetwork; asset: EvmReceiveAsset; address: string }) {
  if (!isValidEvmAddress(input.address)) throw new Error("The EVM address is invalid.");
  const tokenAddress = assertRoute(input.network, input.asset);
  const client = getEvmPublicClient(input.network);
  const balance = tokenAddress
    ? await client.readContract({ address: tokenAddress, abi: erc20TransferAbi, functionName: "balanceOf", args: [input.address as Address] })
    : await client.getBalance({ address: input.address as Address });
  return { balanceAtomic: balance.toString(), decimals: getEvmAssetDecimals(input.network, input.asset) };
}

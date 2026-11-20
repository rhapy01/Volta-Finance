import { defineChain, type Address } from "viem";
import type { PayrollAsset } from "../../drizzle/schema";

export const EVM_RECEIVE_NETWORKS = ["base-sepolia", "arc-testnet", "base-mainnet", "arc-mainnet"] as const;
export type EvmReceiveNetwork = (typeof EVM_RECEIVE_NETWORKS)[number];
export type EvmReceiveAsset = "USDC" | "ETH";
export type EvmPayrollRoute = "BSUSDC" | "BSETH" | "ARUSDC" | "BMUSDC" | "AMUSDC";
export const EVM_PAYROLL_ROUTES: Record<EvmPayrollRoute, { network: EvmReceiveNetwork; asset: EvmReceiveAsset }> = {
  BSUSDC: { network: "base-sepolia", asset: "USDC" },
  BSETH: { network: "base-sepolia", asset: "ETH" },
  ARUSDC: { network: "arc-testnet", asset: "USDC" },
  BMUSDC: { network: "base-mainnet", asset: "USDC" },
  AMUSDC: { network: "arc-mainnet", asset: "USDC" },
};

export const isEvmMainnet = (network: EvmReceiveNetwork) => network === "base-mainnet" || network === "arc-mainnet";
export function evmPayrollRouteFor(network: EvmReceiveNetwork, asset: EvmReceiveAsset): EvmPayrollRoute {
  if (network === "base-sepolia") return asset === "ETH" ? "BSETH" : "BSUSDC";
  if (network === "arc-testnet") {
    if (asset !== "USDC") throw new Error("Arc supports USDC payouts only.");
    return "ARUSDC";
  }
  if (asset !== "USDC") throw new Error("Mainnet payroll supports USDC payouts only.");
  return network === "base-mainnet" ? "BMUSDC" : "AMUSDC";
}
export function parseEvmPayrollRoute(route: string) {
  return route in EVM_PAYROLL_ROUTES ? EVM_PAYROLL_ROUTES[route as EvmPayrollRoute] : undefined;
}

/** Reuse the same personal 0x destination when a profile switches network modes. */
export function evmPayrollRouteForMode(route: string, networkMode: "mainnet" | "chipnet"): PayrollAsset {
  if (networkMode === "mainnet") return (route === "ARUSDC" ? "AMUSDC" : route) as PayrollAsset;
  return (route === "AMUSDC" ? "ARUSDC" : route) as PayrollAsset;
}

export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
export const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000" as Address;
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
// Arc USDC uses Circle's native USDC contract address on both Arc networks.
export const ARC_MAINNET_USDC = "0x3600000000000000000000000000000000000000" as Address;

export function getEvmNetwork(network: EvmReceiveNetwork) {
  if (network === "base-sepolia") return defineChain({ id: 84532, name: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"] } }, blockExplorers: { default: { name: "Base Sepolia Explorer", url: "https://sepolia.basescan.org" } }, testnet: true });
  if (network === "arc-testnet") return defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network"] } }, blockExplorers: { default: { name: "Arc Testnet Explorer", url: "https://explorer.testnet.arc.io" } }, testnet: true });
  if (network === "base-mainnet") return defineChain({ id: 8453, name: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org"] } }, blockExplorers: { default: { name: "BaseScan", url: "https://basescan.org" } } });
  return defineChain({ id: 5042, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io"] } }, blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } } });
}

export function getEvmTokenAddress(network: EvmReceiveNetwork, asset: EvmReceiveAsset): Address | undefined {
  if (asset === "ETH") {
    if (network === "base-sepolia") return undefined;
    return undefined;
  }
  if (network === "base-sepolia") {
    const address = process.env.BASE_SEPOLIA_USDC_ADDRESS?.trim() || BASE_SEPOLIA_USDC;
    return /^0x[0-9a-fA-F]{40}$/.test(address) ? address as Address : undefined;
  }
  if (network === "arc-testnet") return ARC_TESTNET_USDC;
  if (network === "base-mainnet") return BASE_MAINNET_USDC;
  return ARC_MAINNET_USDC;
}

export function getEvmAssetDecimals(_network: EvmReceiveNetwork, _asset: EvmReceiveAsset) { return _asset === "USDC" ? 6 : 18; }

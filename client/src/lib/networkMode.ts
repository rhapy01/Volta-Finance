export type NetworkMode = "mainnet" | "testnet";
export const NETWORK_MODE_KEY = "voltra-network-mode-v2";

export function readNetworkMode(): NetworkMode {
  if (typeof window === "undefined") return "mainnet";
  try { return window.localStorage.getItem(NETWORK_MODE_KEY) === "testnet" ? "testnet" : "mainnet"; }
  catch { return "mainnet"; }
}

export function writeNetworkMode(mode: NetworkMode) {
  try { window.localStorage.setItem(NETWORK_MODE_KEY, mode); } catch { /* Keep the selected mode for this session. */ }
}

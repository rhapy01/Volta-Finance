const labels: Record<string, string> = {
  XLM: "XLM · Stellar Testnet",
  USDC: "USDC · Stellar Testnet",
  BSUSDC: "USDC · Base Sepolia",
  BSETH: "ETH · Base Sepolia",
  ARUSDC: "USDC · Arc Testnet",
  BMUSDC: "USDC · Base Mainnet",
  AMUSDC: "USDC · Arc Mainnet",
};

const mainnetLabels: Record<string, string> = {
  BCH: "BCH · Bitcoin Cash Mainnet",
  PUSD: "PUSD · BCH Mainnet",
  MUSD: "MUSD · BCH Mainnet",
};

const symbols: Record<string, string> = {
  BSUSDC: "USDC",
  ARUSDC: "USDC",
  BMUSDC: "USDC",
  AMUSDC: "USDC",
};

export function payrollAssetLabel(asset: string | null | undefined, networkMode: "mainnet" | "testnet" = "testnet") {
  if (!asset) return "Choose payout";
  if (networkMode === "mainnet" && mainnetLabels[asset]) return mainnetLabels[asset];
  if (networkMode === "testnet" && ["BCH", "PUSD", "MUSD"].includes(asset)) return `${asset} · Chipnet`;
  return labels[asset] ?? asset;
}

export function payrollAssetSymbol(asset: string) {
  return symbols[asset] ?? asset;
}

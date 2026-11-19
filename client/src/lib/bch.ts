import { encodeCashAddress, hash160 } from "@bitauth/libauth";

export type WalletPath = "receive" | "change" | "defi";
const PATH_INDEX: Record<WalletPath, number> = { receive: 0, change: 1, defi: 7 };

/** Derive a standard BCH P2PKH CashAddress from a WizardConnect compressed pubkey. */
export function deriveBchAddress(pubkey: Uint8Array, network: "mainnet" | "chipnet" = "mainnet", tokenSupport = false) {
  if (pubkey.length !== 33) throw new Error("WizardConnect returned an invalid compressed public key");
  return encodeCashAddress({
    prefix: network === "mainnet" ? "bitcoincash" : "bchtest",
    type: tokenSupport ? "p2pkhWithTokens" : "p2pkh",
    payload: hash160(pubkey),
  }).address;
}

export function deriveWalletAddress(manager: { getPubkey: (childIndex: number, index: bigint) => Uint8Array | undefined }, path: WalletPath, index = 0n, network: "mainnet" | "chipnet" = "mainnet", tokenSupport = false) {
  const pubkey = manager.getPubkey(PATH_INDEX[path], index);
  if (!pubkey) return null;
  return deriveBchAddress(pubkey, network, tokenSupport);
}

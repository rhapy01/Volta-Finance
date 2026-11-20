import { useEffect, useState } from "react";
import { toast } from "sonner";
import { WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWizardConnect, WizardConnectQRDialog } from "@wizardconnect/react";

export type WalletSession = ReturnType<typeof useWizardConnect>;

export function useVoltaWallet() {
  return useWizardConnect({ dappName: "Voltra Finance", sessionKey: "trezu-wizardconnect", persistSession: true, enableVisibilityHandling: false });
}

export function WalletConnection({ wallet, request = 0 }: { wallet: WalletSession; request?: number }) {
  const [open, setOpen] = useState(false);
  const connected = wallet.state === "connected";
  const connect = () => {
    if (connected) { setOpen(true); return; }
    if (!wallet.connect()) { toast.info("Wallet connection is already in progress."); return; }
    setOpen(true);
  };
  const cancelConnection = async () => {
    await wallet.disconnect();
    setOpen(false);
    toast.info("Wallet connection cancelled. You can start a new connection now.");
  };
  useEffect(() => {
    if (!request) return;
    setOpen(true);
    if (!connected) wallet.connect();
  }, [request]);
  return <>
    <div className="flex items-center gap-2">
      <Button variant="outline" aria-label={connected ? `${wallet.walletName || "Wallet"} connected` : wallet.state === "connecting" || wallet.state === "reconnecting" ? "Pairing wallet" : "Connect wallet"} onClick={connect} className="wallet-connect-button gap-2 rounded-xl border-slate-200 bg-white text-slate-700"><WalletCards size={16} /><span className="wallet-connect-label">{connected ? wallet.walletName || "Wallet connected" : wallet.state === "connecting" || wallet.state === "reconnecting" ? "Pairing wallet…" : "Connect wallet"}</span></Button>
      {(wallet.state === "connecting" || wallet.state === "reconnecting") && <Button type="button" variant="ghost" aria-label="Cancel wallet pairing" onClick={() => void cancelConnection()} className="wallet-cancel-button text-sm text-slate-600"><X size={14} /><span className="wallet-cancel-label">Cancel</span></Button>}
    </div>
    <WizardConnectQRDialog show={open && !connected} onClose={() => setOpen(false)} uri={wallet.uri || ""} qrUri={wallet.qrUri || ""} title="Connect BCH wallet" subtitle="Scan with Paytaca, Selene, Cashonize, or another WizardConnect compatible wallet." theme={{ dialogBackground: "#ffffff", headerBackground: "#ffffff", titleColor: "#162234", subtitleColor: "#667085", qrForeground: "#162234", uriRowBackground: "#f1f5f9", uriTextColor: "#162b3a", borderColor: "#cbd5e1", copyButtonColor: "#475569" }} />
    {connected && open && <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-bold">{wallet.walletName || "BCH wallet"} connected</h2><p className="mt-2 text-sm text-slate-600">Your wallet is available for signing. Trezu only receives public address and transaction data.</p>{wallet.error && <p className="mt-3 text-sm text-red-700">{wallet.error}</p>}<div className="mt-5 flex justify-between"><Button variant="outline" onClick={async () => { await wallet.disconnect(); setOpen(false); }}>Disconnect</Button><Button onClick={() => setOpen(false)}>Done</Button></div></section></div>}
  </>;
}

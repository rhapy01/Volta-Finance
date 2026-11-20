import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeftRight, CheckCircle2, LoaderCircle, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deriveWalletAddress } from "@/lib/bch";
import { buildDirectBchBatchPayment, buildDirectCashTokenBatchPayment, cauldronInputPaths, normalizeCauldronSourceOutputs, signWithWizardConnect } from "@/lib/wallet";
import { useVoltaWallet, WalletConnection, type WalletSession } from "@/features/wallet/WalletConnection";
import { trpc } from "@/lib/trpc";
import { readNetworkMode, type NetworkMode } from "@/lib/networkMode";

type Asset = "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC_STELLAR" | "USDC_BASE" | "USDC_ARC" | "USDC_BASE_MAINNET" | "USDC_ARC_MAINNET";
type SourceAsset = Extract<Asset, "BCH" | "PUSD" | "MUSD">;
type Network = "mainnet" | "chipnet" | "stellar-testnet" | "base-sepolia" | "arc-testnet" | "base-mainnet" | "arc-mainnet";
type DirectQuoteResult = {
  route?: "direct";
  network: "mainnet" | "chipnet";
  recipientAddress: string;
  quote: { sell: SourceAsset; buy: Asset; inputAmount: string; outputAmount: string; legs: Array<{ sell: SourceAsset; buy: Asset; inputAmount: string; outputAmount: string }> };
};
type CrosschainQuoteResult = { route: "crosschain"; network: "mainnet" | "chipnet"; sourceNetwork: "mainnet" | "chipnet"; recipientAddress: string; publicId: string; sourceAsset: SourceAsset; sourceAmountAtomic: string; fundingAsset: "PUSD"; fundingAmountAtomic: string; depositAddress: string; destinationNetwork: Exclude<Network, "mainnet" | "chipnet">; destinationAsset: Asset; outputAmountAtomic: string; quote: DirectQuoteResult["quote"] };
type QuoteResult = DirectQuoteResult | CrosschainQuoteResult;
type SentPayment = { txid: string; fundingTxid?: string; publicId?: string; network: Network; address: string; asset: Asset; amount: string; confirmed: boolean };
const PAY_HISTORY_KEY = "voltra-pay-history-v1";

function readPayHistory(key = PAY_HISTORY_KEY): SentPayment[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SentPayment => item && typeof item.txid === "string" && ["mainnet", "chipnet", "stellar-testnet", "base-sepolia", "arc-testnet", "base-mainnet", "arc-mainnet"].includes(item.network) && typeof item.address === "string" && ["BCH", "PUSD", "MUSD", "XLM", "USDC_STELLAR", "USDC_BASE", "USDC_ARC", "USDC_BASE_MAINNET", "USDC_ARC_MAINNET"].includes(item.asset) && typeof item.amount === "string" && /^\d+$/.test(item.amount) && typeof item.confirmed === "boolean").slice(0, 20);
  } catch { return []; }
}

const sourceAssets: SourceAsset[] = ["BCH", "PUSD", "MUSD"];
const recipientAssets: Asset[] = ["BCH", "PUSD", "MUSD", "XLM", "USDC_STELLAR", "USDC_BASE", "USDC_ARC", "USDC_BASE_MAINNET", "USDC_ARC_MAINNET"];
const assetLabel = (asset: Asset) => ({ USDC_STELLAR: "USDC · Stellar Testnet", USDC_BASE: "USDC · Base Sepolia", USDC_ARC: "USDC · Arc Testnet", USDC_BASE_MAINNET: "USDC · Base", USDC_ARC_MAINNET: "USDC · Arc" })[asset as "USDC_STELLAR" | "USDC_BASE" | "USDC_ARC" | "USDC_BASE_MAINNET" | "USDC_ARC_MAINNET"] ?? (asset === "XLM" ? "XLM · Stellar Testnet" : asset);

function formatAtomic(value: string, asset: Asset) {
  const decimals = asset === "BCH" ? 8 : asset === "XLM" || asset === "USDC_STELLAR" ? 7 : asset.startsWith("USDC_") ? 6 : 2;
  const number = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const fraction = (number % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${number / scale}${fraction ? `.${fraction}` : ""}`;
}

function PayLogo() {
  return <Link href="/" aria-label="Voltra Finance home" className="flex items-center"><img src="/voltralogo.png" alt="Voltra Finance" className="h-10 w-10 object-contain" /></Link>;
}

export default function Pay() {
  const wallet = useVoltaWallet();
  return <PayFlow wallet={wallet} networkMode={readNetworkMode()} />;
}

export function PayFlow({ wallet, embedded = false, networkMode = readNetworkMode() }: { wallet: WalletSession; embedded?: boolean; networkMode?: NetworkMode }) {
  const config = trpc.pay.assetConfig.useQuery();
  const quoteMutation = trpc.pay.quote.useMutation();
  const crosschainQuote = trpc.pay.crosschainQuote.useMutation();
  const buildCrosschainFunding = trpc.pay.buildCrosschainFunding.useMutation();
  const scan = trpc.pay.scanWallet.useMutation();
  const buildSwap = trpc.pay.buildSwap.useMutation();
  const broadcast = trpc.pay.broadcast.useMutation();
  const verify = trpc.pay.verify.useMutation();
  const recordCrosschainFunding = trpc.pay.recordCrosschainFunding.useMutation();
  const settleCrosschain = trpc.pay.settleCrosschain.useMutation();
  const [sourceAsset, setSourceAsset] = useState<SourceAsset>("BCH");
  const [recipientAsset, setRecipientAsset] = useState<Asset>("BCH");
  const [amount, setAmount] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [payment, setPayment] = useState<SentPayment | null>(null);
  const [payHistory, setPayHistory] = useState<SentPayment[]>(readPayHistory);
  const visiblePayHistory = payHistory.filter((item) => networkMode === "mainnet"
    ? ["mainnet", "arc-mainnet"].includes(item.network)
    : ["chipnet", "stellar-testnet", "base-sepolia", "arc-testnet"].includes(item.network));
  const availableRecipientAssets = recipientAssets.filter((item) => networkMode === "mainnet"
    ? ["BCH", "PUSD", "MUSD", "USDC_ARC_MAINNET"].includes(item)
    : ["BCH", "PUSD", "MUSD", "XLM", "USDC_STELLAR", "USDC_BASE", "USDC_ARC"].includes(item));
  const [phase, setPhase] = useState("");
  const [busy, setBusy] = useState(false);
  const historyKey = wallet.manager
    ? `${PAY_HISTORY_KEY}:${deriveWalletAddress(wallet.manager, "receive", 0n, "mainnet", true) ?? "wallet"}`
    : PAY_HISTORY_KEY;

  useEffect(() => {
    setPayHistory(readPayHistory(historyKey));
  }, [historyKey]);

  useEffect(() => {
    if (!availableRecipientAssets.includes(recipientAsset)) { setRecipientAsset("BCH"); setQuote(null); setPayment(null); }
  }, [networkMode]);

  useEffect(() => {
    if (!payment) return;
    setPayHistory((current) => {
      const next = [payment, ...current.filter((item) => payment.publicId ? item.publicId !== payment.publicId : item.txid.toLowerCase() !== payment.txid.toLowerCase())].slice(0, 20);
      try { window.localStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* History remains available for this session. */ }
      return next;
    });
  }, [historyKey, payment]);

  const getQuote = async () => {
    setPayment(null);
    try {
      if (["XLM", "USDC_STELLAR", "USDC_BASE", "USDC_ARC", "USDC_BASE_MAINNET", "USDC_ARC_MAINNET"].includes(recipientAsset)) {
        if (sourceAsset === "MUSD") throw new Error("Cross-network Pay currently supports BCH and PUSD as the source asset.");
        const sourceNetwork = recipientAsset === "USDC_BASE_MAINNET" || recipientAsset === "USDC_ARC_MAINNET" ? "mainnet" : "chipnet";
        const result = await crosschainQuote.mutateAsync({ sourceAsset, sourceNetwork, amount, destination: recipientAsset as "XLM" | "USDC_STELLAR" | "USDC_BASE" | "USDC_ARC" | "USDC_BASE_MAINNET" | "USDC_ARC_MAINNET", recipientAddress: recipientAddress.trim() });
        setQuote({ route: "crosschain", network: sourceNetwork, sourceNetwork, recipientAddress: result.destinationAddress, publicId: result.publicId, sourceAsset: result.sourceAsset, sourceAmountAtomic: result.sourceAmountAtomic, fundingAsset: result.fundingAsset, fundingAmountAtomic: result.fundingAmountAtomic, depositAddress: result.depositAddress, destinationNetwork: result.destinationNetwork, destinationAsset: recipientAsset, outputAmountAtomic: result.expectedOutputAtomic, quote: { sell: result.sourceAsset, buy: recipientAsset, inputAmount: result.sourceAmountAtomic, outputAmount: result.expectedOutputAtomic, legs: [] } });
      } else {
        const result = await quoteMutation.mutateAsync({ sell: sourceAsset, buy: recipientAsset as SourceAsset, amount, recipientAddress: recipientAddress.trim() });
        const selectedNetwork = networkMode === "mainnet" ? "mainnet" : "chipnet";
        if (result.network !== selectedNetwork) throw new Error(`That receiving address is on ${result.network === "mainnet" ? "Mainnet" : "Chipnet"}. Switch network mode to continue.`);
        setQuote({ ...result, network: result.network as "mainnet" | "chipnet", route: "direct" });
      }
    } catch (error) {
      setQuote(null);
      toast.error("Could not prepare this payment", { description: error instanceof Error ? error.message : "Check the payment details and try again." });
    }
  };

  const pay = async () => {
    if (!quote || wallet.state !== "connected" || !wallet.manager) {
      if (wallet.state !== "connected") { wallet.connect(); return; }
      return;
    }
    setBusy(true);
    setPayment(null);
    try {
      const network: "mainnet" | "chipnet" = quote.route === "crosschain" ? quote.sourceNetwork : quote.network;
      const categories = config.data?.[network];
      const sourceCategory = sourceAsset === "BCH" ? undefined : categories?.[sourceAsset];
      const directRecipientAsset = quote.route === "crosschain" ? "BCH" : quote.quote.buy as SourceAsset;
      const recipientCategory = directRecipientAsset === "BCH" ? undefined : categories?.[directRecipientAsset];
      if (sourceAsset !== "BCH" && !sourceCategory) throw new Error(`${sourceAsset} is not configured on ${network}.`);
      if (quote.route !== "crosschain" && directRecipientAsset !== "BCH" && !recipientCategory) throw new Error(`${directRecipientAsset} is not configured on ${network}.`);

      const scanAddresses = (indexCount: number) => (["receive", "change"] as const).flatMap((path) =>
        Array.from({ length: indexCount }, (_, addressIndex) => ({
          path,
          addressIndex,
          address: deriveWalletAddress(wallet.manager!, path, BigInt(addressIndex), network, true),
        })).filter((item): item is { path: "receive" | "change"; addressIndex: number; address: string } => Boolean(item.address)),
      );
      const receiveAddress = deriveWalletAddress(wallet.manager, "receive", 0n, network, true);
      const changeAddress = deriveWalletAddress(wallet.manager, "change", 0n, network, true);
      if (!receiveAddress || !changeAddress) throw new Error("The connected wallet did not provide compatible BCH addresses.");

      setPhase("Checking wallet funds");
      const scanned = await scan.mutateAsync({ addresses: scanAddresses(10), network });
      let funding = scanned.filter((item) => !item.token || (sourceCategory && item.token.category.toLowerCase() === sourceCategory.toLowerCase()));
      funding = funding.filter((item) => !item.token?.nft);
      if (!funding.length) throw new Error(`No spendable ${sourceAsset} funds were found in the connected wallet.`);

      if (quote.route === "crosschain") {
        const outputs = [{ address: quote.depositAddress, amountAtomic: quote.fundingAmountAtomic }];
        const paymentFunding = sourceAsset === "BCH" ? funding.filter((item) => !item.token) : funding.filter((item) => item.token?.category.toLowerCase() === sourceCategory?.toLowerCase());
        if (!paymentFunding.length) throw new Error(`No spendable ${sourceAsset} funds were found in the connected wallet.`);
        const built = sourceAsset === "BCH"
          ? await buildCrosschainFunding.mutateAsync({ sourceNetwork: network, fundingAmountAtomic: quote.fundingAmountAtomic, funding: paymentFunding.map(({ txid, vout, value, scriptHex, addressPath, addressIndex }) => ({ txid, vout, value, scriptHex, addressPath, addressIndex })), changeAddress })
          : buildDirectCashTokenBatchPayment({ funding: paymentFunding, outputs, category: sourceCategory!, changeAddress });
        const paths = sourceAsset === "BCH"
          ? cauldronInputPaths(built.unsignedTxHex, built.inputsToSign, paymentFunding)
          : built.inputsToSign.map((index) => [index, paymentFunding[index].addressPath || "receive", paymentFunding[index].addressIndex ?? 0] as [number, "receive" | "change" | "defi", number]);
        setPhase("Approve the payment in your wallet");
        const sourceOutputs = sourceAsset === "BCH" ? normalizeCauldronSourceOutputs(built.sourceOutputs, built.unsignedTxHex) : built.sourceOutputs as Parameters<typeof signWithWizardConnect>[1]["sourceOutputs"];
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs, inputsToSign: built.inputsToSign }, paths);
        setPhase("Sending payment to the settlement route");
        const txid = await broadcast.mutateAsync({ rawTransaction: signed, network }).then((result) => result.txid);
        setPayment({ txid, fundingTxid: txid, publicId: quote.publicId, network: quote.destinationNetwork, address: quote.recipientAddress, asset: quote.destinationAsset, amount: quote.outputAmountAtomic, confirmed: false });
        await recordCrosschainFunding.mutateAsync({ publicId: quote.publicId, txid });
        toast.success("Payment sent", { description: `Waiting for the ${network === "mainnet" ? "Bitcoin Cash mainnet" : "Chipnet"} payment to confirm before sending ${assetLabel(quote.destinationAsset)}.` });
        return;
      }

      let txid = "";
      if (!quote.quote.legs.length) {
        const outputs = [{ address: recipientAddress.trim(), amountAtomic: quote.quote.outputAmount }];
        const paymentFunding = directRecipientAsset === "BCH"
          ? funding.filter((item) => !item.token)
          : funding.filter((item) => !item.token || item.token.category.toLowerCase() === recipientCategory!.toLowerCase());
        const built = directRecipientAsset === "BCH"
          ? buildDirectBchBatchPayment({ funding: paymentFunding, outputs, changeAddress })
          : buildDirectCashTokenBatchPayment({ funding: paymentFunding, outputs, category: recipientCategory!, changeAddress });
        const paths = built.inputsToSign.map((index) => [index, paymentFunding[index].addressPath || "receive", paymentFunding[index].addressIndex ?? 0] as [number, "receive" | "change" | "defi", number]);
        setPhase("Approve the payment in your wallet");
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs: built.sourceOutputs, inputsToSign: built.inputsToSign }, paths);
        setPhase("Broadcasting payment");
        txid = (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid;
      } else {
        for (let index = 0; index < quote.quote.legs.length; index++) {
          const leg = quote.quote.legs[index];
          const finalLeg = index === quote.quote.legs.length - 1;
          setPhase(`Preparing ${leg.sell} to ${leg.buy}`);
          const built = await buildSwap.mutateAsync({
            sell: leg.sell as SourceAsset,
            buy: leg.buy as SourceAsset,
            amount: formatAtomic(leg.outputAmount, leg.buy),
            funding,
            receiveAddress: finalLeg ? recipientAddress.trim() : receiveAddress,
            changeAddress,
            tokenChangeAddress: changeAddress,
            ...(leg.sell !== "BCH" && leg.buy === "BCH" ? { expectedSellAmountAtomic: leg.inputAmount } : {}),
            network,
          });
          if (built.expectedOutput !== leg.outputAmount) throw new Error("The built transaction differs from the quote. It was not sent.");
          const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs: normalizeCauldronSourceOutputs(built.sourceOutputs, built.unsignedTxHex), inputsToSign: built.inputsToSign }, cauldronInputPaths(built.unsignedTxHex, built.inputsToSign, funding));
          setPhase("Broadcasting conversion");
          txid = (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid;
          const outputAddress = finalLeg ? recipientAddress.trim() : receiveAddress;
          const outputAsset = finalLeg ? recipientAsset as SourceAsset : "BCH";
          let confirmed = false;
          for (let attempt = 0; attempt < 18; attempt += 1) {
            const result = await verify.mutateAsync({ txid, recipientAddress: outputAddress, expectedAsset: outputAsset, expectedAmountAtomic: leg.outputAmount, network });
            if (result.verified) { confirmed = true; break; }
            if (attempt < 17) { setPhase(finalLeg ? "Waiting for payment confirmation" : "Waiting for the next conversion to confirm"); await new Promise((resolve) => window.setTimeout(resolve, 5_000)); }
          }
          if (!confirmed) {
            if (finalLeg) setPayment({ txid, network, address: outputAddress, asset: outputAsset, amount: leg.outputAmount, confirmed: false });
            throw new Error(finalLeg ? "Payment was sent and is awaiting confirmation. You can recheck its status below." : "This conversion was sent and is awaiting confirmation. Keep this page open to continue the payment.");
          }
          if (!finalLeg) {
            setPhase("Preparing the recipient payout");
            const nextFunding = await scan.mutateAsync({ addresses: [{ address: receiveAddress, addressIndex: 0, path: "receive" }], network });
            funding = nextFunding.filter((item) => item.txid.toLowerCase() === txid.toLowerCase() && !item.token);
            if (!funding.length) throw new Error("The confirmed BCH conversion is not spendable yet. Reopen Pay and refresh the quote before continuing.");
          }
        }
      }

      if (!txid) throw new Error("The payment transaction was not created.");
      setPayment({ txid, network, address: recipientAddress.trim(), asset: recipientAsset, amount: quote.quote.outputAmount, confirmed: false });
      toast.success("Payment sent", { description: `${formatAtomic(quote.quote.outputAmount, recipientAsset)} ${recipientAsset} is on its way.` });
    } catch (error) {
      toast.error("Payment not completed", { description: error instanceof Error ? error.message : "Check the wallet and payment details, then try again." });
    } finally {
      setBusy(false);
      setPhase("");
    }
  };

  const checkStatus = async () => {
    if (!payment) return;
    try {
      if (payment.publicId) {
        if (payment.fundingTxid) await recordCrosschainFunding.mutateAsync({ publicId: payment.publicId, txid: payment.fundingTxid });
        const result = await settleCrosschain.mutateAsync({ publicId: payment.publicId });
        if (result.status === "completed") {
          const updated = { ...payment, txid: result.txid || payment.txid, confirmed: true };
          setPayment(updated);
          toast.success("Payment confirmed");
        } else toast.info("Payment is still confirming on Chipnet");
        return;
      }
      const result = await verify.mutateAsync({ txid: payment.txid, recipientAddress: payment.address, expectedAsset: payment.asset as SourceAsset, expectedAmountAtomic: payment.amount, network: payment.network as "mainnet" | "chipnet" });
      if (result.verified) {
        setPayment({ ...payment, confirmed: true });
        toast.success("Payment confirmed");
      } else toast.info("Payment is still confirming");
    } catch (error) { toast.error("Could not check payment", { description: error instanceof Error ? error.message : "Try again shortly." }); }
  };

  const checkHistoryStatus = async (item: SentPayment) => {
    try {
      if (item.publicId) {
        if (item.fundingTxid) await recordCrosschainFunding.mutateAsync({ publicId: item.publicId, txid: item.fundingTxid });
        const result = await settleCrosschain.mutateAsync({ publicId: item.publicId });
        if (result.status !== "completed") { toast.info("Payment is still confirming on Chipnet"); return; }
        const updated = { ...item, txid: result.txid || item.txid, confirmed: true };
        setPayHistory((current) => {
          const next = current.map((entry) => entry.publicId === item.publicId ? updated : entry);
          try { window.localStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* Keep the updated status for this session. */ }
          return next;
        });
        setPayment((current) => current?.publicId === item.publicId ? updated : current);
        toast.success("Payment confirmed");
        return;
      }
      const result = await verify.mutateAsync({ txid: item.txid, recipientAddress: item.address, expectedAsset: item.asset as SourceAsset, expectedAmountAtomic: item.amount, network: item.network as "mainnet" | "chipnet" });
      if (!result.verified) { toast.info("Payment is still confirming"); return; }
      const updated = { ...item, confirmed: true };
      setPayHistory((current) => {
        const next = current.map((entry) => entry.txid.toLowerCase() === item.txid.toLowerCase() ? updated : entry);
        try { window.localStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* Keep the updated status for this session. */ }
        return next;
      });
      setPayment((current) => current?.txid.toLowerCase() === item.txid.toLowerCase() ? updated : current);
      toast.success("Payment confirmed");
    } catch (error) { toast.error("Could not check payment", { description: error instanceof Error ? error.message : "Try again shortly." }); }
  };

  const canQuote = Boolean(amount.trim() && recipientAddress.trim());
  const inputClass = "mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-950 outline-none transition placeholder:text-slate-500 focus:border-orange-600 focus:ring-2 focus:ring-orange-200";
  return <main className={embedded ? "w-full text-[#162b3a]" : "min-h-screen bg-[#f7f7f4] px-4 py-5 text-[#162b3a] sm:px-6 sm:py-8"}>
    {!embedded && <header className="mx-auto flex w-full max-w-6xl items-center justify-between"><PayLogo /><Link href="/" className="text-sm font-semibold text-slate-700 transition-colors hover:text-orange-800">Back to Voltra</Link></header>}
    <div className={`mx-auto w-full ${embedded ? "max-w-6xl" : "mt-8 max-w-6xl sm:mt-10"}`}>
      {!embedded && <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
        <div><p className="text-xs font-bold uppercase tracking-[.16em] text-orange-800">Public payment</p><h1 className="mt-1.5 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">Pay</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">Choose what you send and what the recipient receives. Connect your BCH wallet to approve. No account or workspace is required.</p></div>
      </div>}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4 sm:px-6"><h2 className="font-bold text-slate-950">Payment details</h2><p className="mt-1 text-sm text-slate-600">Enter the recipient and payment amount.</p></div>
          <div className="space-y-5 p-5 sm:p-6">
            <label className="block text-sm font-semibold text-slate-800">Recipient address<input value={recipientAddress} onChange={(event) => { setRecipientAddress(event.target.value); setQuote(null); setPayment(null); }} autoComplete="off" spellCheck={false} placeholder={recipientAsset === "XLM" || recipientAsset === "USDC_STELLAR" ? "Stellar Testnet address starting with G…" : recipientAsset.startsWith("USDC_BASE") || recipientAsset.startsWith("USDC_ARC") ? "0x…" : "bitcoincash:… or bchtest:…"} className={`${inputClass} font-mono text-sm`} /></label>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <label className="block min-w-0 text-sm font-semibold text-slate-800">Pay from<select value={sourceAsset} onChange={(event) => { setSourceAsset(event.target.value as SourceAsset); setQuote(null); }} className={inputClass}>{sourceAssets.filter((item) => item !== "MUSD" || config.data?.musdEnabled).map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="block min-w-0 text-sm font-semibold text-slate-800">Recipient receives<select value={recipientAsset} onChange={(event) => { setRecipientAsset(event.target.value as Asset); setQuote(null); }} className={inputClass}>{availableRecipientAssets.filter((item) => item !== "MUSD" || config.data?.musdEnabled).map((item) => <option key={item} value={item}>{assetLabel(item)}</option>)}</select></label>
            </div>
            <label className="block text-sm font-semibold text-slate-800">Amount to send<div className="relative mt-2"><input value={amount} onChange={(event) => { setAmount(event.target.value); setQuote(null); setPayment(null); }} inputMode="decimal" autoComplete="off" placeholder={sourceAsset === "BCH" ? "0.001" : "10.00"} className="min-h-14 w-full rounded-xl border border-slate-300 bg-white px-4 pr-20 text-xl font-bold tabular-nums text-slate-950 outline-none placeholder:text-slate-400 focus:border-orange-600 focus:ring-2 focus:ring-orange-200" /><span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm font-bold text-slate-500">{sourceAsset}</span></div><span className="mt-1.5 block text-xs font-normal text-slate-600">The exact recipient amount appears after you get a quote.</span></label>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><WalletConnection wallet={wallet} /><Button type="button" onClick={() => void getQuote()} disabled={!canQuote || quoteMutation.isPending || crosschainQuote.isPending || busy} variant="outline" className="min-h-11 rounded-xl border-slate-300 px-4 font-semibold text-slate-800 hover:border-slate-400 hover:bg-slate-100 hover:text-slate-950">{quoteMutation.isPending || crosschainQuote.isPending ? <LoaderCircle className="mr-2 animate-spin" size={17} /> : <ArrowLeftRight className="mr-2" size={17} />}Get quote</Button></div>
          </div>
        </section>

        <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 lg:sticky lg:top-5">
          <div className="flex items-center justify-between gap-3"><h2 className="font-bold text-slate-950">Payment summary</h2>{quote && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">Quote ready</span>}</div>
          <div className="mt-5 rounded-xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">You send</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{quote ? formatAtomic(quote.quote.inputAmount, quote.quote.sell) : amount || "—"} <span className="text-sm text-slate-600">{sourceAsset}</span></p>
            <div className="my-4 h-px bg-slate-200" />
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recipient gets</p><p className="mt-1 text-lg font-bold tabular-nums text-slate-950">{quote ? formatAtomic(quote.quote.outputAmount, quote.quote.buy) : "—"} <span className="text-sm text-slate-600">{assetLabel(quote?.quote.buy ?? recipientAsset)}</span></p>
          </div>
          <dl className="mt-4 space-y-3 text-sm"><div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-slate-600">Network</dt><dd className="text-right font-semibold text-slate-900">{quote ? quote.route === "crosschain" ? `${quote.sourceNetwork === "mainnet" ? "Bitcoin Cash mainnet" : "Chipnet"} → ${quote.destinationNetwork === "stellar-testnet" ? "Stellar Testnet" : quote.destinationNetwork === "base-sepolia" ? "Base Sepolia" : quote.destinationNetwork === "arc-testnet" ? "Arc Testnet" : quote.destinationNetwork === "base-mainnet" ? "Base" : "Arc"}` : quote.network === "chipnet" ? "Chipnet" : "Bitcoin Cash mainnet" : "Detected from address"}</dd></div><div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-slate-600">Recipient</dt><dd className="max-w-[65%] break-all text-right font-mono text-xs text-slate-800">{recipientAddress || "Not entered"}</dd></div>{quote && quote.route !== "crosschain" && quote.quote.legs.length > 0 && <div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-slate-600">Conversion</dt><dd className="text-right font-semibold text-slate-900">{quote.quote.legs.map((leg) => `${leg.sell} → ${leg.buy}`).join(" · ")}</dd></div>}</dl>
          {!quote && <p className="mt-4 text-xs leading-5 text-slate-600">Check the live quote before approving. Your wallet will show the transaction for approval.</p>}
          {quote && <Button type="button" onClick={() => void pay()} disabled={busy} className="mt-5 min-h-12 w-full rounded-xl bg-orange-700 px-5 font-bold text-white hover:bg-orange-800">{busy ? <><LoaderCircle className="mr-2 animate-spin" size={17} />{phase || "Preparing…"}</> : wallet.state === "connected" ? "Approve and pay" : <><WalletCards className="mr-2" size={17} />Connect wallet to pay</>}</Button>}
          {payment && <div className={`mt-5 rounded-xl border p-4 ${payment.confirmed ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-slate-950">{payment.confirmed ? "Payment confirmed" : "Payment sent"}</p><p className="mt-1 text-sm text-slate-700">{payment.confirmed ? "The recipient payment is confirmed." : "Waiting for network confirmation."}</p></div>{payment.confirmed && <CheckCircle2 className="shrink-0 text-emerald-700" size={20} />}</div><p className="mt-3 break-all font-mono text-[11px] leading-5 text-slate-700">Transaction: {payment.txid}</p>{!payment.confirmed && <Button variant="outline" onClick={() => void checkStatus()} disabled={verify.isPending} className="mt-3 min-h-10 w-full rounded-lg border-amber-400 bg-white text-slate-900 hover:bg-amber-100 hover:text-slate-950">{verify.isPending ? "Checking…" : "Check status"}</Button>}</div>}
          <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-600">Wallet approval is required before funds are sent. Voltra does not ask for recovery phrases or private keys.</p>
        </aside>
      </div>
      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-5 py-4 sm:px-6"><h2 className="font-bold text-slate-950">Pay history</h2><p className="mt-1 text-sm text-slate-600">Payments sent from this wallet on this device.</p></div>
        {visiblePayHistory.length ? <div className="divide-y divide-slate-100">{visiblePayHistory.map((item) => <div key={`${item.network}-${item.txid}`} className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"><div className="min-w-0"><p className="font-semibold text-slate-900">{formatAtomic(item.amount, item.asset)} {item.asset} <span className="font-normal text-slate-600">to {item.address.slice(0, 14)}…{item.address.slice(-8)}</span></p><p className="mt-1 break-all font-mono text-xs text-slate-600">{item.txid}</p></div><div className="flex shrink-0 items-center gap-3 text-xs"><span className={`rounded-full px-2.5 py-1 font-bold ${item.confirmed ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{item.confirmed ? "Confirmed" : "Sent"}</span><span className="text-slate-500">{item.network}</span>{!item.confirmed && <Button variant="outline" size="sm" disabled={verify.isPending} onClick={() => void checkHistoryStatus(item)} className="min-h-9 rounded-lg border-slate-300 text-slate-800 hover:bg-slate-100 hover:text-slate-950">Check</Button>}</div></div>)}</div> : <p className="px-5 py-6 text-sm text-slate-600 sm:px-6">No {networkMode} Pay history saved on this device.</p>}
      </section>
    </div>
  </main>;
}

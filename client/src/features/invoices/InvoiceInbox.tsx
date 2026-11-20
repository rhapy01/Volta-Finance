import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { WalletSession } from "@/features/wallet/WalletConnection";
import { deriveWalletAddress } from "@/lib/bch";
import { broadcastSignedTransaction, buildDirectBchBatchPayment, buildDirectCashTokenBatchPayment, cauldronInputPaths, normalizeCauldronSourceOutputs, selectDirectInvoiceBatchFunding, signWithWizardConnect, type WizardInputPath } from "@/lib/wallet";
import { trpc } from "@/lib/trpc";

type Asset = "BCH" | "PUSD" | "MUSD";
type Invoice = { id: string; client: string; amount: string; amountAtomic?: string; receivedAmountAtomic?: string | null; requestAsset: string; asset: Asset; deliveryAsset?: string | null; deliveryNetwork?: string | null; status: string; network?: "mainnet" | "chipnet"; receivingAddress?: string | null; paymentTxid?: string | null };

export function InvoiceInbox({ invoices, settledInvoices: createdSettledInvoices = [], wallet, onConnect, onView }: { invoices: Invoice[]; settledInvoices?: Invoice[]; wallet: WalletSession; onConnect: () => void; onView: (id: string) => void }) {
  const utils = trpc.useUtils();
  const chipnetConfig = trpc.finance.chipnetAssetConfig.useQuery();
  const intentAssetConfig = trpc.pay.assetConfig.useQuery();
  const scan = trpc.finance.utxosForAddresses.useMutation();
  const buildSwap = trpc.finance.buildSwap.useMutation();
  const broadcast = trpc.finance.broadcastTransaction.useMutation();
  const recordBroadcast = trpc.finance.recordBroadcast.useMutation();
  const verifyOutput = trpc.finance.verifyOutput.useMutation();
  const markBroadcast = trpc.finance.markInvoiceBatchBroadcast.useMutation();
  const confirmBatch = trpc.finance.payInvoiceBatch.useMutation();
  const createPaymentIntent = trpc.finance.createInvoicePaymentIntent.useMutation();
  const createEvmInvoiceIntent = trpc.finance.createEvmInvoiceIntent.useMutation();
  const recordEvmInvoiceFunding = trpc.finance.recordEvmInvoiceFunding.useMutation();
  const settleEvmInvoice = trpc.finance.settleEvmInvoiceIntent.useMutation();
  const review = trpc.finance.reviewIncomingInvoice.useMutation({ onSuccess: async (_result, input) => { await utils.finance.incomingInvoices.invalidate(); toast.success(input.decision === "accept" ? "Invoice accepted" : "Invoice declined"); }, onError: (error) => toast.error("Invoice decision not saved", { description: error.message }) });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inboxView, setInboxView] = useState<"active" | "settled">("active");
  const [activePage, setActivePage] = useState(0);
  const [settledPage, setSettledPage] = useState(0);
  const [reviewedId, setReviewedId] = useState<string | null>(null);
  const [payAsset, setPayAsset] = useState<Asset>("BCH");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [addressPairsToScan, setAddressPairsToScan] = useState(6);
  const [canSearchMoreAddresses, setCanSearchMoreAddresses] = useState(false);
  const scannedAddresses = useRef(new Set<string>());
  const cachedUtxos = useRef(new Map<string, Awaited<ReturnType<typeof scan.mutateAsync>>[number][]>());
  const scanOwner = useRef<{ manager: WalletSession["manager"]; network: string } | null>(null);
  const activeInvoices = invoices.filter((invoice) => !["Paid", "Expired", "Cancelled"].includes(invoice.status));
  const settledInvoices = [...new Map([...invoices.filter((invoice) => invoice.status === "Paid"), ...createdSettledInvoices].map((invoice) => [invoice.id, invoice])).values()];
  const accepted = activeInvoices.filter((invoice) => invoice.status === "Awaiting payment" && invoice.deliveryAsset !== "XLM");
  const pageSize = 5;
  const activePageCount = Math.max(1, Math.ceil(activeInvoices.length / pageSize));
  const settledPageCount = Math.max(1, Math.ceil(settledInvoices.length / pageSize));
  const activePageIndex = Math.min(activePage, activePageCount - 1);
  const settledPageIndex = Math.min(settledPage, settledPageCount - 1);
  const visibleActiveInvoices = activeInvoices.slice(activePageIndex * pageSize, (activePageIndex + 1) * pageSize);
  const visibleSettledInvoices = settledInvoices.slice(settledPageIndex * pageSize, (settledPageIndex + 1) * pageSize);
  const visibleAccepted = accepted.slice(activePageIndex * pageSize, (activePageIndex + 1) * pageSize);
  const selected = accepted.filter((invoice) => selectedIds.includes(invoice.id));
  const receivingAsset = selected[0]?.asset;
  const network = selected[0]?.network || "chipnet";
  const categories = network === "chipnet" ? chipnetConfig.data?.categories : intentAssetConfig.data?.mainnet;
  const isEvmInvoice = (invoice?: Invoice) => Boolean(invoice?.deliveryNetwork && ["base-sepolia", "arc-testnet", "base-mainnet", "arc-mainnet"].includes(invoice.deliveryNetwork));
  const needsConversion = selected.some((invoice) => (invoice.requestAsset === "USDT" ? "PUSD" : invoice.requestAsset) !== invoice.asset || isEvmInvoice(invoice)) || (Boolean(receivingAsset) && payAsset !== receivingAsset);
  const allVisibleSelected = visibleAccepted.length > 0 && visibleAccepted.every((invoice) => selectedIds.includes(invoice.id));
  const canBatch = selected.length > 1 && selected.every((invoice) => invoice.asset === receivingAsset && invoice.network === selected[0].network) && payAsset === receivingAsset && !selected.some((invoice) => (invoice.requestAsset === "USDT" ? "PUSD" : invoice.requestAsset) !== invoice.asset);
  const checkedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = (invoice: Invoice, checked: boolean) => {
    if (checked && selected.length && (invoice.network || "chipnet") !== network) { toast.error("Pay invoices from different networks separately."); return; }
    if (checked && selected.length && invoice.deliveryNetwork !== selected[0].deliveryNetwork) { toast.error("Pay cross-network invoices separately by destination network."); return; }
    if (checked && selected.length && invoice.asset !== receivingAsset) { toast.error("Choose invoices with the same receiving asset for one payment."); return; }
    setSelectedIds((current) => checked ? current.length >= 5 || current.includes(invoice.id) ? current : [...current, invoice.id] : current.filter((id) => id !== invoice.id));
  };

  const pay = async () => {
    if (!selected.length || !receivingAsset) return;
    if (wallet.state !== "connected" || !wallet.manager) { onConnect(); return; }
    if (needsConversion && selected.length > 1) { toast.error("Converted invoices are paid one at a time."); return; }
    setBusy(true); setPhase("Preparing payment");
    try {
      const categoriesByAsset: Record<Asset, string | undefined> = { BCH: undefined, PUSD: categories?.PUSD, MUSD: categories?.MUSD };
      if ((payAsset !== "BCH" && !categoriesByAsset[payAsset]) || (receivingAsset !== "BCH" && !categoriesByAsset[receivingAsset])) throw new Error("The selected CashToken is not configured for this network.");
      const addresses = (["receive", "change"] as const).flatMap((path) => Array.from({ length: addressPairsToScan }, (_, addressIndex) => ({ path, addressIndex, address: deriveWalletAddress(wallet.manager!, path, BigInt(addressIndex), network) })).filter((item) => Boolean(item.address)));
      if (!addresses.length) throw new Error("The connected wallet did not share receive or change addresses with WizardConnect.");
      setPhase("Checking connected wallet funds");
      if (scanOwner.current?.manager !== wallet.manager || scanOwner.current?.network !== network) { scannedAddresses.current.clear(); cachedUtxos.current.clear(); scanOwner.current = { manager: wallet.manager, network }; }
      const keyFor = (address: string) => `${network}:${address}`;
      const missingAddresses = addresses.filter((item) => !scannedAddresses.current.has(keyFor(item.address!)));
      const newlyScanned = missingAddresses.length ? await scan.mutateAsync({ addresses: missingAddresses as Array<{ address: string; addressIndex: number; path: "receive" | "change" }>, network }) : [];
      for (const item of missingAddresses) scannedAddresses.current.add(keyFor(item.address!));
      for (const utxo of newlyScanned) { const key = keyFor(utxo.address); cachedUtxos.current.set(key, [...(cachedUtxos.current.get(key) ?? []), utxo]); }
      const fundingData = addresses.flatMap((item) => cachedUtxos.current.get(keyFor(item.address!)) ?? []);
      const funding = fundingData.filter((item) => {
        if (!item.token) return true;
        if (item.token.nft) return false;
        if (payAsset === "BCH") return !needsConversion;
        return item.token.category === categoriesByAsset[payAsset];
      });
      if (!funding.length) { setCanSearchMoreAddresses(addressPairsToScan < 100); throw new Error(`No spendable ${payAsset} UTXOs were found in the first ${addressPairsToScan} receive and change address pairs.`); }
      setCanSearchMoreAddresses(false);
      scannedAddresses.current.clear(); cachedUtxos.current.clear();
      const receiveAddress = deriveWalletAddress(wallet.manager, "receive", 0n, network);
      const changeAddress = deriveWalletAddress(wallet.manager, "change", 0n, network, true);
      const tokenChangeAddress = deriveWalletAddress(wallet.manager, "change", 0n, network, true);
      if (!receiveAddress || !changeAddress || !tokenChangeAddress) throw new Error("The connected wallet did not provide compatible change addresses.");
      if (selected.length === 1 && isEvmInvoice(selected[0])) {
        const invoice = selected[0];
        if (payAsset !== "BCH" && payAsset !== "PUSD") throw new Error("EVM invoice payments can be funded with BCH or PUSD.");
        const plan = await createEvmInvoiceIntent.mutateAsync({ publicId: invoice.id, payerAsset: payAsset });
        if (plan.intent.sourceTxid) {
          setPhase("Checking the BCH and EVM settlement");
          const settlement = await settleEvmInvoice.mutateAsync({ intentId: plan.intent.id });
          toast[settlement.status === "completed" ? "success" : "info"](settlement.status === "completed" ? "Invoice payment completed" : "Invoice payment is still confirming", { description: settlement.status === "completed" ? `${invoice.client} was paid on ${invoice.deliveryNetwork}.` : "Recheck the invoice after the BCH or EVM transaction confirms." });
          await utils.finance.incomingInvoices.invalidate();
          return;
        }
        const output = [{ address: plan.depositAddress, amountAtomic: plan.sourceAmountAtomic }];
        const paymentFunding = funding.filter((item) => payAsset === "BCH" ? !item.token : item.token?.category === categoriesByAsset.PUSD);
        if (!paymentFunding.length) throw new Error(`No spendable ${payAsset} funds were found in the scanned wallet addresses.`);
        const built = payAsset === "BCH"
          ? buildDirectBchBatchPayment({ funding: paymentFunding, outputs: output, changeAddress, tokenChangeAddress })
          : buildDirectCashTokenBatchPayment({ funding: paymentFunding, outputs: output, category: categoriesByAsset.PUSD!, changeAddress });
        const paths: WizardInputPath[] = built.inputsToSign.map((index) => [index, paymentFunding[index].addressPath || "receive", paymentFunding[index].addressIndex ?? 0]);
        setPhase(`Approve the ${network === "mainnet" ? "mainnet" : "Chipnet"} payment in your wallet`);
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs: built.sourceOutputs, inputsToSign: built.inputsToSign }, paths);
        setPhase(`Broadcasting the ${network === "mainnet" ? "mainnet" : "Chipnet"} payment`);
        const txid = network === "chipnet" ? (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid : await broadcastSignedTransaction(signed);
        await recordEvmInvoiceFunding.mutateAsync({ intentId: plan.intent.id, txid });
        const settlement = await settleEvmInvoice.mutateAsync({ intentId: plan.intent.id });
        toast[settlement.status === "completed" ? "success" : "info"](settlement.status === "completed" ? "Invoice payment completed" : `${network === "mainnet" ? "Mainnet" : "Chipnet"} payment sent`, { description: settlement.status === "completed" ? `${invoice.client} was paid on ${invoice.deliveryNetwork}.` : `The recipient will receive their selected EVM asset after the ${network === "mainnet" ? "mainnet" : "Chipnet"} payment confirms. Select this invoice again to recheck settlement.` });
        await utils.finance.incomingInvoices.invalidate();
        return;
      }
      const directOutputs = selected.map((invoice) => {
        if (!invoice.receivingAddress) throw new Error(`Invoice ${invoice.id} has no saved receiving address.`);
        return { address: invoice.receivingAddress, amountAtomic: invoice.receivedAmountAtomic || invoice.amountAtomic || "" };
      });
      if (directOutputs.some((item) => !/^\d+$/.test(item.amountAtomic))) throw new Error("An invoice is missing its exact payout amount.");

      if (!needsConversion) {
        const category = categoriesByAsset[receivingAsset];
        const preservable = [categories?.PUSD, categories?.MUSD].filter((item): item is string => Boolean(item));
        const batchFunding = selectDirectInvoiceBatchFunding({ funding, outputs: directOutputs, asset: receivingAsset, category, preserveTokenCategories: preservable });
        const built = receivingAsset === "BCH"
          ? buildDirectBchBatchPayment({ funding: batchFunding, outputs: directOutputs, changeAddress, tokenChangeAddress })
          : buildDirectCashTokenBatchPayment({ funding: batchFunding, outputs: directOutputs, category: category!, changeAddress });
        const paths: WizardInputPath[] = built.inputsToSign.map((index) => [index, batchFunding[index].addressPath || "receive", batchFunding[index].addressIndex ?? 0]);
        setPhase("Approve the single payment in your wallet");
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs: built.sourceOutputs, inputsToSign: built.inputsToSign }, paths);
        setPhase("Broadcasting payment");
        const txid = network === "chipnet" ? (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid : await broadcastSignedTransaction(signed);
        await markBroadcast.mutateAsync({ payments: selected.map((invoice) => ({ publicId: invoice.id })), txid });
        await checkAndSave(selected.map((invoice) => invoice.id), txid, network);
        return;
      }

      if (selected.length !== 1) throw new Error("Pay converted invoices individually; same-asset invoices can be paid together.");
      const invoice = selected[0];
      const intent = await createPaymentIntent.mutateAsync({ publicId: invoice.id, payerAsset: payAsset });
      let currentFunding = funding.filter((item) => !item.token || item.token.category === categoriesByAsset[payAsset]);
      let finalTxid = "";
      if (!intent.quote.legs.length) {
        if (payAsset !== invoice.asset || !invoice.receivingAddress) throw new Error("The invoice quote did not provide a conversion route for this asset pair.");
        const output = [{ address: invoice.receivingAddress, amountAtomic: intent.outputAmountAtomic }];
        const batchFunding = selectDirectInvoiceBatchFunding({ funding: currentFunding, outputs: output, asset: invoice.asset, category: categoriesByAsset[invoice.asset] });
        const built = invoice.asset === "BCH"
          ? buildDirectBchBatchPayment({ funding: batchFunding, outputs: output, changeAddress, tokenChangeAddress })
          : buildDirectCashTokenBatchPayment({ funding: batchFunding, outputs: output, category: categoriesByAsset[invoice.asset]!, changeAddress });
        const inputPaths: WizardInputPath[] = built.inputsToSign.map((index) => [index, batchFunding[index].addressPath || "receive", batchFunding[index].addressIndex ?? 0]);
        setPhase("Approve the invoice payment in your wallet");
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs: built.sourceOutputs, inputsToSign: built.inputsToSign }, inputPaths);
        setPhase("Broadcasting payment");
        finalTxid = network === "chipnet" ? (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid : await broadcastSignedTransaction(signed);
        await recordBroadcast.mutateAsync({ intentId: intent.intent.id, txid: finalTxid });
        const verification = await verifyOutput.mutateAsync({ txid: finalTxid, recipientAddress: invoice.receivingAddress, expectedAsset: invoice.asset, expectedAmountAtomic: intent.outputAmountAtomic, network });
        if (!verification.verified) throw new Error("The invoice output is awaiting confirmation. Recheck the invoice before trying again.");
        await markBroadcast.mutateAsync({ payments: [{ publicId: invoice.id, intentId: intent.intent.id }], txid: finalTxid });
        await checkAndSave([invoice.id], finalTxid, network);
        return;
      }
      for (let legIndex = 0; legIndex < intent.quote.legs.length; legIndex++) {
        const leg = intent.quote.legs[legIndex];
        const finalLeg = legIndex === intent.quote.legs.length - 1;
        if (!currentFunding.length) throw new Error("No spendable inputs remain for the next conversion step.");
        setPhase(leg.sell === "BCH" && leg.buy === "BCH" ? "Building invoice payment" : `Building ${leg.sell} → ${leg.buy} conversion`);
        const built = await buildSwap.mutateAsync({ sell: leg.sell, buy: leg.buy, amount: formatAtomic(leg.outputAmount, leg.buy), side: "buy", funding: currentFunding, receiveAddress: finalLeg ? invoice.receivingAddress! : receiveAddress, changeAddress, tokenChangeAddress, ...(leg.sell !== "BCH" && leg.buy === "BCH" ? { expectedSellAmountAtomic: leg.inputAmount } : {}), network });
        if (built.expectedOutput !== leg.outputAmount) throw new Error("The swap transaction did not match the quoted invoice amount, so it was not signed.");
        const sourceOutputs = normalizeCauldronSourceOutputs(built.sourceOutputs, built.unsignedTxHex);
        const inputPaths = cauldronInputPaths(built.unsignedTxHex, built.inputsToSign, currentFunding);
        setPhase(`Approve ${leg.sell} → ${leg.buy} in your BCH wallet`);
        const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs, inputsToSign: built.inputsToSign }, inputPaths);
        setPhase("Broadcasting conversion");
        finalTxid = network === "chipnet" ? (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid : await broadcastSignedTransaction(signed);
        await recordBroadcast.mutateAsync({ intentId: intent.intent.id, txid: finalTxid });
        const outputAddress = finalLeg ? invoice.receivingAddress! : receiveAddress;
        const outputAsset = finalLeg ? invoice.asset : "BCH";
        const expectedAmountAtomic = built.expectedOutput;
        setPhase("Waiting for the payment output to confirm");
        let verified = false;
        for (let i = 0; i < 18; i++) {
          const result = await verifyOutput.mutateAsync({ txid: finalTxid, recipientAddress: outputAddress, expectedAsset: outputAsset, expectedAmountAtomic, network });
          if (result.verified) { verified = true; break; }
          await new Promise((resolve) => window.setTimeout(resolve, 5000));
        }
        if (!verified) throw new Error("The conversion output has not confirmed yet. Recheck the invoice before trying again.");
        if (!finalLeg) {
          setPhase("Preparing the next payment step");
          const nextFunding = await scan.mutateAsync({ addresses: [{ address: receiveAddress, addressIndex: 0, path: "receive" }], network });
          currentFunding = nextFunding.filter((item) => item.txid === finalTxid && !item.token);
        }
      }
      if (!finalTxid) throw new Error("The router did not create a payment transaction.");
      await markBroadcast.mutateAsync({ payments: [{ publicId: invoice.id, intentId: intent.intent.id }], txid: finalTxid });
      await checkAndSave([invoice.id], finalTxid, network);
    } catch (error) {
      toast.error("Invoice payment not sent", { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); setPhase(""); }
  };

  const checkAndSave = async (ids: string[], txid: string, selectedNetwork: "mainnet" | "chipnet") => {
    for (let i = 0; i < 18; i++) {
      const result = await confirmBatch.mutateAsync({ publicIds: ids, txid, network: selectedNetwork });
      if (result.verified) {
        await Promise.all([utils.finance.incomingInvoices.invalidate(), utils.finance.listInvoices.invalidate()]);
        setSelectedIds([]); toast.success("Payment verified", { description: `${ids.length} invoice${ids.length === 1 ? "" : "s"} paid in ${txid.slice(0, 12)}…` }); return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
    }
    toast.info("Payment broadcast", { description: `Transaction ${txid.slice(0, 12)}… is awaiting confirmation. Recheck the invoice shortly.` });
  };

  const selectAll = (event: ChangeEvent<HTMLInputElement>) => setSelectedIds(event.target.checked ? visibleAccepted.filter((invoice) => !selected.length || (invoice.asset === receivingAsset && (invoice.network || "chipnet") === network)).map((invoice) => invoice.id) : []);

  const renderInvoices = (rows: Invoice[], active: boolean) => rows.length ? <div className="space-y-3">{rows.map((invoice) => <article key={invoice.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm sm:gap-4">{active && invoice.status === "Awaiting payment" && invoice.deliveryAsset !== "XLM" && <input type="checkbox" aria-label={`Select ${invoice.client}`} checked={checkedSet.has(invoice.id)} onChange={(event) => toggle(invoice, event.target.checked)} className="h-4 w-4 accent-orange-600" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><b className="truncate text-sm text-slate-950">{invoice.client}</b><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${invoice.status === "Paid" ? "bg-emerald-50 text-emerald-800" : invoice.status === "Needs review" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>{invoice.status}</span></div><p className="mt-2 text-sm font-semibold text-slate-800">{invoice.amount} {invoice.requestAsset}<span className="mx-2 text-slate-300">·</span><span className="font-normal text-slate-600">Will receive {invoice.deliveryAsset ? `${invoice.deliveryAsset} · ${invoice.deliveryNetwork === "base-sepolia" ? "Base Sepolia" : invoice.deliveryNetwork === "arc-testnet" ? "Arc Testnet" : "Stellar Testnet"}` : invoice.asset}</span></p><p className="mt-1 text-xs text-slate-500">{invoice.id}</p></div><div className="flex flex-wrap items-center gap-2">{active && invoice.status === "Needs review" && reviewedId === invoice.id && <><Button size="sm" variant="outline" disabled={review.isPending} onClick={() => review.mutate({ publicId: invoice.id, decision: "decline" })}>Decline</Button><Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ publicId: invoice.id, decision: "accept" })}>Accept</Button></>}<Button variant="outline" size="sm" className="rounded-xl" onClick={() => { setReviewedId(invoice.id); onView(invoice.id); }}>{invoice.status === "Paid" ? "View receipt" : "View invoice"}</Button></div></article>)}</div> : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">None</p><p className="mt-1 text-xs text-slate-500">There are no {inboxView} invoices here.</p></div>;
  const pagination = (total: number, page: number, setPage: (page: number) => void) => total > pageSize && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><p className="text-xs text-slate-500">Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page + 1 >= Math.ceil(total / pageSize)} onClick={() => setPage(page + 1)}>Next</Button></div></div>;

  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Delivered invoices & receipts</p><h2 className="mt-1 text-xl font-bold text-slate-950">Your invoice inbox</h2><p className="mt-1 text-sm text-slate-600">Choose a section to review current invoices or past payments.</p></div>{selected.length > 0 && inboxView === "active" && <div className="flex flex-wrap items-end gap-2"><label className="text-xs font-semibold text-slate-600">Pay with<select value={payAsset} onChange={(event) => setPayAsset(event.target.value as Asset)} className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"><option>BCH</option><option>PUSD</option><option>MUSD</option></select></label><Button disabled={busy || (selected.length > 1 && !canBatch)} onClick={() => void pay()} className="min-w-36 rounded-xl bg-orange-700 text-white hover:bg-orange-800">{busy ? phase || "Preparing…" : wallet.state !== "connected" ? "Connect wallet to pay" : `Pay ${selected.length} invoice${selected.length === 1 ? "" : "s"}`}</Button></div>}</div>
    <div className="mt-5 inline-flex max-w-full rounded-2xl bg-slate-100 p-1" role="tablist" aria-label="Invoice sections">{([{ id: "active", label: "Active", count: activeInvoices.length }, { id: "settled", label: "Settled", count: settledInvoices.length }] as const).map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={inboxView === tab.id} onClick={() => { setInboxView(tab.id); setSelectedIds([]); }} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${inboxView === tab.id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}><span>{tab.label}</span><span className={`min-w-6 rounded-full px-1.5 py-0.5 text-[11px] ${inboxView === tab.id ? "bg-orange-100 text-orange-800" : "bg-white/70 text-slate-500"}`}>{tab.count}</span></button>)}</div>
    {inboxView === "active" && <div className="mt-5"><div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-bold text-slate-900">Needs your attention</h3><p className="mt-1 text-xs text-slate-500">Review new invoices, then accept, decline, or pay.</p></div>{visibleAccepted.length > 0 && <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" className="h-4 w-4 accent-orange-600" checked={allVisibleSelected} onChange={selectAll} />Select up to five</label>}</div>{selected.length > 1 && !canBatch && <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Choose a single invoice for cross-asset conversion. Matching same-asset invoices can be paid together in one BCH transaction.</p>}{visibleAccepted.length > 0 && <div className="mb-3 flex items-center gap-3 rounded-xl bg-orange-50/70 px-3 py-2 text-xs text-orange-900">{selected.length ? `${selected.length} selected` : "Select accepted invoices to pay"}{canSearchMoreAddresses && selected.length > 0 && <button type="button" className="font-semibold underline" onClick={() => { setAddressPairsToScan((count) => Math.min(count + 5, 100)); setCanSearchMoreAddresses(false); toast.info(`Next payment check will search ${Math.min(addressPairsToScan + 5, 100)} receive/change address pairs.`); }}>Search 5 more address pairs</button>}</div>}{renderInvoices(visibleActiveInvoices, true)}{pagination(activeInvoices.length, activePageIndex, setActivePage)}</div>}
    {inboxView === "settled" && <div className="mt-5"><div className="mb-3"><h3 className="text-sm font-bold text-slate-900">Payment history</h3><p className="mt-1 text-xs text-slate-500">Completed invoices and their receipts.</p></div>{renderInvoices(visibleSettledInvoices, false)}{pagination(settledInvoices.length, settledPageIndex, setSettledPage)}</div>}
  </section>;
}

function formatAtomic(value: string, asset: Asset) { const decimals = asset === "BCH" ? 8 : 2; const integer = BigInt(value); const scale = 10n ** BigInt(decimals); const whole = integer / scale; const fraction = (integer % scale).toString().padStart(decimals, "0").replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); }

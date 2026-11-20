import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { NetworkMode } from "@/lib/networkMode";
import { payrollAssetLabel } from "@/lib/payrollAssetLabels";

type Asset = "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC" | "USDT";
type RecordItem = {
  id: string;
  kind: "Invoice" | "Invoice payment" | "Payroll" | "Organization salary payment" | "Payroll batch" | "Payment intent" | "Cross-chain payment";
  title: string;
  status: string;
  date: Date | string;
  counterparty: string;
  counterpartyEmail?: string | null;
  requestedAmount?: string | null;
  requestedAsset?: string | null;
  sourceAmount?: string | null;
  sourceAsset?: Asset | null;
  outputAmount?: string | null;
  outputAsset?: Asset | null;
  outputAssetLabel?: string;
  networkFeeAtomic?: string | null;
  sourceTxid?: string | null;
  txid?: string | null;
  sourceNetwork: "mainnet" | "chipnet";
  destinationAddress?: string | null;
  sourceAddresses?: Array<{ outpoint: string; address: string | null; valueAtomic: string; asset: string; tokenCategory: string | null; tokenAmount: string | null }>;
};

type RecordFilter = "All activity" | "Invoices" | "Payroll" | "Payments" | "Cross-chain";
const PAGE_SIZE = 8;

export function FinancialRecords({ isOrganization = false, networkMode = "mainnet" }: { isOrganization?: boolean; networkMode?: NetworkMode }) {
  const view = networkMode === "mainnet" ? "mainnet" : "testnet_archive";
  const recordsQuery = trpc.finance.financialRecords.useQuery({ view }, { retry: false });
  const loadSources = trpc.finance.transactionInputSources.useMutation();
  const verifyOutput = trpc.finance.verifyOutput.useMutation();
  const [filter, setFilter] = useState<RecordFilter>("All activity");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loadingTxid, setLoadingTxid] = useState<string | null>(null);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [reconciliation, setReconciliation] = useState<Record<string, "matched" | "pending" | "mismatch">>({});
  const [sourceAddresses, setSourceAddresses] = useState<Record<string, NonNullable<RecordItem["sourceAddresses"]>>>({});

  const records = useMemo(() => {
    const data = recordsQuery.data;
    if (!data) return [] as RecordItem[];
    const rows: RecordItem[] = [];
    for (const invoice of data.invoices) {
      const crosschain = invoice.metadata && typeof invoice.metadata === "object" ? (invoice.metadata as Record<string, unknown>).crosschainSettlement as Record<string, unknown> | undefined : undefined;
      const route = data.crosschain.find((item) => item.invoicePublicId === invoice.publicId);
      const isRecipient = invoice.recipientWorkspaceId === data.workspaceId || invoice.direction === "payable";
      const sourceTxid = typeof crosschain?.sourceTxid === "string" ? crosschain.sourceTxid : route?.sourceTxid || invoice.paymentTxid;
      const linkedIntent = data.transactionIntents.find((intent) => intent.txid === (sourceTxid || invoice.paymentTxid));
      const sourceAmount = typeof crosschain?.sourceAmountAtomic === "string" ? crosschain.sourceAmountAtomic : route?.sourceAmountAtomic ?? linkedIntent?.inputAmountAtomic ?? (invoice.status === "paid" && invoice.deliveryAsset !== "XLM" ? invoice.receivedAmountAtomic || invoice.amountAtomic : null);
      const sourceAsset = typeof crosschain?.sourceAsset === "string" ? crosschain.sourceAsset as Asset : route?.sourceAsset ?? linkedIntent?.payerAsset ?? (invoice.status === "paid" ? invoice.asset : null);
      const outputAmount = typeof crosschain?.destinationAmountAtomic === "string" ? crosschain.destinationAmountAtomic : route?.expectedOutputAtomic ?? invoice.receivedAmountAtomic;
      const outputAsset = invoice.deliveryAsset === "XLM" ? "XLM" : invoice.asset;
      const outputAssetLabel = invoice.deliveryAsset === "USDC" && invoice.deliveryNetwork
        ? `USDC · ${{ "base-sepolia": "Base Sepolia", "arc-testnet": "Arc Testnet", "base-mainnet": "Base Mainnet", "arc-mainnet": "Arc Mainnet", "stellar-testnet": "Stellar Testnet" }[invoice.deliveryNetwork]}`
        : undefined;
      rows.push({
        id: `invoice-${invoice.id}`,
        kind: invoice.status === "paid" ? "Invoice payment" : "Invoice",
        title: invoice.description || invoice.clientName || "Invoice",
        status: invoice.status,
        date: invoice.updatedAt,
        counterparty: isRecipient ? invoice.senderName || "Invoice sender" : invoice.recipientEmail || "Unsent invoice",
        counterpartyEmail: isRecipient ? invoice.senderEmail : invoice.recipientEmail,
        requestedAmount: invoice.displayAmount,
        requestedAsset: invoice.requestAsset,
        sourceAmount,
        sourceAsset,
        outputAmount: outputAmount || (invoice.status === "paid" && sourceAsset === invoice.asset ? invoice.amountAtomic : null),
        outputAsset,
        outputAssetLabel,
        sourceTxid,
        txid: typeof crosschain?.stellarTxid === "string" ? crosschain.stellarTxid : route?.stellarTxid || invoice.paymentTxid,
        sourceNetwork: invoice.receivingAddress?.startsWith("bchtest:") || invoice.deliveryAsset === "XLM" ? "chipnet" : "mainnet",
        destinationAddress: typeof crosschain?.destinationAddress === "string" ? crosschain.destinationAddress : route?.destinationAddress || invoice.receivingAddress,
      });
    }
    for (const item of data.payroll) {
      rows.push({
      id: `payroll-${item.id}`, kind: item.personalIncome ? "Organization salary payment" : "Payroll", title: item.personalIncome ? `${item.period} organization salary` : `${item.period} payroll · ${item.employeeName}`, status: item.status, date: item.updatedAt,
      counterparty: item.personalIncome ? item.organizationName : item.employeeName, counterpartyEmail: item.personalIncome ? null : item.employeeEmail, requestedAmount: item.displayAmount, requestedAsset: item.requestedAmountUnit,
      sourceAsset: item.sourceAsset, outputAmount: item.amountAtomic, outputAsset: item.asset as Asset, outputAssetLabel: payrollAssetLabel(item.asset, networkMode), txid: item.txid, sourceTxid: item.txid,
      sourceNetwork: networkMode === "mainnet" ? "mainnet" : "chipnet", destinationAddress: item.payoutAddress,
      });
    }
    const payrollBatches = new Map<string, typeof data.payroll>();
    for (const item of data.payroll) {
      if (!item.txid || item.personalIncome) continue;
      const key = `${item.runId}:${item.txid}`;
      payrollBatches.set(key, [...(payrollBatches.get(key) ?? []), item]);
    }
    for (const [key, batch] of payrollBatches) {
      const first = batch[0];
      const debit = data.journal.find((entry) => entry.txid === first.txid && entry.account === "cash" && entry.invoiceId == null && entry.asset === first.sourceAsset);
      const requestedAtomic = batch.reduce((sum, item) => sum + BigInt(item.requestedAmountAtomic), 0n).toString();
      const networkFee = first.sourceAsset === "BCH" ? null : data.journal.find((entry) => entry.txid === first.txid && entry.account === "cash" && entry.invoiceId == null && entry.asset === "BCH")?.amountAtomic ?? null;
      rows.push({ id: `payroll-batch-${key}`, kind: "Payroll batch", title: `${first.period} payroll batch · ${first.runPublicId}`, status: first.runStatus, date: first.updatedAt,
        counterparty: `${batch.length} staff payout${batch.length === 1 ? "" : "s"}`, requestedAmount: formatAtomic(requestedAtomic, "USDT"), requestedAsset: "USDT",
        sourceAmount: debit?.amountAtomic, sourceAsset: first.sourceAsset, networkFeeAtomic: networkFee, txid: first.txid, sourceTxid: first.txid, sourceNetwork: "chipnet" });
    }
    for (const intent of data.intents) {
      if (intent.txid && data.invoices.some((invoice) => invoice.paymentTxid === intent.txid)) continue;
      rows.push({ id: `intent-${intent.id}`, kind: "Payment intent", title: `${intent.payerAsset} payment intent`, status: intent.status, date: intent.updatedAt,
        counterparty: intent.recipientAddress || "Wallet recipient", requestedAmount: null, sourceAmount: intent.inputAmountAtomic, sourceAsset: intent.payerAsset, outputAmount: intent.expectedOutputAtomic, outputAsset: intent.recipientAsset,
        txid: intent.txid, sourceTxid: intent.txid, sourceNetwork: networkMode === "mainnet" ? "mainnet" : "chipnet", destinationAddress: intent.recipientAddress });
    }
    for (const intent of data.crosschain) {
      if (intent.invoicePublicId && data.invoices.some((invoice) => invoice.publicId === intent.invoicePublicId)) continue;
      rows.push({ id: `crosschain-${intent.id}`, kind: "Cross-chain payment", title: intent.invoicePublicId ? `Invoice ${intent.invoicePublicId}` : "Cross-chain payment",
      status: intent.status, date: intent.updatedAt, counterparty: networkMode === "mainnet" ? "Cross-chain recipient" : "Stellar Testnet recipient", sourceAmount: intent.sourceAmountAtomic, sourceAsset: intent.sourceAsset,
      outputAmount: intent.expectedOutputAtomic, outputAsset: "XLM", txid: intent.stellarTxid, sourceTxid: intent.sourceTxid, sourceNetwork: networkMode === "mainnet" ? "mainnet" : "chipnet", destinationAddress: intent.destinationAddress });
    }
    return rows.sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime());
  }, [recordsQuery.data, networkMode]);

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter((record) => {
      const categoryMatches = filter === "All activity"
        || (filter === "Invoices" && ["Invoice", "Invoice payment"].includes(record.kind))
        || (filter === "Payroll" && ["Payroll", "Organization salary payment", "Payroll batch"].includes(record.kind))
        || (filter === "Payments" && record.kind === "Payment intent")
        || (filter === "Cross-chain" && record.kind === "Cross-chain payment");
      const searchMatches = !query || [record.title, record.kind, record.status, record.counterparty, record.counterpartyEmail, record.txid, record.requestedAsset, record.outputAsset].some((value) => value?.toLowerCase().includes(query));
      return categoryMatches && searchMatches;
    });
  }, [records, filter, search]);
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const shown = filteredRecords.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const balances = recordsQuery.data?.balances;
  const assets = ["BCH", "PUSD", "MUSD", "XLM", "USDC"] as const;
  const salaryPendingReconciliation = records.filter((record) => record.kind === "Organization salary payment" && record.status === "broadcast" && reconciliation[record.id] === "matched");
  const moneyIn = assets.map((asset) => {
    const salaryAdjustment = salaryPendingReconciliation.filter((record) => record.outputAsset === asset).reduce((sum, record) => sum + BigInt(record.outputAmount || "0"), 0n);
    return { asset, amount: (BigInt(balances?.[asset]?.receivedAtomic ?? "0") + salaryAdjustment).toString() };
  }).filter((item) => BigInt(item.amount) > 0n);
  const moneyOut = assets.map((asset) => ({ asset, amount: balances?.[asset]?.spentAtomic ?? "0" })).filter((item) => BigInt(item.amount) > 0n);
  const receivedInvoiceUsdt = (recordsQuery.data?.invoices ?? []).reduce((sum, invoice) => {
    if (invoice.status !== "paid" || invoice.workspaceId !== recordsQuery.data?.workspaceId || invoice.direction !== "receivable" || invoice.requestAsset !== "USDT") return sum;
    const cents = Math.round(Number(invoice.displayAmount) * 100);
    return Number.isFinite(cents) ? sum + cents : sum;
  }, 0);
  const confirmedRecords = records.filter((record) => ["paid", "verified", "completed"].includes(record.status.toLowerCase()));
  const needsReconciliation = records.filter((record) => Boolean(record.txid && record.destinationAddress && record.outputAsset && record.outputAmount)
    && reconciliation[record.id] !== "matched"
    && reconciliation[record.id] !== "mismatch"
    && !(reconciliation[record.id] === undefined && ["paid", "verified", "completed"].includes(record.status.toLowerCase())));
  const openSources = async (txid: string, network: "mainnet" | "chipnet") => {
    if (sourceAddresses[txid]) { setSourceAddresses((current) => { const next = { ...current }; delete next[txid]; return next; }); return; }
    setLoadingTxid(txid);
    try { const results = await loadSources.mutateAsync({ txid, network }); setSourceAddresses((current) => ({ ...current, [txid]: results })); }
    catch (error) { toast.error("Could not inspect transaction inputs", { description: error instanceof Error ? error.message : String(error) }); }
    finally { setLoadingTxid(null); }
  };
  const reconcile = async (record: RecordItem) => {
      if (!record.txid || !record.destinationAddress || !record.outputAsset || !record.outputAmount || record.outputAsset === "XLM" || record.outputAsset === "USDC" || record.outputAsset === "USDT") return;
    setReconcilingId(record.id);
    try {
      const result = await verifyOutput.mutateAsync({ txid: record.txid, recipientAddress: record.destinationAddress, expectedAsset: record.outputAsset, expectedAmountAtomic: record.outputAmount, network: record.sourceNetwork });
      const state = result.verified ? "matched" : result.status === "pending" || result.status === "not_found" ? "pending" : "mismatch";
      setReconciliation((current) => ({ ...current, [record.id]: state }));
      if (state === "matched") toast.success("Payment reconciled", { description: "The on-chain recipient, asset, and amount match this record." });
      else if (state === "pending") toast.info("Payment is not confirmed yet", { description: "Recheck after the network confirms the transaction." });
      else toast.error("Payment does not match this record", { description: "The on-chain output differs from the saved recipient, asset, or amount." });
    } catch (error) { toast.error("Could not reconcile payment", { description: error instanceof Error ? error.message : String(error) }); }
    finally { setReconcilingId(null); }
  };

  if (recordsQuery.isLoading) return <section className="rounded-2xl border border-slate-200 bg-white p-7 text-sm text-slate-500">Loading your financial records…</section>;
  if (recordsQuery.isError) return <section className="rounded-2xl border border-red-200 bg-white p-7 text-sm text-red-800">Financial records could not be loaded: {recordsQuery.error.message}</section>;

  return <div className="space-y-5">
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-6"><div className="mb-4"><h2 className="text-lg font-bold">Money in and money out</h2><p className="mt-1 text-sm text-slate-500">Invoice payments and organization salary are included in money in. Payroll runs, invoices paid, and other payments are money out.</p></div><div className="mb-3 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-100 text-emerald-700"><ArrowDownLeft size={17} /></span><p className="text-xs font-bold uppercase tracking-wide text-emerald-800">Money in</p></div>{moneyIn.length ? <div className="mt-3 space-y-2">{moneyIn.map((item) => <div key={item.asset} className="flex justify-between gap-3 border-t border-emerald-100 pt-2 text-sm"><span className="font-semibold text-slate-700">{item.asset}</span><span className="font-bold text-slate-950">{formatAtomic(item.amount, item.asset)} {item.asset}</span></div>)}</div> : <p className="mt-3 text-sm text-slate-600">None recorded yet</p>}</div><div className="rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 to-white p-4"><div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-orange-100 text-orange-700"><ArrowUpRight size={17} /></span><p className="text-xs font-bold uppercase tracking-wide text-orange-800">Money out</p></div>{moneyOut.length ? <div className="mt-3 space-y-2">{moneyOut.map((item) => <div key={item.asset} className="flex justify-between gap-3 border-t border-orange-100 pt-2 text-sm"><span className="font-semibold text-slate-700">{item.asset}</span><span className="font-bold text-slate-950">{formatAtomic(item.amount, item.asset)} {item.asset}</span></div>)}</div> : <p className="mt-3 text-sm text-slate-600">None recorded yet</p>}</div></div><div className="rounded-xl bg-slate-50 px-4 py-3 text-sm"><b>Invoice value received in USDT:</b> <span className="font-semibold">${(receivedInvoiceUsdt / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span className="ml-2 text-slate-500">from paid invoices requested in USDT</span></div></section>
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_12px_36px_rgba(15,23,42,.045)]">
      <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 via-white to-orange-50/60 p-5 sm:p-7"><p className="text-xs font-bold uppercase tracking-[.18em] text-orange-700">{isOrganization ? "Organization accounting" : "Personal accounting"}</p><div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><h2 className="text-2xl font-bold tracking-tight text-slate-950">Financial ledger</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">A chronological record of invoices, payroll payouts, and payment activity. Review each transaction and reconcile its on-chain recipient, asset, and amount.</p></div><label className="relative block w-full lg:max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search payee, invoice, transaction…" className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-3 text-sm outline-none transition focus:border-orange-400 focus:ring-4 focus:ring-orange-100" /></label></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ledger entries</p><p className="mt-2 text-2xl font-bold text-slate-950">{records.length}</p><p className="mt-1 text-xs text-slate-500">Across invoices and payroll</p></div><div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Payments confirmed</p><p className="mt-2 text-2xl font-bold text-slate-950">{confirmedRecords.length}</p><p className="mt-1 text-xs text-slate-600">Verified or settled activity</p></div><div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-amber-800">Need reconciliation</p><p className="mt-2 text-2xl font-bold text-slate-950">{needsReconciliation.length}</p><p className="mt-1 text-xs text-slate-600">On-chain details ready to check</p></div></div>
      </div>
      <div className="p-5 sm:p-7"><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-lg font-bold text-slate-950">Activity and reconciliation</h3><p className="mt-1 text-sm text-slate-500">{filteredRecords.length} {filteredRecords.length === 1 ? "entry" : "entries"} · newest first</p></div><div className="inline-flex w-fit rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Filter financial activity">{(["All activity", "Invoices", "Payroll", "Payments", "Cross-chain"] as const).map((value) => <button key={value} role="tab" aria-selected={filter === value} onClick={() => { setFilter(value); setPage(1); }} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${filter === value ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>{value}</button>)}</div></div>
      {!shown.length ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-10 text-center"><p className="font-semibold text-slate-800">No matching records</p><p className="mt-1 text-sm text-slate-500">Try another category or search term.</p></div> : <div className="space-y-3">{shown.map((record) => {
        const sourceTxid = record.sourceTxid;
        const loaded = sourceTxid ? sourceAddresses[sourceTxid] : undefined;
        const isConfirmed = ["paid", "verified", "completed"].includes(record.status.toLowerCase());
        const reconciliationLabel = reconciliation[record.id] === "matched" ? "Reconciled" : reconciliation[record.id] === "mismatch" ? "Mismatch" : reconciliation[record.id] === "pending" ? "Awaiting confirmation" : isConfirmed ? "Confirmed on-chain" : "Needs reconciliation";
        const reconciliationTone = reconciliation[record.id] === "mismatch" ? "bg-red-50 text-red-800" : reconciliation[record.id] === "matched" || (reconciliation[record.id] === undefined && isConfirmed) ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800";
        return <article key={record.id} className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-sm sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">{record.kind}</span><span className="rounded-full bg-orange-50 px-2.5 py-1 text-[10px] font-semibold capitalize text-orange-800">{record.status.replaceAll("_", " ")}</span></div><b className="mt-2 block text-base text-slate-950">{record.title}</b><p className="mt-1 text-sm text-slate-500">{new Date(record.date).toLocaleString()} <span className="mx-1">·</span> {record.counterparty}{record.counterpartyEmail ? ` (${record.counterpartyEmail})` : ""}</p></div><div className="min-w-[180px] rounded-xl bg-slate-50 px-4 py-3 text-left sm:text-right">{record.requestedAmount && <p className="text-sm font-semibold text-slate-950">{record.requestedAmount} {record.requestedAsset} requested</p>}{record.sourceAsset && <p className="mt-1 text-xs text-slate-600">Paid from {record.sourceAmount ? `${formatAtomic(record.sourceAmount, record.sourceAsset)} ` : ""}{record.sourceAsset}</p>}{record.outputAsset && record.outputAmount && <p className="mt-1 text-xs font-semibold text-emerald-800">Will receive {formatAtomic(record.outputAmount, record.outputAsset)} {record.outputAssetLabel ?? payrollAssetLabel(record.outputAsset)}</p>}</div></div>
          <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-xs sm:grid-cols-2"><div><p className="font-semibold text-slate-500">Paid to / receiving destination</p><code className="mt-1 block break-all text-slate-700">{record.destinationAddress || "Not recorded"}</code>{record.networkFeeAtomic && <p className="mt-2 text-slate-600">BCH network fee: {formatAtomic(record.networkFeeAtomic, "BCH")} BCH</p>}</div><div><p className="font-semibold text-slate-500">Transaction</p>{record.txid ? <code className="mt-1 block break-all text-slate-700">{record.txid}</code> : <p className="mt-1 text-slate-500">Not broadcast</p>}{record.sourceTxid && record.sourceTxid !== record.txid && <><p className="mt-2 font-semibold text-slate-500">Source transaction</p><code className="mt-1 block break-all text-slate-700">{record.sourceTxid}</code></>}</div></div>
          {record.txid && record.destinationAddress && record.outputAsset && record.outputAmount && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${reconciliationTone}`}>{reconciliationLabel}</span>{record.outputAsset !== "XLM" && record.outputAsset !== "USDC" && record.outputAsset !== "USDT" && <Button size="sm" variant="outline" disabled={reconcilingId === record.id} onClick={() => void reconcile(record)}>{reconcilingId === record.id ? "Checking chain…" : reconciliation[record.id] === "matched" ? "Check again" : "Reconcile payment"}</Button>}</div>}
          {sourceTxid && <div className="mt-2"><Button size="sm" variant="outline" disabled={loadingTxid === sourceTxid} onClick={() => void openSources(sourceTxid, record.sourceNetwork)}>{loaded ? "Hide payer input addresses" : loadingTxid === sourceTxid ? "Checking transaction inputs…" : "Show payer input addresses"}</Button>{loaded && <div className="mt-2 grid gap-2 sm:grid-cols-2">{loaded.map((source) => <div key={source.outpoint} className="rounded-lg border border-slate-200 p-3"><p className="text-[11px] font-semibold text-slate-500">Input · {source.asset} · {source.outpoint.slice(0, 16)}…</p><code className="mt-1 block break-all text-xs text-slate-700">{source.address || "Script / address could not be resolved"}</code>{source.tokenAmount && <p className="mt-1 text-[11px] text-slate-500">Token amount {source.tokenAmount}</p>}</div>)}</div>}</div>}
        </article>;
      })}</div>}
      {filteredRecords.length > PAGE_SIZE && <div className="mt-5 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-slate-500">Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredRecords.length)} of {filteredRecords.length}</p><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} />Previous</Button><span className="px-2 text-xs font-semibold text-slate-600">Page {currentPage} of {totalPages}</span><Button size="sm" variant="outline" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next<ChevronRight size={15} /></Button></div></div>}
      </div>
    </section>
  </div>;
}

function formatAtomic(value: string, asset: Asset | string) {
  const decimals = asset === "BCH" ? 8 : asset === "XLM" || asset === "USDC" ? 7 : ["BSUSDC", "ARUSDC", "BMUSDC", "AMUSDC"].includes(asset) ? 6 : 2;
  try { const amount = BigInt(value); const scale = 10n ** BigInt(decimals); const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, ""); return fraction ? `${amount / scale}.${fraction}` : (amount / scale).toString(); }
  catch { return value; }
}

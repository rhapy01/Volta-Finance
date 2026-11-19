import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { WalletSession } from "@/features/wallet/WalletConnection";
import { deriveWalletAddress } from "@/lib/bch";
import { cauldronInputPaths, normalizeCauldronSourceOutputs, signWithWizardConnect, type WizardInputPath } from "@/lib/wallet";
import { trpc } from "@/lib/trpc";

type Employee = { id: number; fullName: string; preferredAsset: "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC"; active: boolean; monthlyDisplayAmount: string | null; walletAddress: string | null; bchAddress: string | null; tokenAddress: string | null };
type Run = { id: number; publicId: string; period: string; sourceAsset: "BCH" | "PUSD" | "MUSD"; status: string; stellarFundingAddress: string | null; stellarFundingAmountAtomic: string | null; stellarFundingTxid: string | null; stellarPayoutTxid: string | null };
type Item = { id: number; employeeId: number; asset: "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC"; amountAtomic: string; displayAmount: string; payoutAddress: string; status: string; txid: string | null; failureReason: string | null };

export function PayrollRunExecution({ run, items, employees, wallet, onConnect }: { run?: Run; items: Item[]; employees: Employee[]; wallet: WalletSession; onConnect: () => void }) {
  const utils = trpc.useUtils();
  const scan = trpc.finance.utxosForAddresses.useMutation();
  const buildBchBatch = trpc.finance.buildPayrollBatch.useMutation();
  const buildPusdBatch = trpc.finance.buildPusdPayrollBatch.useMutation();
  const broadcast = trpc.finance.broadcastTransaction.useMutation();
  const verifyOutput = trpc.finance.verifyOutput.useMutation();
  const approveRun = trpc.finance.approvePayrollRun.useMutation();
  const updateRun = trpc.finance.updatePayrollRun.useMutation();
  const updateItem = trpc.finance.updatePayrollItem.useMutation();
  const recordStellarFunding = trpc.finance.recordStellarPayrollFunding.useMutation();
  const settleStellarPayroll = trpc.finance.settleStellarPayroll.useMutation();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [addressPairsToScan, setAddressPairsToScan] = useState(6);
  const [canSearchMoreAddresses, setCanSearchMoreAddresses] = useState(false);
  const scannedAddresses = useRef(new Set<string>());
  const cachedUtxos = useRef(new Map<string, Awaited<ReturnType<typeof scan.mutateAsync>>[number][]>());
  const scanOwner = useRef<WalletSession["manager"] | null>(null);
  if (!run) return <div className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Create a payroll run after adding active members and setting their saved payout addresses.</div>;
  const runItems = items.filter((item) => item.status !== "verified");
  const canPay = runItems.length > 0 && runItems.every((item) => item.payoutAddress && /^\d+$/.test(item.amountAtomic));
  const hasStellar = items.some((item) => item.asset === "XLM" || item.asset === "USDC");
  const canRecheckStellar = hasStellar && Boolean(run.stellarFundingTxid && run.stellarPayoutTxid);

  const pay = async () => {
    if ((!canPay || !runItems.length) && !canRecheckStellar) return;
    const existingTxid = run.stellarFundingTxid || items.find((item) => item.asset !== "XLM" && item.asset !== "USDC" && item.txid)?.txid;
    if (existingTxid) {
      setBusy(true); setPhase("Checking the existing payroll transaction");
      try {
        const pending: Item[] = [];
        for (const item of items.filter((candidate): candidate is Item & { asset: "BCH" | "PUSD" | "MUSD" } => candidate.asset !== "XLM" && candidate.asset !== "USDC" && candidate.status !== "verified")) {
          const result = await verifyOutput.mutateAsync({ txid: existingTxid, recipientAddress: item.payoutAddress, expectedAsset: item.asset, expectedAmountAtomic: item.amountAtomic, network: "chipnet" });
          if (result.verified) await updateItem.mutateAsync({ itemId: item.id, status: "verified", txid: existingTxid });
          else pending.push(item);
        }
        if (items.some((item) => item.asset === "XLM" || item.asset === "USDC")) {
          const result = await settleStellarPayroll.mutateAsync({ runId: run.id });
          if (result.status === "completed") toast.success("Stellar payroll paid", { description: `${result.txid.slice(0, 12)}…` });
          else if (result.status === "failed") toast.error("Stellar payroll payout failed", { description: result.reason });
          else toast.info("Stellar payout is still processing", { description: "Recheck the payroll run after its transaction is available on the network." });
          await utils.finance.payrollData.invalidate();
          return;
        }
        if (!pending.length) { await updateRun.mutateAsync({ runId: run.id, status: "completed" }); toast.success("Payroll transaction verified", { description: `${existingTxid.slice(0, 12)}…` }); }
        else toast.info("Payroll transaction is still confirming", { description: `${pending.length} payout${pending.length === 1 ? "" : "s"} remain pending. The transaction will not be sent again.` });
        await utils.finance.payrollData.invalidate();
      } catch (error) { toast.error("Could not recheck payroll transaction", { description: error instanceof Error ? error.message : String(error) }); }
      finally { setBusy(false); setPhase(""); }
      return;
    }
    if (wallet.state !== "connected" || !wallet.manager) { onConnect(); return; }
    if (run.sourceAsset === "MUSD") { toast.error("MUSD cannot be the source for a single composed payroll transaction yet."); return; }
    if (run.sourceAsset === "PUSD" && runItems.some((item) => item.asset === "MUSD")) { toast.error("A PUSD payroll transaction can pay BCH and PUSD members. Choose BCH to pay a run that includes MUSD."); return; }
    if (runItems.some((item) => item.asset === "XLM" || item.asset === "USDC") && (run.sourceAsset !== "PUSD" || !run.stellarFundingAddress || !run.stellarFundingAmountAtomic)) { toast.error("Stellar payouts require PUSD as the source asset and a saved funding quote."); return; }
    setBusy(true); setPhase("Preparing one payroll transaction");
    try {
      if (run.status === "draft") await approveRun.mutateAsync({ runId: run.id });
      const network = "chipnet" as const;
      const addresses = (["receive", "change"] as const).flatMap((path) => Array.from({ length: addressPairsToScan }, (_, addressIndex) => ({ path, addressIndex, address: deriveWalletAddress(wallet.manager!, path, BigInt(addressIndex), network) })).filter((item) => Boolean(item.address)));
      if (!addresses.length) throw new Error("WizardConnect did not provide BCH receive/change paths for this wallet.");
      setPhase(`Checking ${run.sourceAsset} wallet funds`);
      if (scanOwner.current !== wallet.manager) { scannedAddresses.current.clear(); cachedUtxos.current.clear(); scanOwner.current = wallet.manager; }
      const keyFor = (address: string) => `${network}:${address}`;
      const missingAddresses = addresses.filter((item) => !scannedAddresses.current.has(keyFor(item.address!)));
      const newlyScanned = missingAddresses.length ? await scan.mutateAsync({ addresses: missingAddresses as Array<{ address: string; addressIndex: number; path: "receive" | "change" }>, network }) : [];
      for (const item of missingAddresses) scannedAddresses.current.add(keyFor(item.address!));
      for (const utxo of newlyScanned) { const key = keyFor(utxo.address); cachedUtxos.current.set(key, [...(cachedUtxos.current.get(key) ?? []), utxo]); }
      const found = addresses.flatMap((item) => cachedUtxos.current.get(keyFor(item.address!)) ?? []);
      const tokenCategory = (await utils.finance.chipnetAssetConfig.fetch()).categories.PUSD;
      const funding = run.sourceAsset === "BCH"
        ? found.filter((item) => !item.token).map(({ txid, vout, value, scriptHex, addressPath, addressIndex }) => ({ txid, vout, value, scriptHex, addressPath, addressIndex }))
        : found.filter((item) => !item.token || item.token.category === tokenCategory).map(({ txid, vout, value, scriptHex, token, addressPath, addressIndex }) => ({ txid, vout, value, scriptHex, ...(token ? { token: { category: token.category, amount: token.amount } } : {}), addressPath, addressIndex }));
      if (!funding.length) { setCanSearchMoreAddresses(addressPairsToScan < 100); throw new Error(`No spendable ${run.sourceAsset} funding UTXOs were found in the first ${addressPairsToScan} receive/change address pairs.`); }
      setCanSearchMoreAddresses(false);
      scannedAddresses.current.clear(); cachedUtxos.current.clear();
      const changeAddress = deriveWalletAddress(wallet.manager, "change", 0n, network, run.sourceAsset === "PUSD");
      if (!changeAddress) throw new Error("The connected wallet did not provide a compatible change address.");
      const stellarItems = runItems.filter((item) => item.asset === "XLM" || item.asset === "USDC");
      const directItems = runItems.filter((item): item is Item & { asset: "BCH" | "PUSD" | "MUSD" } => item.asset !== "XLM" && item.asset !== "USDC");
      const payouts: Array<{ asset: "BCH" | "PUSD" | "MUSD"; amountAtomic: string; address: string }> = directItems.map((item) => ({ asset: item.asset, amountAtomic: item.amountAtomic, address: item.payoutAddress }));
      if (stellarItems.length && run.stellarFundingAddress && run.stellarFundingAmountAtomic) payouts.push({ asset: "PUSD", amountAtomic: run.stellarFundingAmountAtomic, address: run.stellarFundingAddress });
      if (run.sourceAsset === "PUSD" && !payouts.some((item) => item.asset === "BCH")) payouts.push({ asset: "BCH", amountAtomic: "546", address: changeAddress });
      setPhase(stellarItems.length ? "Composing PUSD payroll funding and payouts" : "Composing BCH, CashToken, and Cauldron outputs");
      const built = run.sourceAsset === "BCH"
        ? await buildBchBatch.mutateAsync({ payouts, funding, changeAddress, network })
        : await buildPusdBatch.mutateAsync({ payouts: payouts as Array<{ asset: "BCH" | "PUSD"; amountAtomic: string; address: string }>, funding, changeAddress, network });
      const sourceOutputs = normalizeCauldronSourceOutputs(built.sourceOutputs, built.unsignedTxHex);
      const inputPaths: WizardInputPath[] = cauldronInputPaths(built.unsignedTxHex, built.inputsToSign, funding);
      setPhase("Approve the payroll once in your wallet");
      const signed = await signWithWizardConnect(wallet.manager, { transaction: built.unsignedTxHex, sourceOutputs, inputsToSign: built.inputsToSign }, inputPaths);
      setPhase("Broadcasting the combined payment");
      const txid = (await broadcast.mutateAsync({ rawTransaction: signed, network })).txid;
      if (!built.sourceSpendAtomic || !built.bchCostAtomic) throw new Error("The payroll transaction did not return its exact source-asset accounting totals.");
      if (stellarItems.length) await recordStellarFunding.mutateAsync({ runId: run.id, txid, sourceSpendAtomic: built.sourceSpendAtomic, bchCostAtomic: built.bchCostAtomic });
      else await updateRun.mutateAsync({ runId: run.id, status: "processing", txid, sourceSpendAtomic: built.sourceSpendAtomic, bchCostAtomic: built.bchCostAtomic });
      await Promise.all(directItems.map((item) => updateItem.mutateAsync({ itemId: item.id, status: "broadcast", txid })));
      await utils.finance.payrollData.invalidate();
      setPhase("Waiting for the transaction to confirm");
      let pending = directItems;
      for (let attempt = 0; attempt < 18 && pending.length; attempt++) {
        const results = await Promise.all(pending.map(async (item) => ({ item, result: await verifyOutput.mutateAsync({ txid, recipientAddress: item.payoutAddress, expectedAsset: item.asset, expectedAmountAtomic: item.amountAtomic, network }) })));
        for (const { item, result } of results) if (result.verified) await updateItem.mutateAsync({ itemId: item.id, status: "verified", txid });
        pending = results.filter(({ result }) => !result.verified).map(({ item }) => item);
        if (pending.length) await new Promise((resolve) => window.setTimeout(resolve, 5000));
      }
      if (!pending.length) {
        if (stellarItems.length) {
          setPhase("Settling Stellar payouts on Testnet");
          let settlement: Awaited<ReturnType<typeof settleStellarPayroll.mutateAsync>> | undefined;
          for (let attempt = 0; attempt < 18; attempt++) {
            settlement = await settleStellarPayroll.mutateAsync({ runId: run.id });
            if (settlement.status === "completed" || settlement.status === "failed") break;
            await new Promise((resolve) => window.setTimeout(resolve, 5000));
          }
          if (settlement?.status === "completed") toast.success("Payroll paid on Chipnet and Stellar Testnet", { description: `${runItems.length} staff payouts · ${settlement.txid.slice(0, 12)}…` });
          else if (settlement?.status === "failed") toast.error("Stellar payroll payout failed", { description: settlement.reason });
          else toast.info("PUSD funding confirmed; Stellar payouts are still processing", { description: "Recheck the run to safely retry Stellar settlement." });
        } else {
          await updateRun.mutateAsync({ runId: run.id, status: "completed", txid, sourceSpendAtomic: built.sourceSpendAtomic, bchCostAtomic: built.bchCostAtomic });
          toast.success("Payroll paid in one transaction", { description: `${runItems.length} staff payouts · ${txid.slice(0, 12)}…` });
        }
      } else toast.info("Payroll transaction broadcast", { description: `${pending.length} payout${pending.length === 1 ? "" : "s"} still need confirmation. No second wallet approval is required.` });
      await utils.finance.payrollData.invalidate();
    } catch (error) {
      toast.error("Payroll payment not sent", { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); setPhase(""); }
  };

  const hasBroadcast = Boolean(run.stellarFundingTxid) || items.some((item) => item.txid);
  const verifiedCount = items.filter((item) => item.status === "verified").length;
  const requestedTotal = items.reduce((total, item) => total + (Number(item.displayAmount) || 0), 0);
  return <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_12px_36px_rgba(15,23,42,.045)]"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 via-white to-orange-50/60 p-5 sm:p-7"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">{run.period} · {run.publicId}</p><h3 className="mt-1 text-lg font-bold">Review and pay this run</h3><p className="mt-1 text-sm text-slate-500">{run.status} · {run.sourceAsset} source · {hasStellar ? "PUSD funding, then Stellar Testnet settlement" : "one composed transaction"}</p></div><div className="flex flex-wrap gap-2">{canSearchMoreAddresses && <Button variant="outline" disabled={busy} onClick={() => { const nextCount = Math.min(addressPairsToScan + 5, 100); setAddressPairsToScan(nextCount); setCanSearchMoreAddresses(false); toast.info(`Next payment check will search ${nextCount} receive/change address pairs.`); }}>Search 5 more address pairs</Button>}<Button disabled={busy || (!canPay && !canRecheckStellar) || run.status === "cancelled"} onClick={() => void pay()} className="bg-orange-600 text-white">{busy ? phase || "Preparing…" : run.status === "partial" && hasStellar ? "Retry Stellar payout" : hasBroadcast ? "Recheck payroll payout" : wallet.state !== "connected" ? "Connect wallet to pay" : "Pay payroll run"}</Button></div></div><div className="grid gap-3 border-b border-slate-100 bg-white p-4 sm:grid-cols-3 sm:p-5"><div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Requested total</p><p className="mt-1.5 text-xl font-bold text-slate-950">{requestedTotal.toFixed(2)} USDT</p><p className="mt-1 text-xs text-slate-500">Payroll amounts are denominated in USDT</p></div><div className="rounded-2xl bg-emerald-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Payouts verified</p><p className="mt-1.5 text-xl font-bold text-slate-950">{verifiedCount} / {items.length}</p><p className="mt-1 text-xs text-slate-600">{hasStellar ? "Confirmed on Chipnet and Stellar Testnet" : "Confirmed on Chipnet"}</p></div><div className="rounded-2xl bg-orange-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-orange-800">Still to complete</p><p className="mt-1.5 text-xl font-bold text-slate-950">{items.length - verifiedCount}</p><p className="mt-1 text-xs text-slate-600">{hasStellar ? "Includes a separate Stellar settlement step" : "Included in the same transaction"}</p></div></div><div className="p-4 sm:p-6"><div className="mb-3 flex items-center justify-between"><h4 className="font-bold text-slate-950">Payout breakdown</h4><span className="text-xs text-slate-500">{items.length} staff</span></div><div className="hidden overflow-x-auto rounded-2xl border border-slate-200 lg:block"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-slate-100 text-xs text-slate-500"><th className="pb-3">Employee</th><th className="pb-3">Requested</th><th className="pb-3">Estimated payout</th><th className="pb-3">Status</th><th className="pb-3">Receiving address</th><th className="pb-3">Transaction</th></tr></thead><tbody>{items.map((item) => { const employee = employees.find((candidate) => candidate.id === item.employeeId); return <tr key={item.id} className="border-b border-slate-50"><td className="py-3 font-semibold">{employee?.fullName || "Staff member"}</td><td className="py-3">{item.displayAmount} USDT</td><td className="py-3">{formatAmount(item.amountAtomic, item.asset)} {item.asset}</td><td className="py-3">{item.status}</td><td className="py-3"><a href={explorerAddress(item.asset, item.payoutAddress)} target="_blank" rel="noopener noreferrer" className="text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-900"><code className="text-xs">{short(item.payoutAddress)}</code></a></td><td className="py-3">{item.txid ? <a href={explorerTransaction(item.asset, item.txid)} target="_blank" rel="noopener noreferrer" className="text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-900"><code className="text-xs">{`${item.txid.slice(0, 12)}…`}</code></a> : <span className="text-xs text-slate-500">{item.failureReason || "Awaiting payment"}</span>}</td></tr>; })}</tbody></table></div><div className="space-y-3 lg:hidden">{items.map((item) => { const employee = employees.find((candidate) => candidate.id === item.employeeId); return <article key={item.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><b className="text-sm text-slate-950">{employee?.fullName || "Staff member"}</b><a href={explorerAddress(item.asset, item.payoutAddress)} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-xs text-orange-700 underline decoration-orange-300 underline-offset-2">{short(item.payoutAddress)}</a></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold capitalize text-slate-700">{item.status}</span></div><div className="mt-3 flex items-end justify-between gap-3 border-t border-slate-100 pt-3"><div><p className="text-[10px] font-semibold uppercase text-slate-500">Requested</p><p className="mt-1 text-sm font-semibold">{item.displayAmount} USDT</p></div><div className="text-right"><p className="text-[10px] font-semibold uppercase text-slate-500">Estimated payout</p><p className="mt-1 text-sm font-bold text-slate-950">{formatAmount(item.amountAtomic, item.asset)} {item.asset}</p></div></div><p className="mt-3 break-all text-[11px] text-slate-500">{item.txid ? <a href={explorerTransaction(item.asset, item.txid)} target="_blank" rel="noopener noreferrer" className="text-orange-700 underline decoration-orange-300 underline-offset-2">Transaction {item.txid}</a> : item.failureReason || "Awaiting payment"}</p></article>; })}</div></div></section>;
}

function formatAmount(value: string, asset: "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC") { const decimals = asset === "BCH" ? 8 : asset === "XLM" || asset === "USDC" ? 7 : 2; const amount = BigInt(value); const scale = 10n ** BigInt(decimals); const part = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, ""); return part ? `${amount / scale}.${part}` : (amount / scale).toString(); }
function short(value: string) { return value.length > 28 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value; }
function explorerAddress(asset: Item["asset"], address: string) { return asset === "XLM" || asset === "USDC" ? `https://stellar.expert/explorer/testnet/account/${encodeURIComponent(address)}` : `https://explorer.selene.cash/address/${encodeURIComponent(address)}?network=chipnet`; }
function explorerTransaction(asset: Item["asset"], txid: string) { return asset === "XLM" || asset === "USDC" ? `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(txid)}` : `https://explorer.selene.cash/tx/${encodeURIComponent(txid)}?network=chipnet`; }

import { BriefcaseBusiness, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { NetworkMode } from "@/lib/networkMode";
import { toast } from "sonner";
import { payrollAssetLabel } from "@/lib/payrollAssetLabels";

export function OrganizationMemberHome({ workspaceName, networkMode, onOpenSettings }: { workspaceName: string; networkMode: NetworkMode; onOpenSettings: () => void }) {
  const utils = trpc.useUtils();
  const network = networkMode === "mainnet" ? "mainnet" : "chipnet";
  const payroll = trpc.finance.employeePayroll.useQuery({ network }, { retry: false });
  const updatePreference = trpc.finance.updateMyPayrollPreference.useMutation({ onSuccess: () => { void utils.finance.employeePayroll.invalidate({ network }); toast.success("Payroll payout preference saved"); }, onError: (error) => toast.error("Payroll payout preference not saved", { description: error.message }) });
  const employee = payroll.data?.employee;
  const payments = payroll.data?.payments ?? [];
  const payoutChoices = networkMode === "mainnet"
    ? [{ value: "BCH", label: "BCH · Bitcoin Cash Mainnet" }, { value: "PUSD", label: "PUSD · BCH Mainnet" }, { value: "AMUSDC", label: "USDC · Arc Mainnet" }]
    : [{ value: "BCH", label: "BCH · Chipnet" }, { value: "PUSD", label: "PUSD · Chipnet" }, { value: "MUSD", label: "MUSD · Chipnet" }, { value: "XLM", label: "XLM · Stellar Testnet" }, { value: "USDC", label: "USDC · Stellar Testnet" }, { value: "BSUSDC", label: "USDC · Base Sepolia" }, { value: "BSETH", label: "ETH · Base Sepolia" }, { value: "ARUSDC", label: "USDC · Arc Testnet" }];
  const selectedPayout = payoutChoices.find((choice) => choice.value === employee?.preferredAsset);
  return <div className="space-y-5">
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[.16em] text-orange-700">{workspaceName}</p><h2 className="mt-2 text-2xl font-bold">Your organization pay</h2><p className="mt-1 text-sm text-slate-600">Your payroll details and payments from this organization.</p></div><div className="grid h-11 w-11 place-items-center rounded-xl bg-orange-50 text-orange-700"><BriefcaseBusiness /></div></div>
      {payroll.isLoading ? <p className="mt-6 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Loading your payroll details…</p> : employee ? <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Summary label="Your role" value={employee.roleTitle || "Organization member"} />
        <Summary label="Monthly pay amount (USDT)" value={employee.monthlyDisplayAmount ? `${employee.monthlyDisplayAmount} USDT` : "Not set"} />
        <label className="rounded-xl bg-slate-50 p-4"><span className="block text-xs font-medium text-slate-500">Payroll payout asset</span><select value={payoutChoices.some((choice) => choice.value === employee.preferredAsset) ? employee.preferredAsset : ""} disabled={updatePreference.isPending} onChange={(event) => updatePreference.mutate({ asset: event.target.value as "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC" | "BSUSDC" | "BSETH" | "ARUSDC" | "BMUSDC" | "AMUSDC" })} className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900"><option value="" disabled>Choose a {networkMode} payout asset</option>{payoutChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><span className="mt-1 block text-xs text-slate-500">Choose where your organization sends your payroll.</span></label>
        <Summary label="Payroll status" value={employee.active ? "Active" : "Inactive"} />
      </div> : <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5"><p className="font-semibold">You haven’t been added to payroll yet</p><p className="mt-1 text-sm text-slate-600">When your organization adds you, your pay amount and payment history will appear here.</p></div>}
      {employee && <div className="mt-4 rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-sm font-semibold"><WalletCards size={16} />Your payout destination</p><p className="mt-1 text-xs text-slate-500">{selectedPayout?.label ?? `Choose a ${networkMode} payout asset`} · {String(selectedPayout ? employee.walletNetwork || "No matching destination saved" : "Not set")}</p></div><Button size="sm" variant="outline" onClick={onOpenSettings}>Manage my addresses</Button></div><code className="mt-3 block break-all text-xs text-slate-600">{employee.walletAddress || "Save a matching address in your profile settings."}</code>{networkMode === "testnet" && (employee.preferredAsset === "XLM" || employee.preferredAsset === "USDC") && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">Stellar payouts use one address for both XLM and USDC. To receive USDC, enable the Circle USDC trustline for your Stellar Testnet account first.</p>}{updatePreference.error ? <p className="mt-2 text-xs text-red-700">{updatePreference.error.message}</p> : null}</div>}
    </section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-6"><div className="mb-4"><h2 className="text-lg font-bold">Your payment history</h2><p className="mt-1 text-sm text-slate-500">Only payroll payments assigned to your account are shown.</p></div>{payments.length ? <div className="divide-y divide-slate-100">{payments.map((payment, index) => <article key={`${payment.period}-${payment.txid ?? index}`} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"><div><b className="text-sm">{payment.period}</b><p className="mt-1 text-xs text-slate-500">{payment.displayAmount} USDT requested → paid in {payrollAssetLabel(payment.asset, networkMode)}</p></div><div className="text-right"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${payment.status === "verified" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{payment.status}</span>{payment.txid && <code className="mt-2 block text-xs text-slate-500">TX {payment.txid.slice(0, 12)}…</code>}</div></article>)}</div> : !employee ? null : <p className="rounded-xl bg-slate-50 p-5 text-center text-sm text-slate-500">Your payroll payment history will appear here.</p>}</section>
  </div>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-2 text-base font-semibold text-slate-900">{value}</p></div>;
}

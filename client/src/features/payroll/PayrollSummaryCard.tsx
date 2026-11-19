import { Card } from "@/components/ui/card";

type PayrollSummaryCardProps = {
  memberCount: number;
  activeCount: number;
  monthlyBudget: number;
  onInvite: () => void;
};

export function PayrollSummaryCard({
  memberCount,
  activeCount,
  monthlyBudget,
  onInvite,
}: PayrollSummaryCardProps) {
  return (
    <Card className="relative overflow-hidden border border-orange-100 bg-gradient-to-br from-white via-white to-orange-50/60 text-slate-900">
      <div className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-orange-400/10 blur-3xl" />
      <div className="relative">
        <p className="text-xs font-bold uppercase tracking-[.16em] text-orange-800">
          Payroll management
        </p>
        <div className="mt-2 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-950">
              Team pay, organized.
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
              Manage staff, set monthly amounts in USDT, then approve one combined payout transaction for the whole run.
            </p>
          </div>
          <button
            onClick={onInvite}
            className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-orange-50"
          >
            Invite staff
          </button>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
            <p className="text-xs font-medium text-slate-600">Organization members</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">{memberCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
            <p className="text-xs font-medium text-slate-600">Active on payroll</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">{activeCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
            <p className="text-xs font-medium text-slate-600">Monthly payroll plan</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">
              {monthlyBudget.toFixed(2)}{" "}
              <span className="text-sm font-semibold text-slate-600">USDT</span>
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

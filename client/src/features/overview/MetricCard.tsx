import { Activity } from "lucide-react";
import type { ComponentType } from "react";

export function MetricCard({ title, value, detail, icon: Icon = Activity }: { title: string; value: string; detail: string; icon?: ComponentType<{ size?: number }> }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-6"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold text-slate-500">{title}</p><p className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{value}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div><div className="grid h-10 w-10 place-items-center rounded-xl bg-orange-50 text-orange-700"><Icon size={18} /></div></div></section>;
}

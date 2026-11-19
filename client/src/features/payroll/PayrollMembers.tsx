import { useEffect, useState, type FormEvent } from "react";
import { Check, CircleDollarSign, Pencil, Plus, UserMinus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

type Member = { userId: number; email: string; name: string | null; role: string; payrollEmployeeId: number | null; payrollActive: boolean; payrollRoleTitle: string | null; payrollAmount: string | null; payrollPreferredAsset: "BCH" | "PUSD" | "MUSD" | "XLM" | "USDC" | null };
type MemberDraft = { roleTitle: string; amount: string };

export function PayrollMembers({ members }: { members: Member[] }) {
  const utils = trpc.useUtils();
  const addMany = trpc.finance.addPayrollMembers.useMutation({ onSuccess: async () => { setSelected([]); await utils.finance.payrollData.invalidate(); toast.success("Staff added to payroll"); }, onError: (error) => toast.error("Could not add staff", { description: error.message }) });
  const update = trpc.finance.updatePayrollEnrollment.useMutation({ onSuccess: async () => { await utils.finance.payrollData.invalidate(); toast.success("Payroll details saved"); }, onError: (error) => toast.error("Payroll details not saved", { description: error.message }) });
  const [selected, setSelected] = useState<number[]>([]);
  const [drafts, setDrafts] = useState<Record<number, MemberDraft>>({});
  const [editing, setEditing] = useState<number[]>([]);
  const available = members.filter((member) => !member.payrollActive);
  const enrolled = members.filter((member) => member.payrollActive);
  const allSelected = available.length > 0 && available.every((member) => selected.includes(member.userId));

  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const member of members) next[member.userId] ??= { roleTitle: member.payrollRoleTitle || "Team member", amount: member.payrollAmount || "0.10" };
      return next;
    });
  }, [members]);
  const setField = (userId: number, field: keyof MemberDraft, value: string) => setDrafts((current) => ({ ...current, [userId]: { ...(current[userId] || { roleTitle: "Team member", amount: "0.10" }), [field]: value } }));
  const toggle = (id: number, checked: boolean) => setSelected((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  const add = (event: FormEvent) => {
    event.preventDefault();
    const payload = selected.map((userId) => ({ memberUserId: userId, ...(drafts[userId] || { roleTitle: "Team member", amount: "0.10" }) }));
    if (payload.length) addMany.mutate({ members: payload });
  };
  const saveMember = (member: Member) => {
    const draft = drafts[member.userId];
    if (!member.payrollEmployeeId || !draft) return;
    update.mutate({ employeeId: member.payrollEmployeeId, roleTitle: draft.roleTitle, amount: draft.amount });
    setEditing((current) => current.filter((id) => id !== member.userId));
  };
  const removeMember = (member: Member) => { if (member.payrollEmployeeId) update.mutate({ employeeId: member.payrollEmployeeId, active: false }); };

  return <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_12px_36px_rgba(15,23,42,.045)]">
    <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 via-white to-orange-50/60 p-5 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-start gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-orange-100 text-orange-700"><Users size={21} /></span><div><p className="text-xs font-bold uppercase tracking-[.16em] text-orange-700">Team compensation</p><h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950">Staff & payroll setup</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Set each person’s role and monthly USDT amount. Their receiving asset and address stay under their control in personal settings.</p></div></div><div className="flex gap-2"><span className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">{members.length} team members</span><span className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">{enrolled.length} on payroll</span></div></div></div>

    <div className="space-y-6 p-4 sm:p-6">
      <form onSubmit={add}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-base font-bold text-slate-950">Add team members</h3><p className="mt-1 text-sm text-slate-500">Select one or several people, then set their details before adding them.</p></div>{available.length > 0 && <Button type="button" variant="outline" onClick={() => setSelected(allSelected ? [] : available.map((member) => member.userId))}>{allSelected ? "Clear selection" : "Select all available"}</Button>}</div>
        {available.length > 0 ? <div className="space-y-3">{available.map((member) => { const draft = drafts[member.userId] || { roleTitle: member.payrollRoleTitle || "Team member", amount: member.payrollAmount || "0.10" }; return <article key={member.userId} className={`rounded-2xl border p-4 transition ${selected.includes(member.userId) ? "border-orange-300 bg-orange-50/50 ring-2 ring-orange-100" : "border-slate-200 bg-white hover:border-slate-300"}`}><div className="grid gap-4 lg:grid-cols-[minmax(200px,1fr)_minmax(170px,.75fr)_minmax(150px,.65fr)] lg:items-center"><label className="flex cursor-pointer items-start gap-3"><input type="checkbox" checked={selected.includes(member.userId)} onChange={(event) => toggle(member.userId, event.target.checked)} aria-label={`Select ${member.name || member.email} for payroll`} className="mt-1 h-4 w-4 accent-orange-600" /><span className="min-w-0"><b className="block text-sm text-slate-950">{member.name || member.email}</b><small className="mt-1 block break-all text-xs text-slate-500">{member.email}</small></span></label><label className="text-xs font-semibold text-slate-600">Role or team title<input required value={draft.roleTitle} onChange={(event) => setField(member.userId, "roleTitle", event.target.value)} placeholder="e.g. Designer" className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-orange-400" /></label><label className="text-xs font-semibold text-slate-600">Monthly pay<input required inputMode="decimal" value={draft.amount} onChange={(event) => setField(member.userId, "amount", event.target.value)} placeholder="0.00 USDT" className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-orange-400" /><span className="mt-1 block font-normal text-slate-500">USDT</span></label></div></article>; })}</div> : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center"><p className="text-sm font-semibold text-slate-800">Everyone is on payroll</p><p className="mt-1 text-xs text-slate-500">New organization members will appear here after they accept an invitation.</p></div>}
        {selected.length > 0 && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-orange-200 bg-gradient-to-r from-orange-50 to-white px-4 py-3.5"><div><p className="text-sm font-bold text-slate-950">{selected.length} selected</p><p className="mt-0.5 text-xs text-slate-600">Monthly amounts are set in USDT.</p></div><Button disabled={addMany.isPending || selected.some((id) => !drafts[id]?.roleTitle.trim() || !/^\d+(\.\d{1,2})?$/.test(drafts[id]?.amount || ""))} className="gap-2 bg-orange-700 text-white hover:bg-orange-800"><Plus size={16} />{addMany.isPending ? "Adding staff…" : `Add ${selected.length} to payroll`}</Button></div>}
      </form>

      <div className="border-t border-slate-100 pt-6"><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h3 className="text-base font-bold text-slate-950">Current payroll members</h3><p className="mt-1 text-sm text-slate-500">Edit monthly amounts or remove a person from future runs.</p></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{enrolled.length} active</span></div>
        {enrolled.length ? <div className="grid gap-3 xl:grid-cols-2">{enrolled.map((member) => { const draft = drafts[member.userId] || { roleTitle: member.payrollRoleTitle || "Team member", amount: member.payrollAmount || "0.10" }; const isEditing = editing.includes(member.userId); return <article key={member.userId} className="rounded-2xl border border-slate-200 bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="text-sm text-slate-950">{member.name || member.email}</b><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-800">Active</span></div><p className="mt-1 break-all text-xs text-slate-500">{member.email}</p></div><div className="flex gap-2">{isEditing ? <><Button type="button" size="sm" disabled={update.isPending} onClick={() => saveMember(member)} className="gap-1.5 bg-slate-900 text-white"><Check size={14} />Save</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing((current) => current.filter((id) => id !== member.userId))}>Cancel</Button></> : <><Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing((current) => [...current, member.userId])}><Pencil size={14} />Edit</Button><Button type="button" size="sm" variant="outline" className="gap-1.5 text-red-700 hover:text-red-800" disabled={update.isPending} onClick={() => removeMember(member)}><UserMinus size={14} />Remove</Button></>}</div></div>
          {isEditing ? <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Role or team title<input required value={draft.roleTitle} onChange={(event) => setField(member.userId, "roleTitle", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label><label className="text-xs font-semibold text-slate-600">Monthly pay · USDT<input required inputMode="decimal" value={draft.amount} onChange={(event) => setField(member.userId, "amount", event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-900" /></label></div> : <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 px-3.5 py-3"><div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Role</p><p className="mt-0.5 text-sm font-semibold text-slate-900">{member.payrollRoleTitle || "Team member"}</p></div><div className="flex items-center gap-2 text-right"><span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-orange-700"><CircleDollarSign size={17} /></span><div><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Monthly amount · {member.payrollPreferredAsset || "BCH"} payout</p><p className="mt-0.5 text-sm font-bold text-slate-950">{member.payrollAmount || "—"} USDT</p></div></div></div>}
        </article>; })}</div> : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center"><p className="text-sm font-semibold text-slate-800">No one added yet</p><p className="mt-1 text-xs text-slate-500">Select team members above and add them to payroll.</p></div>}
      </div>
    </div>
  </section>;
}

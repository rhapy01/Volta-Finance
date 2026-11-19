import { useState, type FormEvent } from "react";
import { Check, CircleHelp, Copy, Globe2, Plus, UserRound, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";

type Destination = { id: number; label: string; address: string; asset: string; network: string };
type StellarDestination = { id: number; label: string; address: string; isDefault: boolean };
type AddDestination = { label: string; address: string; asset: "BCH" | "TOKEN"; network: "chipnet"; makeDefault: false };

export function ProfileSettings({
  destinations,
  stellarDestinations,
  name,
  email,
  isOrganization = false,
  organizationName,
  addDestinationPending,
  addStellarPending,
  onAddDestination,
  onAddStellarDestination,
  onSetDefaultStellarDestination,
}: {
  destinations: Destination[];
  stellarDestinations: StellarDestination[];
  name: string;
  email: string;
  isOrganization?: boolean;
  organizationName?: string;
  addDestinationPending: boolean;
  addStellarPending: boolean;
  onAddDestination: (input: AddDestination) => Promise<unknown>;
  onAddStellarDestination: (input: { label: string; address: string; makeDefault: boolean }) => Promise<unknown>;
  onSetDefaultStellarDestination: (destinationId: number) => Promise<unknown>;
}) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [asset, setAsset] = useState<"BCH" | "TOKEN">("BCH");
  const [stellarLabel, setStellarLabel] = useState("");
  const [stellarAddress, setStellarAddress] = useState("");
  const [copied, setCopied] = useState("");

  const submitDestination = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onAddDestination({ label, address, asset, network: "chipnet", makeDefault: false });
      setLabel("");
      setAddress("");
    } catch { /* Mutation error is reported by the parent screen. */ }
  };
  const submitStellarDestination = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await onAddStellarDestination({ label: stellarLabel, address: stellarAddress, makeDefault: true });
      setStellarLabel("");
      setStellarAddress("");
    } catch { /* Mutation error is reported by the parent screen. */ }
  };
  const copyAddress = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? "" : current), 1600);
    } catch { setCopied(""); }
  };

  const bchCount = destinations.filter((destination) => destination.asset === "BCH").length;
  const tokenCount = destinations.filter((destination) => destination.asset !== "BCH").length;

  return <div className="space-y-5">
    <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-white via-white to-orange-50 p-5 shadow-[0_12px_36px_rgba(15,23,42,.045)] sm:p-7">
      <div className="pointer-events-none absolute -right-12 -top-16 h-56 w-56 rounded-full bg-orange-200/40 blur-3xl" />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-4"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-orange-100 text-orange-700"><WalletCards size={23} /></div><div><p className="text-xs font-bold uppercase tracking-[.16em] text-orange-700">Your payout profile</p><h2 className="mt-1 text-xl font-bold tracking-tight text-slate-950">Payment destinations</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Save each receiving address once. Invoices and organization payroll use the matching address from your personal profile.</p></div></div>
        <div className="flex shrink-0 flex-wrap gap-2"><span className="rounded-full border border-orange-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-orange-800">Bitcoin Cash · Chipnet</span><span className="rounded-full border border-violet-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-violet-800">Stellar · Testnet</span></div>
      </div>
      <div className="relative mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-white bg-white/90 p-4 shadow-sm"><p className="text-xs font-semibold text-slate-500">Saved destinations</p><p className="mt-1 text-2xl font-bold text-slate-950">{destinations.length + stellarDestinations.length}</p><p className="mt-1 text-xs text-slate-500">Available to your workflows</p></div>
        <div className="rounded-2xl border border-white bg-white/90 p-4 shadow-sm"><p className="text-xs font-semibold text-slate-500">BCH addresses</p><p className="mt-1 text-2xl font-bold text-slate-950">{bchCount}</p><p className="mt-1 text-xs text-slate-500">Native BCH payments</p></div>
        <div className="rounded-2xl border border-white bg-white/90 p-4 shadow-sm"><p className="text-xs font-semibold text-slate-500">CashTokens addresses</p><p className="mt-1 text-2xl font-bold text-slate-950">{tokenCount}</p><p className="mt-1 text-xs text-slate-500">PUSD and MUSD delivery</p></div>
        <div className="rounded-2xl border border-white bg-white/90 p-4 shadow-sm"><p className="text-xs font-semibold text-slate-500">Stellar addresses</p><p className="mt-1 text-2xl font-bold text-slate-950">{stellarDestinations.length}</p><p className="mt-1 text-xs text-slate-500">XLM and USDC delivery</p></div>
      </div>
    </section>

    {isOrganization && <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3.5 text-sm text-sky-950"><CircleHelp size={18} className="mt-0.5 shrink-0 text-sky-700" /><p><b>{organizationName || "Organization"} uses your profile destinations.</b> Staff payout addresses and preferred assets are managed by each staff member in their personal profile.</p></div>}

    <div className="grid items-start gap-5 xl:grid-cols-[1.2fr_.8fr]">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(22,34,52,.035)]">
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-orange-50 text-orange-700"><WalletCards size={19} /></span><div><h3 className="font-bold text-slate-950">Bitcoin Cash destinations</h3><p className="mt-0.5 text-xs text-slate-500">BCH and CashTokens use separate receiving addresses.</p></div></div></div>
        <div className="space-y-3 p-4 sm:p-5">
          {destinations.map((destination) => {
            const isBch = destination.asset === "BCH";
            const copyId = `bch-${destination.id}`;
            return <article key={destination.id} className={`rounded-2xl border p-4 ${isBch ? "border-orange-100 bg-orange-50/40" : "border-violet-100 bg-violet-50/40"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><b className="text-sm text-slate-950">{destination.label}</b><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${isBch ? "bg-orange-100 text-orange-800" : "bg-violet-100 text-violet-800"}`}>{isBch ? "BCH" : "CashTokens"}</span></div><p className="mt-1 text-xs text-slate-500">{isBch ? "Bitcoin Cash" : "PUSD and MUSD"} <span className="mx-1">·</span> {destination.network}</p></div><Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 bg-white" onClick={() => void copyAddress(copyId, destination.address)}>{copied === copyId ? <Check size={14} /> : <Copy size={14} />}{copied === copyId ? "Copied" : "Copy"}</Button></div>
              <code className="mt-3 block break-all rounded-xl border border-white/80 bg-white/80 px-3 py-2.5 text-xs leading-5 text-slate-700">{destination.address}</code>
            </article>;
          })}
          {!destinations.length && <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-7 text-center"><p className="text-sm font-semibold text-slate-800">No BCH destinations saved</p><p className="mt-1 text-xs text-slate-500">Add a BCH address, a CashTokens address, or both below.</p></div>}
        </div>
        <form className="border-t border-slate-100 bg-slate-50/70 p-4 sm:p-5" onSubmit={submitDestination}>
          <div className="mb-4"><h4 className="text-sm font-bold text-slate-950">Add a destination</h4><p className="mt-1 text-xs text-slate-500">Choose the address format that matches the asset you want to receive.</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600">Address label<input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Main BCH wallet" className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal outline-none focus:border-orange-400 focus:ring-4 focus:ring-orange-100" /></label>
            <label className="text-xs font-semibold text-slate-600">Receiving asset<select value={asset} onChange={(event) => setAsset(event.target.value as typeof asset)} className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal outline-none focus:border-orange-400"><option value="BCH">BCH · native</option><option value="TOKEN">CashTokens · PUSD / MUSD</option></select></label>
            <label className="text-xs font-semibold text-slate-600 sm:col-span-2">Chipnet address<input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder={asset === "BCH" ? "bchtest:q…" : "bchtest:z…"} className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal outline-none focus:border-orange-400 focus:ring-4 focus:ring-orange-100" /><span className="mt-1.5 block font-normal text-slate-500">{asset === "BCH" ? "Use a BCH address for native BCH payments." : "PUSD and MUSD require a token-aware CashTokens address."}</span></label>
          </div>
          <Button disabled={addDestinationPending} className="mt-4 gap-2 bg-orange-700 text-white hover:bg-orange-800"><Plus size={16} />{addDestinationPending ? "Saving address…" : "Save BCH destination"}</Button>
        </form>
      </section>

      <div className="space-y-5">
        <section className="overflow-hidden rounded-3xl border border-violet-200 bg-white shadow-[0_8px_24px_rgba(22,34,52,.035)]">
          <div className="border-b border-violet-100 bg-gradient-to-r from-violet-50 to-white px-5 py-5 sm:px-6"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-800"><Globe2 size={19} /></span><div><h3 className="font-bold text-slate-950">Stellar Testnet</h3><p className="mt-0.5 text-xs text-slate-500">One public address works for XLM and USDC.</p></div></div></div>
          <div className="space-y-3 p-4 sm:p-5">
            {stellarDestinations.map((destination) => {
              const copyId = `stellar-${destination.id}`;
              return <article key={destination.id} className="rounded-2xl border border-violet-100 bg-violet-50/40 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><b className="text-sm text-slate-950">{destination.label}</b><p className="mt-1 text-xs text-slate-500">XLM or USDC receiving address · Testnet{destination.isDefault ? " · Payroll destination" : ""}</p></div><div className="flex gap-2">{!destination.isDefault && <Button type="button" size="sm" variant="outline" className="h-8 bg-white" onClick={() => void onSetDefaultStellarDestination(destination.id)}>Use for payroll</Button>}<Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 bg-white" onClick={() => void copyAddress(copyId, destination.address)}>{copied === copyId ? <Check size={14} /> : <Copy size={14} />}{copied === copyId ? "Copied" : "Copy"}</Button></div></div><code className="mt-3 block break-all rounded-xl border border-white bg-white/80 px-3 py-2.5 text-xs leading-5 text-slate-700">{destination.address}</code></article>;
            })}
            {!stellarDestinations.length && <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50/40 px-4 py-6 text-center"><p className="text-sm font-semibold text-slate-800">No Stellar address saved</p><p className="mt-1 text-xs text-slate-500">Add one public Testnet address to receive XLM or USDC.</p></div>}
            <form className="space-y-3 rounded-2xl bg-slate-50 p-4" onSubmit={submitStellarDestination}><h4 className="text-sm font-bold text-slate-950">Add a Stellar address</h4><label className="block text-xs font-semibold text-slate-600">Address label<input required value={stellarLabel} onChange={(event) => setStellarLabel(event.target.value)} placeholder="e.g. Stellar wallet" className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal outline-none focus:border-violet-400" /></label><label className="block text-xs font-semibold text-slate-600">Public address<input required minLength={56} maxLength={56} value={stellarAddress} onChange={(event) => setStellarAddress(event.target.value)} placeholder="G… Stellar public address" className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-normal outline-none focus:border-violet-400" /><span className="mt-1.5 block font-normal text-slate-500">A public address begins with G. Never enter a secret key here.</span></label><Button disabled={addStellarPending} variant="outline" className="gap-2 bg-white"><Plus size={16} />{addStellarPending ? "Saving address…" : "Save Stellar address"}</Button></form>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_8px_24px_rgba(22,34,52,.035)] sm:p-6"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700"><UserRound size={19} /></span><div><h3 className="font-bold text-slate-950">Account details</h3><p className="mt-0.5 text-xs text-slate-500">Signed in to Volta Finance as</p></div></div><div className="mt-4 rounded-2xl bg-slate-50 p-4"><p className="font-semibold text-slate-900">{name || "Volta Finance user"}</p><p className="mt-1 text-sm text-slate-600">{email}</p>{isOrganization && organizationName && <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500">Current workspace <b className="text-slate-800">{organizationName}</b></p>}</div><p className="mt-4 flex gap-2 text-xs leading-5 text-slate-500"><CircleHelp size={15} className="mt-0.5 shrink-0" />These are public receiving addresses. Wallet connection and transaction signing are separate.</p></section>
      </div>
    </div>
  </div>;
}

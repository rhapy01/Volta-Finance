import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { NetworkMode } from "@/lib/networkMode";

type EvmDestination = { id: number; label: string; network: "base-sepolia" | "arc-testnet" | "base-mainnet" | "arc-mainnet"; asset: "USDC" | "ETH"; address: string; isDefault: boolean; isArchived: boolean };
type EvmDestinationInput = { label: string; network: "base-sepolia" | "arc-testnet" | "base-mainnet" | "arc-mainnet"; asset: "USDC" | "ETH"; address: string; makeDefault: boolean };

export function EvmDestinations({ destinations, pending, networkMode, onAdd, onSetDefault, onDelete }: {
  destinations: EvmDestination[];
  pending: boolean;
  networkMode: NetworkMode;
  onAdd: (input: EvmDestinationInput) => Promise<unknown>;
  onSetDefault: (destinationId: number) => Promise<unknown>;
  onDelete: (destinationId: number) => Promise<unknown>;
}) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState<EvmDestinationInput["network"]>(networkMode === "mainnet" ? "arc-mainnet" : "base-sepolia");
  const [asset, setAsset] = useState<EvmDestinationInput["asset"]>("USDC");
  const [error, setError] = useState("");
  useEffect(() => { setNetwork(networkMode === "mainnet" ? "arc-mainnet" : "base-sepolia"); setAsset("USDC"); }, [networkMode]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { await onAdd({ label, address: address.trim(), network, asset, makeDefault: true }); setLabel(""); setAddress(""); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save this address."); }
  };
  const choices: EvmDestinationInput["network"][] = networkMode === "mainnet" ? ["arc-mainnet"] : ["base-sepolia", "arc-testnet"];
  const visibleDestinations = destinations.filter((destination) => choices.includes(destination.network));
  const changeNetwork = (value: EvmDestinationInput["network"]) => { setNetwork(value); if (value !== "base-sepolia" && asset === "ETH") setAsset("USDC"); };
  return <section className="rounded-2xl border border-cyan-200 bg-white p-5 shadow-sm sm:p-6">
    <div><p className="text-xs font-bold uppercase tracking-[.14em] text-cyan-800">{networkMode === "mainnet" ? "Mainnet" : "Testnet"}</p><h3 className="mt-1 text-lg font-bold text-slate-950">EVM receiving addresses</h3><p className="mt-1 text-sm leading-6 text-slate-600">EVM accounts use the same 0x address across supported networks.{networkMode === "testnet" ? " Base Sepolia also supports ETH." : " Save your Arc Mainnet USDC address here."}</p></div>
    <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-slate-700">Network<select value={network} onChange={(event) => changeNetwork(event.target.value as EvmDestinationInput["network"])} className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm">{choices.map((choice) => <option key={choice} value={choice}>{({ "base-mainnet": "Base Mainnet", "arc-mainnet": "Arc Mainnet", "base-sepolia": "Base Sepolia", "arc-testnet": "Arc Testnet" })[choice]}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-700">Receive asset<select value={asset} onChange={(event) => setAsset(event.target.value as EvmDestinationInput["asset"])} className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"><option value="USDC">USDC</option>{network === "base-sepolia" && <option value="ETH">ETH</option>}</select></label>
      <label className="text-xs font-semibold text-slate-700">Label<input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} placeholder={networkMode === "mainnet" ? "My Arc wallet" : "My Base wallet"} className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" /></label>
      <label className="text-xs font-semibold text-slate-700">0x receiving address<input value={address} onChange={(event) => setAddress(event.target.value)} required pattern="0x[0-9a-fA-F]{40}" placeholder="0x…" className="mt-1 block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2.5 font-mono text-sm" /></label>
      <div className="sm:col-span-2"><Button type="submit" disabled={pending} className="bg-slate-900 text-white">{pending ? "Saving…" : "Save EVM address"}</Button>{error && <p role="alert" className="mt-2 text-sm font-medium text-red-700">{error}</p>}</div>
    </form>
    <div className="mt-4 space-y-2">{visibleDestinations.map((destination) => <article key={destination.id} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><p className="text-sm font-semibold text-slate-900">{destination.label} <span className="text-slate-500">· {destination.asset} on {({ "base-sepolia": "Base Sepolia", "arc-testnet": "Arc Testnet", "base-mainnet": "Base Mainnet", "arc-mainnet": "Arc Mainnet" })[destination.network]}</span>{destination.isArchived && <span className="ml-2 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">Archived</span>}</p><code className="mt-1 block break-all text-xs text-slate-600">{destination.address}</code></div><div className="flex shrink-0 items-center gap-2">{destination.isDefault ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">Default</span> : <Button size="sm" variant="outline" onClick={() => void onSetDefault(destination.id)}>Make default</Button>}<Button size="sm" variant="outline" onClick={() => void onDelete(destination.id)}>Remove</Button></div></div></article>)}{!visibleDestinations.length && <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-600">No addresses saved for {networkMode} yet.</p>}</div>
  </section>;
}

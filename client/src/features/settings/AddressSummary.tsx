type Destination = { id: number; asset: string; network: string; label: string; address: string };
type StellarDestination = { id: number; label: string; address: string };

export function AddressSummary({ destinations, stellar }: { destinations: Destination[]; stellar: StellarDestination[] }) {
  return <div className="space-y-2">{[...destinations.slice(0, 3).map((item) => ({ ...item, kind: item.asset === "BCH" ? "BCH" : "CashTokens" })), ...stellar.slice(0, 1).map((item) => ({ ...item, network: "Stellar Testnet", kind: "XLM" }))].map((item) => <div key={`${item.kind}-${item.id}`} className="rounded-xl bg-slate-50 px-3 py-2.5"><div className="flex justify-between text-xs"><b>{item.kind}</b><span className="text-slate-500">{item.network}</span></div><code className="mt-1 block break-all text-[10px] text-slate-500">{item.address}</code></div>)}</div>;
}

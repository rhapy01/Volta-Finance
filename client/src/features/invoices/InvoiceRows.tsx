import { Button } from "@/components/ui/button";

export type InvoiceRow = {
  id: string;
  client: string;
  amount: string;
  requestAsset: string;
  asset: string;
  deliveryAsset?: string | null;
  status: string;
  due: string;
  paymentTxid?: string | null;
  receivingAddress?: string | null;
};

export function InvoiceRows({ invoices, empty, onSend, onView, onReview, busy = false }: {
  invoices: InvoiceRow[];
  empty: string;
  onSend?: (id: string) => void;
  onView?: (id: string) => void;
  onReview?: (id: string, decision: "accept" | "decline") => void;
  busy?: boolean;
}) {
  if (!invoices.length) return <div className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">{empty}</div>;
  return <div className="divide-y divide-slate-100">{invoices.map((invoice) => <article key={invoice.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b className="truncate text-sm">{invoice.client || "Invoice"}</b><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${invoice.status === "Paid" ? "bg-emerald-50 text-emerald-700" : "bg-orange-50 text-orange-800"}`}>{invoice.status}</span></div><p className="mt-1 text-xs text-slate-500">{invoice.id} · {invoice.amount} {invoice.requestAsset} · recipient receives {invoice.deliveryAsset || invoice.asset}{invoice.due ? ` · due ${invoice.due}` : ""}</p>{invoice.paymentTxid && <code className="mt-1 block text-[10px] text-slate-500">TX {compact(invoice.paymentTxid)}</code>}</div><div className="flex shrink-0 flex-wrap gap-2">{onView && <Button size="sm" variant="outline" onClick={() => onView(invoice.id)}>View invoice</Button>}{invoice.status === "Draft" && onSend && <Button size="sm" onClick={() => onSend(invoice.id)} className="bg-orange-600 text-white">Send</Button>}{onReview && invoice.status === "Needs review" && <><Button size="sm" variant="outline" disabled={busy} onClick={() => onReview(invoice.id, "decline")}>Decline</Button><Button size="sm" disabled={busy} onClick={() => onReview(invoice.id, "accept")}>Accept</Button></>}</div></article>)}</div>;
}

function compact(value?: string | null) { if (!value) return "—"; return value.length > 24 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value; }

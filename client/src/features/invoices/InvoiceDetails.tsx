import { Button } from "@/components/ui/button";
import { WorkspaceModal } from "@/features/workspace/WorkspaceModal";

export type InvoiceDetailRecord = {
  id: string; client: string; description?: string | null; amount: string; requestAsset: string; asset: string;
  deliveryAsset?: string | null; deliveryNetwork?: string | null; due: string; status: string;
  senderName?: string | null; senderEmail?: string | null; recipientEmail?: string | null;
  receivingAddress?: string | null; network?: string | null; paymentTxid?: string | null;
  payerAsset?: string | null; payerAmountAtomic?: string | null; hasReceipt?: boolean;
};

export function InvoiceDetails({ invoice, onClose }: { invoice: InvoiceDetailRecord; onClose: () => void }) {
  return <WorkspaceModal title={invoice.client || "Invoice"} onClose={onClose}>
    <p className="mb-5 text-sm text-slate-500">{invoice.id} · {invoice.status}</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <Info label="Requested amount" value={`${invoice.amount} ${invoice.requestAsset}`} />
      <Info label="Recipient receives" value={invoice.deliveryAsset || invoice.asset} />
      <Info label="Due date" value={invoice.due || "—"} />
      <Info label="Network" value={invoice.deliveryNetwork || invoice.network || "—"} />
      <Info label="From" value={invoice.senderName || invoice.client || "—"} />
      <Info label="Sender email" value={invoice.senderEmail || "—"} />
      {invoice.payerAsset && <Info label="Paid with" value={`${invoice.payerAmountAtomic || ""} ${invoice.payerAsset}`} />}
      {invoice.paymentTxid && <Info label="Transaction" value={invoice.paymentTxid} />}
    </div>
    {invoice.description && <div className="mt-4 rounded-xl bg-slate-50 p-4"><small className="font-semibold text-slate-500">Description</small><p className="mt-1 text-sm">{invoice.description}</p></div>}
    {invoice.receivingAddress && <div className="mt-4 rounded-xl border border-slate-200 p-4"><small className="font-semibold text-slate-500">Invoice receiving address</small><code className="mt-2 block break-all text-xs leading-5">{invoice.receivingAddress}</code></div>}
    {invoice.hasReceipt && <p className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">A verified payment receipt is attached to this invoice.</p>}
    <div className="mt-5 flex justify-end"><Button variant="outline" onClick={onClose}>Close</Button></div>
  </WorkspaceModal>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-slate-50 p-3"><small className="font-semibold text-slate-500">{label}</small><p className="mt-1 break-all text-sm">{value}</p></div>; }

import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, FilePlus2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { cashAddressToLockingBytecode } from "@bitauth/libauth";

type Asset = "BCH" | "PUSD" | "MUSD";

export default function SubmitInvoice() {
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientType, setRecipientType] = useState<"personal" | "organization">("personal");
  const [recipientWorkspaceId, setRecipientWorkspaceId] = useState<number | undefined>();
  const [senderName, setSenderName] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const requestAsset = "USDT" as const;
  const [asset, setAsset] = useState<Asset>("BCH");
  const [dueDate, setDueDate] = useState("");
  const [receivingAddress, setReceivingAddress] = useState("");
  const [step, setStep] = useState<"compose" | "delivery">("compose");
  const [submitted, setSubmitted] = useState(false);
  const submit = trpc.finance.submitExternalInvoice.useMutation({ onSuccess: () => setSubmitted(true) });

  const normalizedEmail = recipientEmail.trim().toLowerCase();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const recipientTargets = trpc.finance.invoiceRecipientTargets.useQuery({ email: normalizedEmail }, { enabled: step === "delivery" && validEmail, retry: false });
  const organizations = recipientTargets.data?.organizations ?? [];
  useEffect(() => {
    if (recipientType === "organization") setRecipientWorkspaceId(organizations.length === 1 ? organizations[0].id : undefined);
    else setRecipientWorkspaceId(undefined);
  }, [recipientType, normalizedEmail, organizations]);

  const decodedAddress = receivingAddress ? cashAddressToLockingBytecode(receivingAddress) : null;
  const decodedAddressObject = decodedAddress && typeof decodedAddress !== "string" ? decodedAddress : null;
  const addressError = decodedAddress && !decodedAddressObject
    ? "Enter a valid Bitcoin Cash receiving address."
    : decodedAddressObject && decodedAddressObject.prefix !== "bchtest"
      ? "Use a BCH testnet (Chipnet) address starting with bchtest:."
      : asset !== "BCH" && decodedAddressObject && !decodedAddressObject.tokenSupport
        ? `This ${asset} invoice needs a CashTokens-aware receiving address.`
        : null;
  const validAddress = Boolean(decodedAddressObject && !addressError);
  const canSend = Boolean(
    recipientTargets.data?.registered &&
    (recipientType === "personal"
      ? recipientTargets.data.personal
      : organizations.some((organization) => organization.id === recipientWorkspaceId))
  );

  const sendInvoice = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate({
      recipientEmail: normalizedEmail,
      recipientType,
      recipientWorkspaceId,
      senderName,
      senderEmail,
      description,
      amount,
      requestAsset,
      asset,
      dueDate,
      receivingAddress,
    });
  };

  return <main className="guest-invoice-page">
    <Link className="auth-back guest-invoice-back" href="/"><ArrowLeft size={15} /> Back to Voltra Finance</Link>
    <div className="guest-invoice-shell">
      <header className="guest-invoice-heading">
        <div className="guest-invoice-brand"><img src="/voltralogo.png" alt="" /><span>Voltra Finance</span></div>
        <span className="landing-eyebrow">Secure invoice inbox</span>
        <h1>{submitted ? "Invoice sent for review." : step === "compose" ? "Create your invoice." : "Send your invoice."}</h1>
        <p>{submitted
          ? "The invoice was delivered to the selected Volta Finance inbox for review."
          : step === "compose"
            ? "Enter the invoice and its payment destination first. No document upload or download is needed."
            : "Now choose the recipient’s email and where this invoice should arrive."}</p>
      </header>

      <section className="guest-invoice-card">
        {submitted ? <div className="guest-invoice-success">
          <div className="guest-success-icon"><CheckCircle2 size={24} /></div>
          <h2>Sent to {recipientType === "organization" ? organizations.find((organization) => organization.id === recipientWorkspaceId)?.name || "the organization" : "the personal account"}</h2>
          <p>The registered recipient will review the sender details, amount, asset, and payment address before accepting it.</p>
          <div className="guest-invoice-summary"><strong>{description}</strong><span>{amount} {requestAsset} · recipient receives {asset} · due {dueDate}</span><small>Payment address</small><code>{receivingAddress}</code><small>Sent to</small><code>{normalizedEmail}</code></div>
        </div> : step === "compose" ? <form className="auth-form guest-invoice-form" onSubmit={(event) => { event.preventDefault(); setStep("delivery"); }}>
          <div className="guest-step-label"><span>1</span> Invoice details</div>
          <label>Your name or business<input required value={senderName} onChange={(event) => setSenderName(event.target.value)} maxLength={200} placeholder="Name or business name" /></label>
          <label>Your email<input required type="email" value={senderEmail} onChange={(event) => setSenderEmail(event.target.value)} placeholder="you@example.com" /></label>
          <label className="guest-field-wide">Invoice description<input required value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="e.g. Design services for November" /></label>
          <label>Requested amount<div className="input-with-suffix"><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /><span>USDT</span></div></label>
          <label>Will receive<select value={asset} onChange={(event) => setAsset(event.target.value as Asset)}><option>BCH</option><option>PUSD</option><option>MUSD</option></select></label>
          <label>Due date<input required value={dueDate} onChange={(event) => setDueDate(event.target.value)} placeholder="e.g. 30 Nov 2026" /></label>
          <label className="guest-field-wide">Your payment receiving address<input required value={receivingAddress} onChange={(event) => setReceivingAddress(event.target.value)} placeholder={asset === "BCH" ? "bchtest:q…" : "CashTokens-aware bchtest:z…"} /><small>This is the testnet address the recipient will pay. For PUSD or MUSD, use a CashTokens-aware testnet address.</small></label>
          <div className="modal-boundary guest-field-wide"><ShieldCheck size={17} /><span>Invoice requests {amount || "—"} {requestAsset}; the recipient receives {asset} at <code>{receivingAddress || "the address above"}</code>.</span></div>
          {addressError && <div className="modal-error guest-field-wide">{addressError}</div>}
          <div className="modal-boundary guest-field-wide"><ShieldCheck size={17} /><span>This is a manual in-platform invoice. The invoice is created and delivered only after you enter the recipient on the next step.</span></div>
          <Button className="guest-field-wide" type="submit" disabled={!validAddress}><FilePlus2 size={16} /> Continue to send <ArrowRight size={16} /></Button>
        </form> : <div className="guest-delivery-step">
          <div className="guest-step-label"><span>2</span> Recipient and delivery</div>
          <div className="guest-invoice-summary"><strong>{description}</strong><span>{amount} {requestAsset} · recipient receives {asset} · due {dueDate}</span><small>Payment address</small><code>{receivingAddress}</code></div>
          <form className="auth-form guest-invoice-send-form" onSubmit={sendInvoice}>
            <label className="guest-field-wide">Recipient’s registered Volta Finance email<input autoFocus required type="email" value={recipientEmail} onChange={(event) => { setRecipientEmail(event.target.value); setRecipientType("personal"); }} placeholder="recipient@example.com" /></label>
            {validEmail && recipientTargets.isLoading && <p className="guest-recipient-status guest-field-wide">Checking recipient…</p>}
            {validEmail && recipientTargets.data?.registered && <>
              <label>Send to<select value={recipientType} onChange={(event) => setRecipientType(event.target.value as "personal" | "organization")}>
                {recipientTargets.data.personal && <option value="personal">Personal account</option>}
                {organizations.length > 0 && <option value="organization">Organization</option>}
              </select></label>
              {recipientType === "organization" && organizations.length > 1 && <label>Organization<select required value={recipientWorkspaceId ?? ""} onChange={(event) => setRecipientWorkspaceId(event.target.value ? Number(event.target.value) : undefined)}><option value="">Choose an organization</option>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>}
              {recipientType === "organization" && organizations.length === 1 && <div className="guest-recipient-note">Organization · {organizations[0].name}</div>}
              <p className="guest-recipient-status guest-field-wide">Organization delivery is available only when this email belongs to the organization owner. Staff emails cannot route invoices to the organization.</p>
            </>}
            {validEmail && recipientTargets.data && !recipientTargets.data.registered && <div className="modal-error guest-field-wide">This email is not registered with Volta Finance. Guest invoices can only be sent to a registered person or organization owner.</div>}
            {validEmail && recipientTargets.data?.registered && !recipientTargets.data.personal && organizations.length === 0 && <div className="modal-error guest-field-wide">This email does not have an eligible personal or organization inbox.</div>}
            {submit.error && <div className="modal-error guest-field-wide">{submit.error.message}</div>}
            <div className="guest-delivery-actions guest-field-wide"><Button type="button" variant="outline" onClick={() => setStep("compose")}><ArrowLeft size={15} /> Back to invoice</Button><Button type="submit" disabled={submit.isPending || !canSend}>{submit.isPending ? "Sending invoice…" : <><Send size={16} /> Send invoice</>}</Button></div>
          </form>
        </div>}
      </section>
    </div>
  </main>;
}

import crypto from "node:crypto";

const baseUrl = () => process.env.PAYTACA_PAYMENT_HUB_BASE_URL || "https://paymenthub.paytaca.com";

export function isPaymentHubConfigured() {
  return Boolean(process.env.PAYTACA_PAYMENT_HUB_API_KEY && process.env.PAYTACA_PAYMENT_HUB_STORE_ID);
}

export async function createPaymentHubInvoice(input: { amount: string; asset: "BCH" | "PUSD" | "MUSD"; memo: string; expiryMinutes?: number }) {
  const apiKey = process.env.PAYTACA_PAYMENT_HUB_API_KEY;
  const storeId = process.env.PAYTACA_PAYMENT_HUB_STORE_ID;
  if (!apiKey || !storeId) throw new Error("Paytaca Payment Hub store configuration is not available");

  const response = await fetch(`${baseUrl()}/api/v1/invoices/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Api-Key ${apiKey}` },
    body: JSON.stringify({ amount: input.amount, currency: input.asset, memo: input.memo, expiry_minutes: input.expiryMinutes ?? 60, store: storeId }),
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(`Paytaca Payment Hub rejected the invoice (${response.status})`);
  if (!body || typeof body.invoice_id !== "string" || typeof body.payment_url !== "string") throw new Error("Paytaca Payment Hub returned an incomplete invoice");
  return { externalInvoiceId: body.invoice_id, paymentUrl: body.payment_url, status: typeof body.status === "string" ? body.status : "PENDING" };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifyPaymentHubWebhook(payload: unknown, signatureBase64: string | undefined, publicKeyPem: string | undefined) {
  if (!signatureBase64 || !publicKeyPem) return false;
  try {
    return crypto.verify(null, Buffer.from(stableJson(payload)), crypto.createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

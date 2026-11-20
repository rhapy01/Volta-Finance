import "dotenv/config";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { applyPaymentHubWebhook } from "../db";
import { verifyPaymentHubWebhook } from "../integrations/paymentHub";

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https:");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: false, parameterLimit: 100 }));

const trpcHandler = createExpressMiddleware({ router: appRouter, createContext });
app.use(["/api/trpc", "/trpc"], trpcHandler);
app.get(["/api/health", "/health"], (_req, res) => res.json({ status: "ok" }));
app.post(["/api/webhooks/paytaca/payment-hub", "/webhooks/paytaca/payment-hub"], async (req, res) => {
  const payload = req.body as Record<string, unknown>;
  const signature = req.header("x-webhook-signature");
  if (!verifyPaymentHubWebhook(payload, signature, process.env.PAYTACA_PAYMENT_HUB_PUBLIC_KEY)) {
    res.status(401).json({ error: "invalid_webhook_signature" });
    return;
  }
  const invoiceId = typeof payload.invoice_id === "string" ? payload.invoice_id : "";
  const event = typeof payload.event === "string" ? payload.event : "paymenthub.invoice.updated";
  const status = typeof payload.status === "string" ? payload.status : "";
  if (!invoiceId || !status) {
    res.status(400).json({ error: "invalid_webhook_payload" });
    return;
  }
  try {
    const result = await applyPaymentHubWebhook({ externalInvoiceId: invoiceId, event, status, paymentTxid: typeof payload.payment_txid === "string" ? payload.payment_txid : undefined });
    res.status(200).json({ ok: true, matched: result.matched });
  } catch (error) {
    console.error("[Payment Hub] Webhook processing failed:", error);
    res.status(500).json({ error: "webhook_processing_failed" });
  }
});

export default app;


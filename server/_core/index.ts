import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { applyPaymentHubWebhook } from "../db";
import { verifyPaymentHubWebhook } from "../integrations/paymentHub";

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  const isDevelopment = process.env.NODE_ENV !== "production" && !process.argv.includes("--production");
  const scriptPolicy = isDevelopment
    ? "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'"
    : "script-src 'self' 'wasm-unsafe-eval'";
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self' https: wss: ws:; frame-src 'self' https:`);
    next();
  });
  const server = createServer(app);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: false, parameterLimit: 100 }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.post("/api/webhooks/paytaca/payment-hub", async (req, res) => {
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
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV !== "production" && !process.argv.includes("--production")) {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT || "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  server.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));
}

startServer().catch(error => { console.error(error); process.exit(1); });


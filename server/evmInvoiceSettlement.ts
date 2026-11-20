import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { evmCrosschainIntents, invoices, type EvmReceiveAsset, type EvmReceiveNetwork } from "../drizzle/schema";
import { getDb } from "./db";

export async function getEvmInvoiceIntent(input: { workspaceId: number; intentId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [intent] = await db.select().from(evmCrosschainIntents).where(and(eq(evmCrosschainIntents.workspaceId, input.workspaceId), eq(evmCrosschainIntents.id, input.intentId))).limit(1);
  return intent;
}

export async function createEvmInvoiceIntent(input: { workspaceId: number; userId: number; invoicePublicId: string; sourceAsset: "BCH" | "PUSD"; sourceAmountAtomic: string; depositAddress: string; network: EvmReceiveNetwork; asset: EvmReceiveAsset; destination: string; outputAmountAtomic: string; quote: unknown }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.publicId, input.invoicePublicId), eq(invoices.recipientWorkspaceId, input.workspaceId))).limit(1);
  if (!invoice || invoice.status !== "awaiting_payment" || invoice.deliveryNetwork !== input.network || invoice.deliveryAsset !== input.asset || invoice.receivingAddress !== input.destination) throw new Error("The invoice is no longer available for this EVM payout.");
  const [existing] = await db.select().from(evmCrosschainIntents).where(and(eq(evmCrosschainIntents.workspaceId, input.workspaceId), eq(evmCrosschainIntents.invoicePublicId, input.invoicePublicId))).orderBy(desc(evmCrosschainIntents.createdAt)).limit(1);
  if (existing && existing.status !== "failed" && existing.sourceAsset === input.sourceAsset && existing.sourceAmountAtomic === input.sourceAmountAtomic) return existing;
  if (existing && existing.status !== "failed") throw new Error("This invoice already has an active EVM payment intent. Recheck that payment before starting another.");
  const [intent] = await db.insert(evmCrosschainIntents).values({ publicId: `EVM-${nanoid(12).toUpperCase()}`, workspaceId: input.workspaceId, createdByUserId: input.userId, invoicePublicId: input.invoicePublicId, sourceAsset: input.sourceAsset, sourceAmountAtomic: input.sourceAmountAtomic, depositAddress: input.depositAddress, destinationNetwork: input.network, destinationAsset: input.asset, destinationAddress: input.destination, expectedOutputAtomic: input.outputAmountAtomic, quote: input.quote, status: "awaiting_funding", dataNetwork: input.network === "arc-mainnet" || input.network === "base-mainnet" ? "mainnet" : "testnet" }).returning();
  return intent;
}

export async function recordEvmInvoiceFunding(input: { workspaceId: number; intentId: number; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [intent] = await db.select().from(evmCrosschainIntents).where(and(eq(evmCrosschainIntents.id, input.intentId), eq(evmCrosschainIntents.workspaceId, input.workspaceId))).limit(1);
  if (!intent) throw new Error("EVM payment intent was not found.");
  if (intent.sourceTxid && intent.sourceTxid !== input.txid) throw new Error("This payment intent already has another Chipnet transaction.");
  const [updated] = await db.update(evmCrosschainIntents).set({ sourceTxid: input.txid, status: "pending_verification", updatedAt: new Date() }).where(and(eq(evmCrosschainIntents.id, intent.id), eq(evmCrosschainIntents.workspaceId, input.workspaceId), isNull(evmCrosschainIntents.sourceTxid))).returning();
  return updated ?? intent;
}

export async function setEvmInvoicePayout(input: { workspaceId: number; intentId: number; txid: string; completed: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [intent] = await tx.select().from(evmCrosschainIntents).where(and(eq(evmCrosschainIntents.id, input.intentId), eq(evmCrosschainIntents.workspaceId, input.workspaceId))).limit(1);
    if (!intent) throw new Error("EVM payment intent was not found.");
    if (intent.payoutTxid && intent.payoutTxid !== input.txid) throw new Error("This intent already has a different EVM payout transaction.");
    const [updated] = await tx.update(evmCrosschainIntents).set({ payoutTxid: input.txid, status: input.completed ? "completed" : "pending_verification", updatedAt: new Date() }).where(eq(evmCrosschainIntents.id, intent.id)).returning();
    if (input.completed && intent.invoicePublicId) {
      const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.publicId, intent.invoicePublicId), eq(invoices.recipientWorkspaceId, input.workspaceId))).limit(1);
      if (invoice && invoice.status === "awaiting_payment") {
        const metadata = invoice.metadata && typeof invoice.metadata === "object" ? invoice.metadata as Record<string, unknown> : {};
        const quote = intent.quote && typeof intent.quote === "object" ? intent.quote as Record<string, unknown> : {};
        const sourceNetwork = quote.sourceNetwork === "mainnet" ? "mainnet" : "chipnet";
        const settlement = { sourceAsset: intent.sourceAsset, sourceNetwork, sourceAmountAtomic: intent.sourceAmountAtomic, sourceTxid: intent.sourceTxid, destinationAsset: intent.destinationAsset, destinationNetwork: intent.destinationNetwork, destinationAmountAtomic: intent.expectedOutputAtomic, destinationAddress: intent.destinationAddress, evmTxid: input.txid };
        const safe = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
        const receiptHtml = `<article><h1>Voltra Finance payment receipt</h1><p><strong>Invoice:</strong> ${safe(invoice.publicId)}</p><p><strong>Paid with:</strong> ${safe(intent.sourceAsset)} on ${safe(sourceNetwork)}</p><p><strong>Recipient received:</strong> ${safe(intent.destinationAsset)} on ${safe(intent.destinationNetwork)}</p><p><strong>Transaction:</strong> ${safe(input.txid)}</p><p><strong>Status:</strong> Confirmed payment</p></article>`;
        await tx.update(invoices).set({ status: "paid", paymentTxid: input.txid, receiptHtml, metadata: { ...metadata, crosschainSettlement: settlement }, updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
      }
    }
    return updated;
  });
}

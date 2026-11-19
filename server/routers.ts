import { COOKIE_NAME } from "@shared/const";
import { authenticateWithPassword, endSession, publicUser, registerWithPassword, SESSION_TTL_MS } from "./auth";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { acceptWorkspaceInviteById, addMemberToPayroll, addMembersToPayroll, addPaymentDestination, addStellarDestination, approvePayrollRun, attachExternalInvoice, completeCrosschainIntent, createCrosschainIntent, createExternalInvoiceSubmission, createInvoiceForWorkspace, createNotification, createPayrollRunForWorkspace, createPaymentIntent, createPayslipForItem, deletePaymentDestination, deleteStellarDestination, deletePendingWorkspaceInvite, expireUnfundedCrosschainIntent, failCrosschainIntent, finalizeCrosschainInvoice, finalizeInvoiceBatch, finalizeVerifiedIntent, finalizeVerifiedInvoice, getCrosschainIntentForInvoice, getCrosschainIntentForWorkspace, getEmployeePayrollForUser, getFinancialRecordsForWorkspace, getInvoiceForRecipient, getInvoiceForWorkspace, getOrCreateWorkspaceForUser, getPaymentDestinationForUser, getPersonalStellarDestination, getStellarDestinationForUser, getPaymentIntentForWorkspace, getPayrollItemForWorkspace, getPayrollRunForWorkspace, getPersonalPayrollDestination, getTreasuryPlan, getWorkspacePaymentMetrics, getWorkspaceRoleForUser, linkWalletForWorkspaceUser, listCrosschainIntentsForWorkspace, listEmployeesForWorkspace, listInvoiceInboxForUser, listInvoiceRecipientTargets, listInvoicesForWorkspace, listNotificationsForUser, listOrganizationMembersForWorkspace, listPaymentDestinationsForUser, listStellarDestinationsForUser, listPaymentIntentSummariesForTransactions, listPayrollItemsForRun, listPayrollRunsForWorkspace, listPendingWorkspaceInvitesForEmail, listTreasuryActivity, listWalletsForWorkspaceUser, listWorkspacesForUser, markInvoiceBatchBroadcast, markNotificationRead, markPaymentIntentBroadcast, recordCrosschainSourceTx, saveCrosschainStellarTransaction, saveTreasuryPlan, sendDraftInvoice, setActiveWorkspaceForUser, setDefaultPaymentDestination, setDefaultStellarDestination, unlinkWalletForWorkspaceUser, updateDraftInvoiceForWorkspace, updateEmployeePayrollEnrollment, updateEmployeePayoutPreference, updateIncomingInvoiceStatus, updatePayrollItem, updatePayrollRunSourceAsset, updatePayrollRunStatus, recordStellarPayrollFunding, saveStellarPayrollTransaction, completeStellarPayrollRun, markStellarPayrollFailed, resetFailedStellarPayrollForRetry } from "./db";
import { buildCauldronSwap, formatAtomicAmount, getCashTokenCategories, getChipnetAssetReadiness, getCauldronQuote, getIntentQuote, getPayrollQuote } from "./integrations/cauldron";
import type { CauldronAsset } from "./integrations/cauldron";
import { createPaymentHubInvoice } from "./integrations/paymentHub";
import { sendOrganizationInviteEmail } from "./integrations/gmailSmtp";
import { broadcastChipnetTransaction, getProvider, getTransactionInputSources, getTransactionStatus, getWalletUtxos, getWalletUtxosForAddresses, verifyChipnetTransactionInputs, verifyRecipientOutput } from "./integrations/electrum";
import { buildChipnetCauldronBuy, buildChipnetCauldronSell, buildChipnetPayrollBatch, buildChipnetPusdPayrollBatch, getChipnetCauldronBuyQuote, getChipnetCauldronSellQuote } from "./integrations/chipnetCauldron";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Asset } from "../drizzle/schema";
import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import { createHash, randomBytes } from "node:crypto";
import { broadcastStellarTestnetXlm, formatStellarXlmAtomic, getStellarTestnetTransactionStatus, getStellarTestnetTreasuryStatus, quoteBchToStellarXlm, quotePusdToStellarUsdc, quotePusdToStellarXlm, quoteUsdtToStellarXlm, sendStellarTestnetPayrollBatch, sendStellarTestnetXlm, sendStellarTestnetXlmBatch, validateStellarPublicKey, StellarTransactionFailedError } from "./integrations/stellar";

async function requireWorkspaceAdmin(userId: number, workspaceId: number) {
  const role = await getWorkspaceRoleForUser({ userId, workspaceId });
  if (role !== "owner" && role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only organization owners and admins can make this change." });
}

async function requireOrganizationWorkspace(workspace: { id: number; type: "personal" | "organization" }) {
  if (workspace.type !== "organization") throw new TRPCError({ code: "FORBIDDEN", message: "Payroll is available only in an organization workspace." });
}

async function requirePersonalWorkspace(workspace: { id: number; type: "personal" | "organization" }) {
  if (workspace.type !== "personal") throw new TRPCError({ code: "FORBIDDEN", message: "Smart Treasury actions are available only in a personal workspace. Use organization invoices and payroll for team funds." });
}

function invoiceNeedsAssetConversion(requestAsset: "USDT" | "BCH" | "PUSD" | "MUSD", receiveAsset: "BCH" | "PUSD" | "MUSD") {
  const requestedUnit = requestAsset === "USDT" ? "PUSD" : requestAsset;
  return !(requestedUnit === receiveAsset || (requestedUnit !== "BCH" && receiveAsset !== "BCH"));
}

function requireNetworkTokenCategory(asset: "PUSD" | "MUSD", network: "mainnet" | "chipnet") {
  const category = getCashTokenCategories(network)[asset];
  if (!category) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${asset} has no configured CashToken category on ${network === "chipnet" ? "Chipnet" : "mainnet"}.` });
  return category;
}

const guestInvoiceSubmissions = new Map<string, { count: number; resetsAt: number }>();
function enforceGuestInvoiceRate(ip: string) {
  const now = Date.now();
  if (guestInvoiceSubmissions.size > 10_000) for (const [key, entry] of guestInvoiceSubmissions) if (entry.resetsAt <= now) guestInvoiceSubmissions.delete(key);
  const current = guestInvoiceSubmissions.get(ip);
  if (!current || current.resetsAt <= now) {
    guestInvoiceSubmissions.set(ip, { count: 1, resetsAt: now + 60 * 60 * 1000 });
    return;
  }
  if (current.count >= 10) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many invoice submissions from this connection. Please try again later." });
  current.count += 1;
}
import { acceptWorkspaceInvite, createOrganizationForUser, createWorkspaceInvite, listWorkspaceInvites, renameWorkspaceForOwner } from "./db";

function toAtomicAmount(value: string, asset: "BCH" | "PUSD" | "MUSD") {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Amount must be a positive decimal");
  const [whole, fraction = ""] = normalized.split(".");
  const decimals = asset === "BCH" ? 8 : 2;
  if (fraction.length > decimals) throw new Error(`${asset} supports at most ${decimals} decimal places`);
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  if (atomic <= 0n) throw new Error("Amount must be greater than zero");
  return atomic.toString();
}


function toInvoiceAtomicAmount(value: string, asset: "USDT" | "BCH" | "PUSD" | "MUSD") {
  if (asset === "USDT") return toAtomicAmount(value, "PUSD");
  return toAtomicAmount(value, asset);
}

function presentInvoice(invoice: Awaited<ReturnType<typeof listInvoicesForWorkspace>>[number]) {
  const metadata = invoice.metadata && typeof invoice.metadata === "object" ? invoice.metadata as Record<string, unknown> : {};
  const crosschainSettlement = metadata.crosschainSettlement && typeof metadata.crosschainSettlement === "object" ? metadata.crosschainSettlement as { sourceAsset?: string; sourceAmountAtomic?: string; destinationAsset?: string; destinationNetwork?: string; destinationAmountAtomic?: string; destinationAddress?: string; sourceTxid?: string; stellarTxid?: string } : null;
  const status = {
    draft: "Draft",
    submitted: "Needs review",
    awaiting_payment: "Awaiting payment",
    awaiting_verification: "Awaiting verification",
    paid: "Paid",
    expired: "Expired",
    cancelled: "Cancelled",
  }[invoice.status] as "Draft" | "Needs review" | "Awaiting payment" | "Awaiting verification" | "Paid" | "Expired" | "Cancelled";
  return { id: invoice.publicId, client: invoice.clientName, description: invoice.description, amount: invoice.displayAmount, amountAtomic: invoice.amountAtomic, requestAsset: invoice.requestAsset, receivedAmountAtomic: invoice.receivedAmountAtomic, asset: invoice.asset, deliveryAsset: invoice.deliveryAsset, deliveryNetwork: invoice.deliveryNetwork, due: invoice.dueDate, status, direction: invoice.direction, recipientEmail: invoice.recipientEmail, senderName: invoice.senderName, senderEmail: invoice.senderEmail, receivingAddress: invoice.receivingAddress, network: invoice.deliveryNetwork === "stellar-testnet" || invoice.receivingAddress?.startsWith("bchtest:") ? "chipnet" as const : "mainnet" as const, paymentTxid: invoice.paymentTxid, externalInvoiceId: invoice.externalInvoiceId, crosschainSettlement, hasReceipt: Boolean(invoice.receiptHtml), receiptHtml: invoice.receiptHtml, createdAt: invoice.createdAt };
}

async function presentInvoicesWithPayment(records: Awaited<ReturnType<typeof listInvoicesForWorkspace>>) {
  const txids = [...new Set(records.flatMap((invoice) => invoice.paymentTxid ? [invoice.paymentTxid] : []))];
  const summaries = await listPaymentIntentSummariesForTransactions(txids);
  const paymentByTxid = new Map<string, (typeof summaries)[number]>();
  for (const summary of summaries) if (summary.txid && !paymentByTxid.has(summary.txid)) paymentByTxid.set(summary.txid, summary);
  return records.map((invoice) => {
    const payment = invoice.paymentTxid ? paymentByTxid.get(invoice.paymentTxid) : undefined;
    const presented = presentInvoice(invoice);
    const crosschainSourceAsset = presented.crosschainSettlement?.sourceAsset === "PUSD" || presented.crosschainSettlement?.sourceAsset === "BCH" ? presented.crosschainSettlement.sourceAsset : null;
    return {
      ...presented,
      payerAsset: payment?.payerAsset ?? crosschainSourceAsset,
      payerAmountAtomic: payment?.inputAmountAtomic ?? presented.crosschainSettlement?.sourceAmountAtomic ?? null,
    };
  });
}

export const appRouter = router({
  notifications: router({
    list: protectedProcedure.query(({ ctx }) => listNotificationsForUser(ctx.user.id)),
    markRead: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(({ ctx, input }) => markNotificationRead({ userId: ctx.user.id, notificationId: input.id })),
    markAllRead: protectedProcedure.mutation(({ ctx }) => markNotificationRead({ userId: ctx.user.id, all: true })),
  }),
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
    signUp: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320), password: z.string().min(12, "Use a password with at least 12 characters.").max(128, "Use a password with no more than 128 characters."), name: z.string().trim().min(1).max(120).optional() }))
      .mutation(async ({ ctx, input }) => {
        const result = await registerWithPassword(input);
        if (!result) throw new TRPCError({ code: "CONFLICT", message: "An account with that email already exists." });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, result.session.token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
        return publicUser(result.user);
      }),
    signIn: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(128) }))
      .mutation(async ({ ctx, input }) => {
        const result = await authenticateWithPassword(input.email, input.password);
        if (!result) throw new TRPCError({ code: "UNAUTHORIZED", message: "Email or password is incorrect." });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, result.session.token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
        return publicUser(result.user);
      }),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      await endSession(ctx.sessionToken);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  wallets: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      const rows = await listWalletsForWorkspaceUser(workspace.id, ctx.user.id);
      return rows.map(({ id, provider, network, connectionStatus, address, createdAt }) => ({ id, provider, network, connectionStatus, address, createdAt }));
    }),
    link: protectedProcedure
      .input(z.object({ provider: z.string().trim().min(1).max(64), network: z.enum(["mainnet", "chipnet", "testnet"]), address: z.string().trim().min(20).max(128) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        const wallet = await linkWalletForWorkspaceUser({ ...input, workspaceId: workspace.id, userId: ctx.user.id });
        return { id: wallet.id, provider: wallet.provider, network: wallet.network, address: wallet.address, connectionStatus: wallet.connectionStatus };
      }),
    unlink: protectedProcedure
      .input(z.object({ walletId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        const removed = await unlinkWalletForWorkspaceUser({ workspaceId: workspace.id, userId: ctx.user.id, walletId: input.walletId });
        if (!removed) throw new TRPCError({ code: "NOT_FOUND", message: "Wallet was not found in this workspace." });
        return { success: true as const };
      }),
  }),
  organization: router({
    current: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      return { ...workspace, role: await getWorkspaceRoleForUser({ userId: ctx.user.id, workspaceId: workspace.id }) };
    }),
    list: protectedProcedure.query(async ({ ctx }) => listWorkspacesForUser(ctx.user.id)),
    switch: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      if (!await setActiveWorkspaceForUser({ userId: ctx.user.id, workspaceId: input.workspaceId })) throw new TRPCError({ code: "FORBIDDEN", message: "You are not a member of that organization." });
      return getOrCreateWorkspaceForUser(ctx.user.id);
    }),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(160) })).mutation(async ({ ctx, input }) => createOrganizationForUser({ ownerUserId: ctx.user.id, name: input.name })),
    rename: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(160) })).mutation(async ({ ctx, input }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireOrganizationWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      const updated = await renameWorkspaceForOwner({ workspaceId: workspace.id, ownerUserId: ctx.user.id, name: input.name });
      if (!updated) throw new TRPCError({ code: "FORBIDDEN", message: "Only the organization owner can change its name." });
      return updated;
    }),
    invites: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireOrganizationWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return listWorkspaceInvites(workspace.id);
    }),
    myPendingInvites: protectedProcedure.query(({ ctx }) => listPendingWorkspaceInvitesForEmail(ctx.user.email)),
    acceptPendingInvite: protectedProcedure.input(z.object({ inviteId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const accepted = await acceptWorkspaceInviteById({ userId: ctx.user.id, email: ctx.user.email, inviteId: input.inviteId });
      if (!accepted) throw new TRPCError({ code: "NOT_FOUND", message: "This invitation is expired, already accepted, or belongs to a different email address." });
      return { success: true as const };
    }),
    createInvite: protectedProcedure.input(z.object({ email: z.string().trim().email().max(320), role: z.enum(["admin", "employee"]).default("employee") })).mutation(async ({ ctx, input }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireOrganizationWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      if (input.email.toLowerCase() === ctx.user.email.toLowerCase()) throw new TRPCError({ code: "BAD_REQUEST", message: "You are already the organization owner." });
      const configuredAppUrl = process.env.APP_BASE_URL?.trim();
      const requestProtocol = ctx.req.get("x-forwarded-proto")?.split(",")[0]?.trim() || ctx.req.protocol;
      const requestAppUrl = `${requestProtocol}://${ctx.req.get("host")}`;
      let appBaseUrl: string;
      try {
        const parsed = new URL(configuredAppUrl || requestAppUrl);
        const isLocal = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
        if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || (process.env.NODE_ENV === "production" && parsed.protocol !== "https:" && !isLocal)) throw new Error("Invalid app URL");
        appBaseUrl = parsed.origin;
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Volta Finance could not determine a valid invitation link for this app. Check APP_BASE_URL or the deployed request host." });
      }
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const invite = await createWorkspaceInvite({ workspaceId: workspace.id, email: input.email, role: input.role, tokenHash, invitedByUserId: ctx.user.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });
      const inviteUrl = `${appBaseUrl}/login?invite=${token}`;
      let emailSent = false;
      try {
        const delivery = await sendOrganizationInviteEmail({ to: invite.email, organizationName: workspace.name, inviterName: ctx.user.name || ctx.user.email, role: invite.role, inviteUrl });
        emailSent = delivery.sent;
      } catch (error) {
        console.error("[Email] Organization invite delivery failed:", error instanceof Error ? error.message : "Unknown SMTP error");
      }
      if (!emailSent) {
        await deletePendingWorkspaceInvite(invite.id);
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The invitation email could not be sent. Check Google SMTP settings and try again; no active invitation was created." });
      }
      return { ...invite, emailSent };
    }),
    acceptInvite: protectedProcedure.input(z.object({ token: z.string().min(20).max(128) })).mutation(async ({ ctx, input }) => {
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const accepted = await acceptWorkspaceInvite({ userId: ctx.user.id, email: ctx.user.email, tokenHash });
      if (!accepted) throw new TRPCError({ code: "NOT_FOUND", message: "This invitation is expired, already used, or belongs to a different email address." });
      return { success: true as const };
    }),
  }),
  destinations: router({
    list: protectedProcedure.query(async ({ ctx }) => (await listPaymentDestinationsForUser(ctx.user.id)).map((destination) => {
      const decoded = cashAddressToLockingBytecode(destination.address);
      return { ...destination, asset: destination.asset === "BCH" && typeof decoded !== "string" && decoded.tokenSupport ? "TOKEN" as const : destination.asset };
    })),
    add: protectedProcedure.input(z.object({ label: z.string().trim().min(1).max(80), asset: z.enum(["BCH", "TOKEN"]), network: z.enum(["mainnet", "chipnet"]).default("chipnet"), address: z.string().trim().min(20).max(128), makeDefault: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      const decoded = cashAddressToLockingBytecode(input.address);
      const expectedPrefix = input.network === "mainnet" ? "bitcoincash" : "bchtest";
      if (typeof decoded === "string" || decoded.prefix !== expectedPrefix) throw new TRPCError({ code: "BAD_REQUEST", message: `Enter a valid ${expectedPrefix} CashAddress for the selected network.` });
      if (input.asset === "TOKEN" && !decoded.tokenSupport) throw new TRPCError({ code: "BAD_REQUEST", message: "CashTokens destinations must use a token-aware CashAddress from a compatible BCH wallet." });
      return addPaymentDestination({ ...input, asset: decoded.tokenSupport ? "TOKEN" : input.asset, userId: ctx.user.id });
    }),
    makeDefault: protectedProcedure.input(z.object({ destinationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const updated = await setDefaultPaymentDestination({ userId: ctx.user.id, destinationId: input.destinationId });
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Payment destination was not found in this account." });
      return { success: true as const };
    }),
    delete: protectedProcedure.input(z.object({ destinationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const deleted = await deletePaymentDestination({ userId: ctx.user.id, destinationId: input.destinationId });
      if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Payment destination was not found in this account." });
      return { success: true as const };
    }),
  }),
  stellarDestinations: router({
    list: protectedProcedure.query(async ({ ctx }) => listStellarDestinationsForUser(ctx.user.id)),
    add: protectedProcedure.input(z.object({ label: z.string().trim().min(1).max(80), address: z.string().trim().length(56), makeDefault: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
      if (!validateStellarPublicKey(input.address)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid Stellar Testnet public address beginning with G." });
      return addStellarDestination({ ...input, userId: ctx.user.id });
    }),
    makeDefault: protectedProcedure.input(z.object({ destinationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      if (!await setDefaultStellarDestination({ userId: ctx.user.id, destinationId: input.destinationId })) throw new TRPCError({ code: "NOT_FOUND", message: "Stellar address was not found in this account." });
      return { success: true as const };
    }),
    delete: protectedProcedure.input(z.object({ destinationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      if (!await deleteStellarDestination({ userId: ctx.user.id, destinationId: input.destinationId })) throw new TRPCError({ code: "NOT_FOUND", message: "Stellar address was not found in this account." });
      return { success: true as const };
    }),
  }),
  finance: router({
    treasuryActivity: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requirePersonalWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return listTreasuryActivity(workspace.id);
    }),
    treasuryPlan: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requirePersonalWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return getTreasuryPlan(workspace.id);
    }),
    saveTreasuryPlan: protectedProcedure.input(z.object({
      allocations: z.object({ tax: z.number().int().min(0).max(100), savings: z.number().int().min(0).max(100), payroll: z.number().int().min(0).max(100), operating: z.number().int().min(0).max(100) }).refine((items) => items.tax + items.savings + items.payroll + items.operating <= 100, "Allocation percentages must total 100% or less."),
      reserveGoal: z.object({ amount: z.string().trim().regex(/^\d+(\.\d+)?$/), asset: z.enum(["BCH", "PUSD", "MUSD"]), targetDate: z.string().max(40).nullable() }).nullable(),
      recurringPlan: z.object({ purpose: z.enum(["tax", "savings", "payroll", "operating"]), amount: z.string().trim().regex(/^\d+(\.\d+)?$/), asset: z.enum(["BCH", "PUSD", "MUSD"]), cadence: z.enum(["weekly", "monthly"]) }).nullable(),
    })).mutation(async ({ ctx, input }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requirePersonalWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      if (input.reserveGoal) toAtomicAmount(input.reserveGoal.amount, input.reserveGoal.asset);
      if (input.recurringPlan) toAtomicAmount(input.recurringPlan.amount, input.recurringPlan.asset);
      return saveTreasuryPlan({ workspaceId: workspace.id, userId: ctx.user.id, configuration: input });
    }),
    chipnetAssetConfig: publicProcedure.query(() => ({ categories: getCashTokenCategories("chipnet"), ready: getChipnetAssetReadiness() })),
    stellarTestnetTreasury: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return getStellarTestnetTreasuryStatus();
    }),
    stellarPusdIntents: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return listCrosschainIntentsForWorkspace(workspace.id);
    }),
    createStellarPusdIntent: protectedProcedure
      .input(z.object({ amount: z.string().trim().min(1).max(40), destination: z.string().trim().min(56).max(56) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requirePersonalWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        if (!validateStellarPublicKey(input.destination)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid Stellar Testnet account address." });
        const depositAddress = process.env.CHIPNET_CROSSCHAIN_PUSD_ADDRESS?.trim();
        if (!depositAddress) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The project Chipnet PUSD deposit address is not configured." });
        const decodedDeposit = cashAddressToLockingBytecode(depositAddress);
        if (typeof decodedDeposit === "string" || decodedDeposit.prefix !== "bchtest" || !decodedDeposit.tokenSupport) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The project deposit address must be a token-aware Chipnet CashAddress." });
        const sourceAmountAtomic = toAtomicAmount(input.amount, "PUSD");
        requireNetworkTokenCategory("PUSD", "chipnet");
        let quote;
        try { quote = await quotePusdToStellarXlm(sourceAmountAtomic); }
        catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "A live XLM quote is unavailable." }); }
        const intent = await createCrosschainIntent({
          workspaceId: workspace.id,
          createdByUserId: ctx.user.id,
          sourceAsset: "PUSD",
          sourceAmountAtomic,
          depositAddress,
          destinationAddress: input.destination,
          expectedOutputAtomic: quote.destinationAmountAtomic,
          quote,
          expiresAt: new Date(quote.expiresAt),
        });
        return { intent, quote, depositAddress, sourceAsset: "PUSD" as const, destinationAsset: "XLM" as const, network: "chipnet-to-stellar-testnet" as const, tokenCategory: getCashTokenCategories("chipnet").PUSD };
      }),
    createStellarInvoiceIntent: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), payerAsset: z.enum(["BCH", "PUSD"]).default("PUSD") }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const invoice = await getInvoiceForRecipient({ workspaceId: workspace.id, userId: ctx.user.id, publicId: input.publicId });
        if (!invoice || invoice.status !== "awaiting_payment") throw new TRPCError({ code: "NOT_FOUND", message: "This invoice is no longer awaiting payment." });
        if (invoice.deliveryAsset !== "XLM") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This is not a Stellar Testnet invoice." });
        if (invoice.requestAsset !== "USDT") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Stellar test flow currently supports USDT-denominated invoices only." });
        if (invoice.deliveryAsset !== "XLM" || invoice.deliveryNetwork !== "stellar-testnet" || !invoice.receivingAddress || !validateStellarPublicKey(invoice.receivingAddress)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This invoice does not contain a valid Stellar Testnet receiving address." });
        const payerAsset = input.payerAsset;
        // Both payer assets can use the same token-aware Chipnet intake address.
        // Prefer the shared setting; fall back to the existing PUSD setting so
        // already-running local servers work without needing a restart.
        const depositAddress = (process.env.CHIPNET_CROSSCHAIN_DEPOSIT_ADDRESS || process.env.CHIPNET_CROSSCHAIN_PUSD_ADDRESS || process.env.CHIPNET_CROSSCHAIN_BCH_ADDRESS)?.trim();
        if (!depositAddress) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The project Chipnet crosschain deposit address is not configured." });
        const decodedDeposit = cashAddressToLockingBytecode(depositAddress);
        if (typeof decodedDeposit === "string" || decodedDeposit.prefix !== "bchtest" || (payerAsset === "PUSD" && !decodedDeposit.tokenSupport)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: payerAsset === "BCH" ? "The project BCH deposit address must be a valid Chipnet CashAddress." : "The project PUSD deposit address must be a token-aware Chipnet CashAddress." });
        const existing = await getCrosschainIntentForInvoice({ workspaceId: workspace.id, invoicePublicId: invoice.publicId });
        if (existing && !["expired", "failed"].includes(existing.status)) {
          if (existing.status === "awaiting_payment" && !existing.sourceTxid && existing.sourceAsset === payerAsset && existing.expiresAt.getTime() > Date.now()) {
            return { intent: existing, quote: existing.quote, depositAddress: existing.depositAddress, sourceAsset: payerAsset, destinationAsset: "XLM" as const, invoicePublicId: invoice.publicId };
          }
          if (existing.status === "awaiting_payment" && !existing.sourceTxid) {
            await expireUnfundedCrosschainIntent({ workspaceId: workspace.id, intentId: existing.id });
          } else {
            throw new TRPCError({ code: "CONFLICT", message: `This invoice already has crosschain intent ${existing.publicId} (${existing.status}). Recheck or complete that payment before changing the payer asset.` });
          }
        }
        if (payerAsset === "PUSD") requireNetworkTokenCategory("PUSD", "chipnet");
        let quote;
        try { quote = payerAsset === "BCH" ? await quoteBchToStellarXlm(invoice.amountAtomic) : await quoteUsdtToStellarXlm(invoice.amountAtomic); }
        catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "A live XLM quote is unavailable." }); }
        const intent = await createCrosschainIntent({ workspaceId: workspace.id, createdByUserId: ctx.user.id, sourceAsset: payerAsset, sourceAmountAtomic: quote.sourceAmountAtomic, invoicePublicId: invoice.publicId, depositAddress, destinationAddress: invoice.receivingAddress, expectedOutputAtomic: quote.destinationAmountAtomic, quote, expiresAt: new Date(quote.expiresAt) });
        return { intent, quote, depositAddress, sourceAsset: payerAsset, destinationAsset: "XLM" as const, invoicePublicId: invoice.publicId };
      }),
    recordStellarIntentFunding: protectedProcedure
      .input(z.object({ intentId: z.number().int().positive(), txid: z.string().regex(/^[0-9a-fA-F]{64}$/) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const intent = await getCrosschainIntentForWorkspace({ workspaceId: workspace.id, intentId: input.intentId });
        if (!intent || intent.createdByUserId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Crosschain intent was not found." });
        try { return await recordCrosschainSourceTx({ workspaceId: workspace.id, intentId: intent.id, txid: input.txid }); }
        catch (error) { throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : "The BCH payment could not be attached to this intent." }); }
      }),
    settleStellarIntent: protectedProcedure
      .input(z.object({ intentId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const intent = await getCrosschainIntentForWorkspace({ workspaceId: workspace.id, intentId: input.intentId });
        if (!intent || intent.createdByUserId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Crosschain intent was not found." });
        const recordInvoicePayment = async (stellarTxid: string) => {
          if (!intent.invoicePublicId || !intent.sourceTxid) return;
          const invoice = await finalizeCrosschainInvoice({ payerWorkspaceId: workspace.id, actorUserId: ctx.user.id, publicId: intent.invoicePublicId, sourceAsset: intent.sourceAsset, sourceAmountAtomic: intent.sourceAmountAtomic, stellarAmountAtomic: intent.expectedOutputAtomic, destinationAddress: intent.destinationAddress, sourceTxid: intent.sourceTxid, stellarTxid });
          if (invoice.createdByUserId) await createNotification({ recipientUserId: invoice.createdByUserId, workspaceId: invoice.workspaceId, category: "invoice", title: "Crosschain invoice paid", body: `${invoice.publicId} was paid with ${formatAtomicAmount(intent.sourceAmountAtomic, intent.sourceAsset)} ${intent.sourceAsset}; the recipient received ${formatStellarXlmAtomic(intent.expectedOutputAtomic)} XLM on Stellar Testnet.`, href: "/payments", entityType: "invoice", entityId: invoice.publicId });
        };
        if (intent.status === "completed") return { status: intent.status, sourceTxid: intent.sourceTxid, stellarTxid: intent.stellarTxid, amountAtomic: intent.expectedOutputAtomic };
        if (intent.status === "failed" || intent.status === "expired") return { status: intent.status, reason: intent.failureReason };
        if (!intent.sourceTxid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Send the quoted ${intent.sourceAsset} payment before settlement can begin.` });
        if (intent.status === "paying") {
          if (!intent.stellarSignedXdr || !intent.stellarTxid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The saved Stellar payout is incomplete; contact support before retrying this intent." });
          try {
            const sent = await broadcastStellarTestnetXlm({ signedXdr: intent.stellarSignedXdr, expectedTxid: intent.stellarTxid });
            await recordInvoicePayment(sent.txid);
            const completed = await completeCrosschainIntent({ workspaceId: workspace.id, intentId: intent.id, stellarTxid: sent.txid });
            return { status: completed.status, sourceTxid: completed.sourceTxid, stellarTxid: sent.txid, amountAtomic: completed.expectedOutputAtomic };
          } catch (error) {
            throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Stellar payout is prepared and safe to retry: ${error instanceof Error ? error.message : "network temporarily unavailable"}` });
          }
        }
        if (intent.status !== "pending_verification") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This crosschain intent is not ready for settlement." });
        const sourceStatus = await getTransactionStatus({ txid: intent.sourceTxid, network: "chipnet" });
        if (!sourceStatus.found || sourceStatus.confirmations < 1) return { status: "pending_verification" as const, confirmations: sourceStatus.confirmations, sourceTxid: intent.sourceTxid };
        const sourceTokenCategory = intent.sourceAsset === "PUSD" ? getCashTokenCategories("chipnet").PUSD : undefined;
        const verification = await verifyRecipientOutput({ txid: intent.sourceTxid, recipientAddress: intent.depositAddress, expectedAsset: intent.sourceAsset, expectedAmountAtomic: intent.sourceAmountAtomic, tokenCategory: sourceTokenCategory, network: "chipnet" });
        if (!verification.verified) {
          await failCrosschainIntent({ workspaceId: workspace.id, intentId: intent.id, reason: `Confirmed Chipnet transaction did not deliver the quoted ${intent.sourceAsset} amount to Volta Finance.` });
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The confirmed Chipnet transaction does not contain the full quoted ${intent.sourceAsset} deposit to Volta Finance.` });
        }
        try {
          const prepared = await sendStellarTestnetXlm({ destination: intent.destinationAddress, amountAtomic: intent.expectedOutputAtomic });
          await saveCrosschainStellarTransaction({ workspaceId: workspace.id, intentId: intent.id, txid: prepared.txid, signedXdr: prepared.signedXdr });
          const sent = await broadcastStellarTestnetXlm({ signedXdr: prepared.signedXdr, expectedTxid: prepared.txid });
          await recordInvoicePayment(sent.txid);
          const completed = await completeCrosschainIntent({ workspaceId: workspace.id, intentId: intent.id, stellarTxid: sent.txid });
          await createNotification({ recipientUserId: ctx.user.id, workspaceId: workspace.id, category: "payment", title: "Crosschain intent completed", body: `${formatAtomicAmount(intent.sourceAmountAtomic, intent.sourceAsset)} ${intent.sourceAsset} on Chipnet was settled as ${formatStellarXlmAtomic(intent.expectedOutputAtomic)} XLM on Stellar Testnet.`, href: "/records", entityType: "crosschain_intent", entityId: intent.publicId });
          return { status: completed.status, sourceTxid: completed.sourceTxid, stellarTxid: sent.txid, amountAtomic: completed.expectedOutputAtomic };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `${intent.sourceAsset} was verified on Chipnet, but the Stellar payout needs a retry: ${error instanceof Error ? error.message : "Stellar Testnet unavailable"}` });
        }
      }),
    quote: publicProcedure
      .input(z.object({ sell: z.enum(["BCH", "PUSD", "MUSD"]), buy: z.enum(["BCH", "PUSD", "MUSD"]), amount: z.string().trim().min(1).max(80), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(({ input }) => getCauldronQuote(input)),
    intentQuote: publicProcedure
      .input(z.object({ sell: z.enum(["BCH", "PUSD", "MUSD"]), buy: z.enum(["BCH", "PUSD", "MUSD"]), amount: z.string().trim().min(1).max(80), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(({ input }) => getIntentQuote(input)),
    createIntent: protectedProcedure
      .input(z.object({ sell: z.enum(["BCH", "PUSD", "MUSD"]), buy: z.enum(["BCH", "PUSD", "MUSD"]), amount: z.string().trim().min(1).max(80), recipientAddress: z.string().trim().min(20).max(128) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requirePersonalWorkspace(workspace);
        const decodedRecipient = cashAddressToLockingBytecode(input.recipientAddress);
        const network = typeof decodedRecipient !== "string" && decodedRecipient.prefix === "bchtest" ? "chipnet" : "mainnet";
        if (typeof decodedRecipient === "string" || !["bitcoincash", "bchtest"].includes(decodedRecipient.prefix)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid Bitcoin Cash recipient address for mainnet or Chipnet." });
        if (input.buy !== "BCH" && !decodedRecipient.tokenSupport) throw new TRPCError({ code: "BAD_REQUEST", message: "CashToken recipients must use a token-aware CashAddress." });
        const chipnetBchReferenceQuote = network === "chipnet" && input.sell === "PUSD" && input.buy === "BCH";
        if (input.sell !== "BCH") requireNetworkTokenCategory(input.sell, chipnetBchReferenceQuote ? "mainnet" : network);
        if (input.buy !== "BCH") requireNetworkTokenCategory(input.buy, network);
        // A USDT-priced invoice paid as BCH on Chipnet uses PUSD/BCH only as a
        // mainnet price reference. The payer sends BCH on Chipnet; no testnet
        // PUSD token or conversion contract is involved.
        const quoteNetwork = chipnetBchReferenceQuote ? "mainnet" : network;
        const quote = input.sell === input.buy
          ? { provider: "direct wallet transfer" as const, sell: input.sell, buy: input.buy, inputAmount: toAtomicAmount(input.amount, input.sell), outputAmount: toAtomicAmount(input.amount, input.buy), legs: [], atomic: true }
          : await getIntentQuote({ ...input, network: quoteNetwork });
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const intent = await createPaymentIntent({ workspaceId: workspace.id, createdByUserId: ctx.user.id, payerAsset: input.sell, recipientAsset: input.buy, recipientAddress: input.recipientAddress, inputAmountAtomic: quote.inputAmount, expectedOutputAtomic: quote.outputAmount, quote });
        return { intent, quote };
      }),
    createInvoicePaymentIntent: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), payerAsset: z.enum(["BCH", "PUSD", "MUSD"]) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const invoice = await getInvoiceForRecipient({ workspaceId: workspace.id, userId: ctx.user.id, publicId: input.publicId });
        if (!invoice || invoice.status !== "awaiting_payment") throw new TRPCError({ code: "NOT_FOUND", message: "This invoice is no longer awaiting payment." });
        if (invoice.deliveryAsset === "XLM") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This invoice settles to Stellar Testnet. Use the invoice crosschain payment section." });
        if (!invoice.receivingAddress) throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice has no saved receiving address." });
        const decodedRecipient = cashAddressToLockingBytecode(invoice.receivingAddress);
        if (typeof decodedRecipient === "string") throw new TRPCError({ code: "BAD_REQUEST", message: "The invoice receiving address is invalid." });
        if (invoice.asset !== "BCH" && !decodedRecipient.tokenSupport) throw new TRPCError({ code: "BAD_REQUEST", message: "CashToken invoices require the recipient’s token-aware CashAddress." });
        const network = decodedRecipient.prefix === "bchtest" ? "chipnet" : "mainnet";
        if (input.payerAsset !== "BCH") requireNetworkTokenCategory(input.payerAsset, network);
        if (invoice.asset !== "BCH") requireNetworkTokenCategory(invoice.asset, network);

        const requestedUnit = invoice.requestAsset === "USDT" ? "PUSD" : invoice.requestAsset;
        const needsValuation = invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset);
        let valuationQuote;
        let executionQuote;
        try {
          valuationQuote = needsValuation
            ? network === "chipnet" && requestedUnit !== "BCH" && invoice.asset === "BCH"
              ? await getChipnetCauldronSellQuote({ sell: requestedUnit, amountAtomic: toAtomicAmount(invoice.displayAmount, requestedUnit), side: "sell" })
              : await getIntentQuote({ sell: requestedUnit, buy: invoice.asset, amount: invoice.displayAmount, network })
            : null;
          const outputAmountAtomic = valuationQuote?.outputAmount || invoice.amountAtomic;
          if (network === "chipnet" && input.payerAsset === "BCH" && invoice.asset !== "BCH") {
            const liveQuote = await getChipnetCauldronBuyQuote({ buy: invoice.asset as CauldronAsset, amountAtomic: outputAmountAtomic });
            executionQuote = {
              provider: liveQuote.provider,
              sell: "BCH",
              buy: invoice.asset as CauldronAsset,
              inputAmount: liveQuote.inputAmount,
              outputAmount: liveQuote.outputAmount,
              legs: [{ sell: "BCH" as const, buy: invoice.asset as CauldronAsset, inputAmount: liveQuote.inputAmount, outputAmount: liveQuote.outputAmount, pools: liveQuote.pools }],
              atomic: false,
              side: "buy",
            };
          } else if (network === "chipnet" && input.payerAsset !== "BCH" && invoice.asset === "BCH") {
            const liveQuote = await getChipnetCauldronSellQuote({ sell: input.payerAsset, amountAtomic: outputAmountAtomic, side: "buy" });
            executionQuote = {
              provider: liveQuote.provider,
              sell: input.payerAsset,
              buy: "BCH",
              inputAmount: liveQuote.inputAmount,
              outputAmount: liveQuote.outputAmount,
              legs: [{ sell: input.payerAsset, buy: "BCH" as const, inputAmount: liveQuote.inputAmount, outputAmount: liveQuote.outputAmount, pools: liveQuote.pools }],
              atomic: false,
              side: "buy",
            };
          } else {
            executionQuote = await getPayrollQuote({
              sell: input.payerAsset,
              buy: invoice.asset,
              amount: formatAtomicAmount(outputAmountAtomic, invoice.asset),
              network,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Cauldron Router quote failed";
          if (/route_failed/i.test(message)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cauldron has no live route for this asset pair and amount. No payment intent was created." });
          if (/timed out|unavailable|closed the quote connection|could not send/i.test(message)) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Cauldron’s quote service did not respond after a retry. No payment intent was created; try again shortly." });
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cauldron could not quote this invoice: ${message}. No payment intent was created.` });
        }
        const outputAmountAtomic = valuationQuote?.outputAmount || invoice.amountAtomic;
        const quote = {
          ...executionQuote,
          invoicePublicId: invoice.publicId,
          requestedAmountAtomic: invoice.amountAtomic,
          requestedAsset: invoice.requestAsset,
          outputAmountAtomic,
          valuationQuote,
        };
        const intent = await createPaymentIntent({
          workspaceId: workspace.id,
          createdByUserId: ctx.user.id,
          payerAsset: input.payerAsset,
          recipientAsset: invoice.asset,
          recipientAddress: invoice.receivingAddress,
          inputAmountAtomic: executionQuote.inputAmount,
          expectedOutputAtomic: outputAmountAtomic,
          quote,
        });
        return { intent, quote, outputAmountAtomic, network, recipientAddress: invoice.receivingAddress, recipientAsset: invoice.asset };
      }),
    createPayrollIntent: protectedProcedure
      .input(z.object({ sell: z.enum(["BCH", "PUSD", "MUSD"]), buy: z.enum(["BCH", "PUSD", "MUSD"]), amount: z.string().trim().min(1).max(80), recipientAddress: z.string().trim().min(20).max(128), network: z.enum(["mainnet", "chipnet"]).default("chipnet") }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const decodedRecipient = cashAddressToLockingBytecode(input.recipientAddress);
        const expectedPrefix = input.network === "chipnet" ? "bchtest" : "bitcoincash";
        if (typeof decodedRecipient === "string" || decodedRecipient.prefix !== expectedPrefix) throw new TRPCError({ code: "BAD_REQUEST", message: `Payroll requires a valid ${input.network} Bitcoin Cash receiving address.` });
        if (input.sell !== "BCH") requireNetworkTokenCategory(input.sell, input.network);
        if (input.buy !== "BCH") requireNetworkTokenCategory(input.buy, input.network);
        if (input.buy !== "BCH" && !decodedRecipient.tokenSupport) throw new TRPCError({ code: "BAD_REQUEST", message: "CashToken payroll requires the staff member’s token-aware receiving address." });
        const quote = await getPayrollQuote(input);
        const intent = await createPaymentIntent({ workspaceId: workspace.id, createdByUserId: ctx.user.id, payerAsset: input.sell, recipientAsset: input.buy, recipientAddress: input.recipientAddress, inputAmountAtomic: quote.inputAmount, expectedOutputAtomic: quote.outputAmount, quote });
        return { intent, quote };
      }),
    quotePayrollPayout: protectedProcedure
      .input(z.object({ amount: z.string().trim().min(1).max(80), asset: z.enum(["BCH", "PUSD", "MUSD"]), network: z.enum(["mainnet", "chipnet"]).default("chipnet") }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        requireNetworkTokenCategory("PUSD", input.network);
        if (input.asset !== "BCH") requireNetworkTokenCategory(input.asset, input.network);
        const quote = await getIntentQuote({ sell: "PUSD", buy: input.asset, amount: input.amount, network: input.network });
        return { amountAtomic: quote.outputAmount, asset: input.asset, quote };
      }),
    buildSwap: protectedProcedure
      .input(z.object({
        sell: z.enum(["BCH", "PUSD", "MUSD"]),
        buy: z.enum(["BCH", "PUSD", "MUSD"]),
        amount: z.string().trim().min(1).max(80),
        funding: z.array(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), vout: z.number().int().nonnegative(), value: z.string().regex(/^\d+$/), scriptHex: z.string().regex(/^[0-9a-fA-F]+$/), token: z.object({ category: z.string().regex(/^[0-9a-fA-F]{64}$/), amount: z.string().regex(/^\d+$/) }).optional() })).min(1).max(500),
        receiveAddress: z.string().min(20).max(120),
        changeAddress: z.string().min(20).max(120),
        tokenChangeAddress: z.string().min(20).max(120).optional(),
        expectedSellAmountAtomic: z.string().regex(/^\d+$/).optional(),
        side: z.enum(["sell", "buy"]).default("sell"),
        minOutput: z.string().regex(/^\d+$/).optional(),
        network: z.enum(["mainnet", "chipnet"]).default("mainnet"),
      }))
      .mutation(async ({ input }) => {
        const built = input.network === "chipnet" && input.sell === "BCH" && input.buy !== "BCH" && (input.side || "sell") === "buy"
          ? await buildChipnetCauldronBuy(input)
          : input.network === "chipnet" && input.sell !== "BCH" && input.buy === "BCH" && (input.side || "sell") === "buy"
            ? await buildChipnetCauldronSell(input)
            : await buildCauldronSwap(input);
        if (input.network !== "chipnet") return built;
        const prevouts = await verifyChipnetTransactionInputs(built.unsignedTxHex, built.sourceOutputs);
        if (prevouts.unavailable.length && prevouts.missing.length === 0) {
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Could not verify Cauldron's Chipnet transaction inputs with public peers: ${prevouts.unavailable.join(" | ")}` });
        }
        if (!prevouts.valid) {
          const fundingOutpoints = new Set(input.funding.map((item) => `${item.txid.toLowerCase()}:${item.vout}`));
          const missingWalletInputs = prevouts.missing.filter((outpoint) => fundingOutpoints.has(outpoint.toLowerCase()));
          const missingPoolInputs = prevouts.missing.filter((outpoint) => !fundingOutpoints.has(outpoint.toLowerCase()));
          const message = missingWalletInputs.length
            ? `Your selected Chipnet funding input is no longer unspent (${missingWalletInputs.join(", ")}). Refresh the wallet balance before trying again.`
            : `The Cauldron Chipnet pool output is no longer unspent (${missingPoolInputs.join(", ")}). Volta Finance stopped before wallet approval; the route must be rebuilt from current pool outputs.`;
          throw new TRPCError({ code: "PRECONDITION_FAILED", message });
        }
        return built;
      }),
    buildPayrollBatch: protectedProcedure
      .input(z.object({
        payouts: z.array(z.object({ asset: z.enum(["BCH", "PUSD", "MUSD"]), amountAtomic: z.string().regex(/^\d+$/), address: z.string().trim().min(20).max(128) })).min(1).max(50),
        funding: z.array(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), vout: z.number().int().nonnegative(), value: z.string().regex(/^\d+$/), scriptHex: z.string().regex(/^[0-9a-fA-F]+$/) })).min(1).max(500),
        changeAddress: z.string().trim().min(20).max(128),
        network: z.enum(["mainnet", "chipnet"]).default("chipnet"),
      }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        if (input.network !== "chipnet") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The combined Cauldron payroll composer currently supports Chipnet only." });
        const built = await buildChipnetPayrollBatch({ payouts: input.payouts, funding: input.funding, changeAddress: input.changeAddress });
        const prevouts = await verifyChipnetTransactionInputs(built.unsignedTxHex, built.sourceOutputs);
        if (prevouts.unavailable.length && prevouts.missing.length === 0) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Could not verify all combined payroll inputs with Chipnet peers: ${prevouts.unavailable.join(" | ")}` });
        if (!prevouts.valid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A wallet or Cauldron pool input is no longer unspent (${prevouts.missing.join(", ")}). Rebuild the whole payroll batch from current UTXOs.` });
        return built;
      }),
    buildPusdPayrollBatch: protectedProcedure
      .input(z.object({
        payouts: z.array(z.object({ asset: z.enum(["BCH", "PUSD"]), amountAtomic: z.string().regex(/^\d+$/), address: z.string().trim().min(20).max(128) })).min(1).max(50),
        funding: z.array(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), vout: z.number().int().nonnegative(), value: z.string().regex(/^\d+$/), scriptHex: z.string().regex(/^[0-9a-fA-F]+$/), token: z.object({ category: z.string().regex(/^[0-9a-fA-F]{64}$/), amount: z.string().regex(/^\d+$/) }).optional() })).min(1).max(500),
        changeAddress: z.string().trim().min(20).max(128),
        network: z.enum(["mainnet", "chipnet"]).default("chipnet"),
      }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        if (input.network !== "chipnet") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The combined PUSD payroll composer currently supports Chipnet only." });
        const built = await buildChipnetPusdPayrollBatch(input);
        const prevouts = await verifyChipnetTransactionInputs(built.unsignedTxHex, built.sourceOutputs);
        if (prevouts.unavailable.length && prevouts.missing.length === 0) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `Could not verify the combined PUSD payroll inputs with Chipnet peers: ${prevouts.unavailable.join(" | ")}` });
        if (!prevouts.valid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `A wallet or Cauldron pool input is no longer unspent (${prevouts.missing.join(", ")}). Rebuild the PUSD payroll batch from current UTXOs.` });
        return built;
      }),
    utxos: protectedProcedure
      .input(z.object({ address: z.string().min(20).max(120), network: z.enum(["mainnet", "chipnet"]).default("mainnet"), asset: z.enum(["BCH", "PUSD", "MUSD"]).optional() }))
      .query(({ input }) => getWalletUtxos(input)),
    utxosForAddresses: protectedProcedure
      .input(z.object({ addresses: z.array(z.object({ address: z.string().min(20).max(120), addressIndex: z.number().int().min(0).max(99), path: z.enum(["receive", "change", "defi"]).default("receive") })).max(300), network: z.enum(["mainnet", "chipnet"]).default("mainnet"), asset: z.enum(["BCH", "PUSD", "MUSD"]).optional() }))
      // Address scans carry many derived addresses. Keep this as a mutation so
      // tRPC sends the payload in a POST body instead of an oversized GET URL.
      .mutation(({ input }) => getWalletUtxosForAddresses(input)),
    broadcastTransaction: protectedProcedure
      .input(z.object({ rawTransaction: z.string().regex(/^[0-9a-fA-F]+$/).max(500_000), network: z.enum(["mainnet", "chipnet"]) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        return { txid: input.network === "chipnet" ? await broadcastChipnetTransaction(input.rawTransaction) : await getProvider(input.network).sendRawTransaction(input.rawTransaction) };
      }),
    recordBroadcast: protectedProcedure
      .input(z.object({ intentId: z.number().int().positive(), txid: z.string().regex(/^[0-9a-fA-F]{64}$/) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        return markPaymentIntentBroadcast({ workspaceId: workspace.id, intentId: input.intentId, txid: input.txid });
      }),
    transactionStatus: protectedProcedure
      .input(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .query(({ input }) => getTransactionStatus(input)),
    transactionInputSources: protectedProcedure
      .input(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), network: z.enum(["mainnet", "chipnet"]) }))
      .mutation(({ input }) => getTransactionInputSources(input)),
    verifyOutput: protectedProcedure
      .input(z.object({ txid: z.string().regex(/^[0-9a-fA-F]{64}$/), recipientAddress: z.string().min(20).max(120), expectedAsset: z.enum(["BCH", "PUSD", "MUSD"]), expectedAmountAtomic: z.string().regex(/^\d+$/), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(async ({ input }) => {
        if (input.expectedAsset !== "BCH") requireNetworkTokenCategory(input.expectedAsset, input.network);
        const status = await getTransactionStatus(input);
        if (!status.found) return { status: "not_found" as const, confirmations: 0, verified: false };
        if (status.confirmations < 1) return { status: "pending" as const, confirmations: status.confirmations, verified: false };
        const verification = await verifyRecipientOutput({ ...input, tokenCategory: input.expectedAsset === "BCH" ? undefined : getCashTokenCategories(input.network)[input.expectedAsset] });
        return { status: verification.verified ? "verified" as const : "rejected" as const, confirmations: status.confirmations, verified: verification.verified, receivedAmountAtomic: verification.amountAtomic };
      }),
    verifyAndPost: protectedProcedure
      .input(z.object({ intentId: z.number().int().positive(), txid: z.string().regex(/^[0-9a-fA-F]{64}$/), recipientAddress: z.string().min(20).max(120), expectedAsset: z.enum(["BCH", "PUSD", "MUSD"]), expectedAmountAtomic: z.string().regex(/^\d+$/), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(async ({ ctx, input }) => {
        if (input.expectedAsset !== "BCH") requireNetworkTokenCategory(input.expectedAsset, input.network);
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const intent = await getPaymentIntentForWorkspace(workspace.id, input.intentId);
        if (!intent) throw new Error("Payment intent was not found in this workspace");
        if (!intent.recipientAddress || input.recipientAddress !== intent.recipientAddress) throw new TRPCError({ code: "BAD_REQUEST", message: "Verification address does not match the recipient saved on this payment intent." });
        if (input.expectedAsset !== intent.recipientAsset) throw new TRPCError({ code: "BAD_REQUEST", message: "Verification asset does not match the recipient asset saved on this payment intent." });
        const status = await getTransactionStatus(input);
        if (!status.found || status.confirmations < 1) return { status: "pending" as const, confirmations: status.confirmations, verified: false };
        const verification = await verifyRecipientOutput({ ...input, tokenCategory: input.expectedAsset === "BCH" ? undefined : getCashTokenCategories(input.network)[input.expectedAsset] });
        return { ...(await finalizeVerifiedIntent({ workspaceId: workspace.id, intentId: intent.id, txid: input.txid, verified: verification.verified, verifiedAmountAtomic: verification.amountAtomic })), confirmations: status.confirmations, verified: verification.verified, receivedAmountAtomic: verification.amountAtomic };
      }),
    workspace: protectedProcedure.query(async ({ ctx }) => getOrCreateWorkspaceForUser(ctx.user.id)),
    listInvoices: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      const rows = await listInvoicesForWorkspace(workspace.id);
      return presentInvoicesWithPayment(rows);
    }),
    workspacePaymentMetrics: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      return getWorkspacePaymentMetrics(workspace.id);
    }),
    financialRecords: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      if (workspace.type === "organization") await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      return getFinancialRecordsForWorkspace(workspace.id, ctx.user.email);
    }),
    createInvoice: protectedProcedure
      .input(z.object({ clientName: z.string().trim().min(1).max(200), amount: z.string().trim().min(1).max(80), requestAsset: z.enum(["USDT", "BCH", "PUSD", "MUSD"]).default("USDT"), asset: z.enum(["BCH", "PUSD", "MUSD", "XLM"]), dueDate: z.string().trim().min(1).max(40), destinationId: z.number().int().positive().optional(), stellarDestinationId: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const isStellarDelivery = input.asset === "XLM";
        const settlementAsset: Asset = input.asset === "XLM" ? "PUSD" : input.asset;
        let receivingAddress: string;
        let deliveryAsset: "XLM" | null = null;
        let deliveryNetwork: "stellar-testnet" | null = null;
        if (isStellarDelivery) {
          const destination = input.stellarDestinationId ? await getStellarDestinationForUser({ userId: ctx.user.id, destinationId: input.stellarDestinationId }) : undefined;
          if (!destination || !validateStellarPublicKey(destination.address)) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a saved Stellar Testnet address from Profile settings." });
          receivingAddress = destination.address;
          deliveryAsset = "XLM";
          deliveryNetwork = "stellar-testnet";
        } else {
          const destination = input.destinationId ? await getPaymentDestinationForUser({ userId: ctx.user.id, destinationId: input.destinationId, asset: settlementAsset, network: "chipnet" }) : undefined;
          if (!destination) throw new TRPCError({ code: "BAD_REQUEST", message: `Choose a saved testnet (Chipnet) ${input.asset} receiving address from Profile settings.` });
          receivingAddress = destination.address;
        }
        const created = await createInvoiceForWorkspace({
          workspaceId: workspace.id,
          createdByUserId: ctx.user.id,
          senderName: workspace.name,
          senderEmail: ctx.user.email,
          description: input.clientName,
          clientName: input.clientName,
          amountAtomic: toInvoiceAtomicAmount(input.amount, input.requestAsset),
          displayAmount: input.amount,
          requestAsset: input.requestAsset,
          asset: settlementAsset,
          deliveryAsset,
          deliveryNetwork,
          dueDate: input.dueDate,
          receivingAddress,
        });
        return presentInvoice(created);
      }),
    updateDraftInvoice: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), clientName: z.string().trim().min(1).max(200), amount: z.string().trim().min(1).max(80), asset: z.enum(["BCH", "PUSD", "MUSD", "XLM"]), dueDate: z.string().trim().min(1).max(40), destinationId: z.number().int().positive().optional(), stellarDestinationId: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const existing = await getInvoiceForWorkspace(workspace.id, input.publicId);
        if (!existing || existing.status !== "draft") throw new TRPCError({ code: "NOT_FOUND", message: "Only saved invoice drafts can be edited." });
        const isStellarDelivery = input.asset === "XLM";
        const settlementAsset: Asset = input.asset === "XLM" ? "PUSD" : input.asset;
        let receivingAddress: string;
        let deliveryAsset: "XLM" | null = null;
        let deliveryNetwork: "stellar-testnet" | null = null;
        if (isStellarDelivery) {
          const destination = input.stellarDestinationId ? await getStellarDestinationForUser({ userId: ctx.user.id, destinationId: input.stellarDestinationId }) : undefined;
          if (!destination || !validateStellarPublicKey(destination.address)) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a saved Stellar Testnet address from Profile settings." });
          receivingAddress = destination.address;
          deliveryAsset = "XLM";
          deliveryNetwork = "stellar-testnet";
        } else {
          const destination = input.destinationId ? await getPaymentDestinationForUser({ userId: ctx.user.id, destinationId: input.destinationId, asset: settlementAsset, network: "chipnet" }) : undefined;
          if (!destination) throw new TRPCError({ code: "BAD_REQUEST", message: `Choose a saved testnet (Chipnet) ${input.asset} receiving address from Profile settings.` });
          receivingAddress = destination.address;
        }
        const updated = await updateDraftInvoiceForWorkspace({
          workspaceId: workspace.id,
          userId: ctx.user.id,
          publicId: input.publicId,
          clientName: input.clientName,
          amountAtomic: toInvoiceAtomicAmount(input.amount, "USDT"),
          displayAmount: input.amount,
          requestAsset: "USDT",
          asset: settlementAsset,
          deliveryAsset,
          deliveryNetwork,
          dueDate: input.dueDate,
          receivingAddress,
        });
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "This draft is no longer available to edit." });
        return presentInvoice(updated);
      }),
    invoiceRecipientTargets: publicProcedure
      .input(z.object({ email: z.string().trim().email().max(320) }))
      .query(async ({ input }) => {
        const targets = await listInvoiceRecipientTargets(input.email);
        if (!targets) return { registered: false as const, personal: null, organizations: [] };
        return { registered: true as const, personal: targets.personal ? { id: targets.personal.id, name: targets.personal.name } : null, organizations: targets.organizations.map(({ id, name }) => ({ id, name })) };
      }),
    sendInvoice: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), recipientEmail: z.string().trim().email().max(320), recipientType: z.enum(["personal", "organization"]).default("personal"), recipientWorkspaceId: z.number().int().positive().optional() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const draft = await getInvoiceForWorkspace(workspace.id, input.publicId);
        if (!draft || draft.status !== "draft") throw new TRPCError({ code: "NOT_FOUND", message: "This invoice draft is no longer available to send." });
        const targets = await listInvoiceRecipientTargets(input.recipientEmail);
        if (!targets) throw new TRPCError({ code: "NOT_FOUND", message: "The recipient needs a Volta Finance account before they can receive an in-platform invoice." });
        const recipient = targets.user;
        if (recipient.id === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose another registered Volta Finance account as the invoice recipient." });
        let recipientWorkspace = targets.personal;
        if (input.recipientType === "organization") {
          recipientWorkspace = targets.organizations.find((candidate) => candidate.id === input.recipientWorkspaceId) ?? null;
          if (!recipientWorkspace) throw new TRPCError({ code: "FORBIDDEN", message: "Organization delivery is available only to an organization owned by this email address. Staff email addresses cannot receive invoices for an organization." });
        } else if (!recipientWorkspace) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This account has no personal workspace to receive invoices." });
        }
        const sent = await sendDraftInvoice({ workspaceId: workspace.id, userId: ctx.user.id, publicId: input.publicId, recipientUserId: recipient.id, recipientWorkspaceId: recipientWorkspace.id, recipientEmail: recipient.email });
        if (!sent) throw new TRPCError({ code: "CONFLICT", message: "This invoice draft was already sent." });
        return presentInvoice(sent);
      }),
    incomingInvoices: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      if (workspace.type === "organization") await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      const rows = await listInvoiceInboxForUser({ workspaceId: workspace.id, userId: ctx.user.id });
      return presentInvoicesWithPayment(rows);
    }),
    submitExternalInvoice: publicProcedure
      .input(z.object({ recipientEmail: z.string().trim().email().max(320), recipientType: z.enum(["personal", "organization"]).default("personal"), recipientWorkspaceId: z.number().int().positive().optional(), senderName: z.string().trim().min(1).max(200), senderEmail: z.string().trim().email().max(320), description: z.string().trim().min(1).max(500), amount: z.string().trim().min(1).max(80), requestAsset: z.enum(["USDT", "BCH", "PUSD", "MUSD"]).default("USDT"), asset: z.enum(["BCH", "PUSD", "MUSD"]), dueDate: z.string().trim().min(1).max(40), receivingAddress: z.string().trim().min(20).max(128) }))
      .mutation(async ({ ctx, input }) => {
        enforceGuestInvoiceRate(ctx.req.ip || "unknown");
        const targets = await listInvoiceRecipientTargets(input.recipientEmail);
        if (!targets) throw new TRPCError({ code: "NOT_FOUND", message: "Invoices can only be sent to a registered Volta Finance email address." });
        const recipient = targets.user;
        let recipientWorkspace = targets.personal;
        if (input.recipientType === "organization") {
          recipientWorkspace = targets.organizations.find((candidate) => candidate.id === input.recipientWorkspaceId) ?? null;
          if (!recipientWorkspace) throw new TRPCError({ code: "FORBIDDEN", message: "Organization delivery is available only when the email belongs to an organization owner. Staff emails cannot receive invoices for an organization." });
        } else if (!recipientWorkspace) {
          throw new TRPCError({ code: "NOT_FOUND", message: "This account has no personal inbox to receive the invoice." });
        }
        const address = cashAddressToLockingBytecode(input.receivingAddress);
        if (typeof address === "string" || address.prefix !== "bchtest") throw new TRPCError({ code: "BAD_REQUEST", message: "Enter a valid Bitcoin Cash testnet (Chipnet) receiving address starting with bchtest:." });
        if (input.asset !== "BCH" && !address.tokenSupport) throw new TRPCError({ code: "BAD_REQUEST", message: "PUSD and MUSD invoices need a CashTokens-aware receiving address." });
        const invoice = await createExternalInvoiceSubmission({ recipientUserId: recipient.id, workspaceId: recipientWorkspace.id, recipientEmail: recipient.email, senderName: input.senderName, senderEmail: input.senderEmail, description: input.description, amountAtomic: toInvoiceAtomicAmount(input.amount, input.requestAsset), displayAmount: input.amount, requestAsset: input.requestAsset, asset: input.asset, dueDate: input.dueDate, receivingAddress: input.receivingAddress });
        return { submitted: true as const, publicId: invoice.publicId, message: "Invoice submitted for recipient review. They must sign in and accept it before payment." };
      }),
    reviewIncomingInvoice: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), decision: z.enum(["accept", "decline"]) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        if (workspace.type === "organization") await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const result = await updateIncomingInvoiceStatus({ userId: ctx.user.id, workspaceId: workspace.id, publicId: input.publicId, status: input.decision === "accept" ? "awaiting_payment" : "cancelled" });
        if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "This invoice is no longer awaiting your review." });
        return presentInvoice(result);
      }),
    payInvoiceBatch: protectedProcedure
      .input(z.object({ publicIds: z.array(z.string().trim().min(1).max(32)).min(1).max(5), txid: z.string().regex(/^[0-9a-fA-F]{64}$/), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(async ({ ctx, input }) => {
        const uniqueIds = [...new Set(input.publicIds)];
        if (uniqueIds.length !== input.publicIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "An invoice was selected more than once." });
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const selected = await Promise.all(uniqueIds.map((publicId) => getInvoiceForRecipient({ workspaceId: workspace.id, userId: ctx.user.id, publicId })));
        if (selected.some((invoice) => !invoice || !["awaiting_payment", "awaiting_verification"].includes(invoice.status) || !invoice.receivingAddress || (invoice.status === "awaiting_verification" && invoice.paymentTxid !== input.txid))) throw new TRPCError({ code: "BAD_REQUEST", message: "Every selected invoice must be accepted and awaiting payment with this transaction." });
        const invoicesToPay = selected as NonNullable<(typeof selected)[number]>[];
        if (invoicesToPay.some((invoice) => invoice.deliveryAsset === "XLM")) throw new TRPCError({ code: "BAD_REQUEST", message: "Stellar Testnet invoices must be paid through their invoice crosschain intent." });
        const asset = invoicesToPay[0].asset;
        if (asset !== "BCH") requireNetworkTokenCategory(asset, input.network);
        if (invoicesToPay.some((invoice) => invoice.asset !== asset)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pay up to five invoices together when they all request the same asset." });
        if (invoicesToPay.some((invoice) => invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset)) && invoicesToPay.length > 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Pay an invoice whose requested and receiving units differ on its own so its live quote can be verified." });
        const transaction = await getTransactionStatus({ txid: input.txid, network: input.network });
        if (!transaction.found || transaction.confirmations < 1) return { status: "pending" as const, confirmations: transaction.confirmations, verified: false };
        const totalsByAddress = new Map<string, bigint>();
        for (const invoice of invoicesToPay) totalsByAddress.set(invoice.receivingAddress!, (totalsByAddress.get(invoice.receivingAddress!) || 0n) + BigInt(invoice.receivedAmountAtomic || invoice.amountAtomic));
        const verifiedByAddress = new Map<string, string>();
        for (const [recipientAddress, expectedAmountAtomic] of totalsByAddress) {
          const verification = await verifyRecipientOutput({ txid: input.txid, recipientAddress, expectedAsset: asset, expectedAmountAtomic: expectedAmountAtomic.toString(), tokenCategory: asset === "BCH" ? undefined : requireNetworkTokenCategory(asset, input.network), network: input.network });
          if (!verification.verified) throw new TRPCError({ code: "BAD_REQUEST", message: `The confirmed transaction does not contain the full ${asset} payment for ${recipientAddress}.` });
          verifiedByAddress.set(recipientAddress, verification.amountAtomic);
        }
        const settled = await finalizeInvoiceBatch({ payerWorkspaceId: workspace.id, payerUserId: ctx.user.id, invoices: invoicesToPay.map((invoice) => ({ id: invoice.id, publicId: invoice.publicId, workspaceId: invoice.workspaceId, amountAtomic: invoice.amountAtomic, requestAsset: invoice.requestAsset, receivedAmountAtomic: invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset) ? verifiedByAddress.get(invoice.receivingAddress!)! : invoice.receivedAmountAtomic || invoice.amountAtomic, asset: invoice.asset, clientName: invoice.clientName })), txid: input.txid });
        return { ...settled, confirmations: transaction.confirmations, verified: true };
      }),
    markInvoiceBatchBroadcast: protectedProcedure
      .input(z.object({ payments: z.array(z.object({ publicId: z.string().trim().min(1).max(32), intentId: z.number().int().positive().optional() })).min(1).max(5), txid: z.string().regex(/^[0-9a-fA-F]{64}$/) }))
      .mutation(async ({ ctx, input }) => {
        const publicIds = input.payments.map((payment) => payment.publicId);
        if (new Set(publicIds).size !== publicIds.length) throw new TRPCError({ code: "BAD_REQUEST", message: "An invoice was selected more than once." });
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const selected = await Promise.all(publicIds.map((publicId) => getInvoiceForRecipient({ workspaceId: workspace.id, userId: ctx.user.id, publicId })));
        if (selected.some((invoice) => !invoice || invoice.status !== "awaiting_payment")) throw new TRPCError({ code: "BAD_REQUEST", message: "One or more invoices are no longer awaiting payment." });
        const invoicesToMark = selected as NonNullable<(typeof selected)[number]>[];
        if (invoicesToMark.some((invoice) => invoice.asset !== invoicesToMark[0].asset)) throw new TRPCError({ code: "BAD_REQUEST", message: "A batch must contain invoices for the same asset." });
        if (invoicesToMark.some((invoice) => invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset)) && invoicesToMark.length > 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Pay an invoice whose requested and receiving units differ individually." });
        if (input.payments.some((payment) => payment.intentId !== undefined) && invoicesToMark.length > 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Pay converted invoice transactions one at a time." });
        const receivedAmounts = await Promise.all(invoicesToMark.map(async (invoice, index) => {
          const intentId = input.payments[index].intentId;
          if (intentId === undefined) {
            if (invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset)) throw new TRPCError({ code: "BAD_REQUEST", message: "A saved quote is required to convert the requested amount into the receiving asset." });
            return { publicId: invoice.publicId, amountAtomic: invoice.amountAtomic };
          }
          const intent = await getPaymentIntentForWorkspace(workspace.id, intentId);
          const savedQuote = intent?.quote as { invoicePublicId?: string; requestedAsset?: string; requestedAmountAtomic?: string; outputAmountAtomic?: string } | null;
          if (!intent || intent.createdByUserId !== ctx.user.id || intent.status !== "pending_verification" || intent.txid !== input.txid || intent.recipientAsset !== invoice.asset || intent.recipientAddress !== invoice.receivingAddress || savedQuote?.invoicePublicId !== invoice.publicId || savedQuote.requestedAsset !== invoice.requestAsset || savedQuote.requestedAmountAtomic !== invoice.amountAtomic || savedQuote.outputAmountAtomic !== intent.expectedOutputAtomic || (!invoiceNeedsAssetConversion(invoice.requestAsset, invoice.asset) && intent.expectedOutputAtomic !== invoice.amountAtomic)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "The saved conversion quote does not match this invoice payment." });
          }
          return { publicId: invoice.publicId, amountAtomic: intent.expectedOutputAtomic };
        }));
        await markInvoiceBatchBroadcast({ userId: ctx.user.id, workspaceId: workspace.id, receivedAmounts, txid: input.txid });
        return { status: "awaiting_verification" as const, txid: input.txid };
      }),
    createPaymentLink: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const invoice = await getInvoiceForWorkspace(workspace.id, input.publicId);
        if (!invoice) throw new Error("Invoice was not found in this workspace");
        if (!invoice.receivingAddress) throw new Error("Add the receiving BCH address before creating a live payment link");
        const paymentLinkAsset = invoice.requestAsset === "USDT" ? "PUSD" : invoice.requestAsset;
        if (paymentLinkAsset !== invoice.asset) throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice requires an on-chain conversion quote. Pay it from the recipient’s Volta Finance inbox so the requested amount is converted to the saved receiving asset." });
        const result = await createPaymentHubInvoice({ amount: invoice.displayAmount, asset: invoice.asset, memo: `Volta Finance invoice ${invoice.publicId}` });
        const updated = await attachExternalInvoice({ workspaceId: workspace.id, publicId: invoice.publicId, externalInvoiceId: result.externalInvoiceId, paymentUrl: result.paymentUrl });
        return { invoice: updated ? presentInvoice(updated) : presentInvoice(invoice), paymentUrl: result.paymentUrl, externalInvoiceId: result.externalInvoiceId };
      }),
    verifyInvoicePayment: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32), network: z.enum(["mainnet", "chipnet"]).default("mainnet") }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const invoice = await getInvoiceForWorkspace(workspace.id, input.publicId);
        if (!invoice) throw new Error("Invoice was not found in this workspace");
        const paymentLinkAsset = invoice.requestAsset === "USDT" ? "PUSD" : invoice.requestAsset;
        if (paymentLinkAsset !== invoice.asset) throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice needs the live conversion flow from the recipient’s Volta Finance inbox." });
        if (!invoice.paymentTxid) throw new Error("The payment provider has not supplied a transaction id yet");
        if (!invoice.receivingAddress) throw new Error("Add the receiving BCH address before verifying this invoice");
        const invoiceNetwork = invoice.receivingAddress.startsWith("bchtest:") ? "chipnet" : "mainnet";
        if (input.network !== invoiceNetwork) throw new TRPCError({ code: "BAD_REQUEST", message: `This invoice is on ${invoiceNetwork}; verify it on the same network.` });
        if (invoice.asset !== "BCH") requireNetworkTokenCategory(invoice.asset, invoiceNetwork);
        const transaction = await getTransactionStatus({ txid: invoice.paymentTxid, network: invoiceNetwork });
        if (!transaction.found || transaction.confirmations < 1) return { status: "pending" as const, confirmations: transaction.confirmations, verified: false };
        const expectedAmountAtomic = invoice.receivedAmountAtomic || invoice.amountAtomic;
        const verification = await verifyRecipientOutput({ txid: invoice.paymentTxid, recipientAddress: invoice.receivingAddress, expectedAsset: invoice.asset, expectedAmountAtomic, network: invoiceNetwork, tokenCategory: invoice.asset === "BCH" ? undefined : requireNetworkTokenCategory(invoice.asset, invoiceNetwork) });
        if (!verification.verified) return { status: "rejected" as const, confirmations: transaction.confirmations, verified: false };
        return { ...(await finalizeVerifiedInvoice({ workspaceId: workspace.id, publicId: invoice.publicId, txid: invoice.paymentTxid, verifiedAmountAtomic: expectedAmountAtomic })), confirmations: transaction.confirmations, verified: true };
      }),
    invoiceDocument: protectedProcedure
      .input(z.object({ publicId: z.string().trim().min(1).max(32) }))
      .query(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const invoice = await getInvoiceForWorkspace(workspace.id, input.publicId);
        if (!invoice) throw new Error("Invoice was not found in this workspace");
        if (!invoice.receiptHtml) throw new Error("A verified receipt is not available yet");
        return { publicId: invoice.publicId, html: invoice.receiptHtml, filename: `${invoice.publicId}-receipt.html` };
      }),
    payrollData: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireOrganizationWorkspace(workspace);
      await requireWorkspaceAdmin(ctx.user.id, workspace.id);
      const [employees, runs, members] = await Promise.all([listEmployeesForWorkspace(workspace.id), listPayrollRunsForWorkspace(workspace.id), listOrganizationMembersForWorkspace(workspace.id)]);
      const items = runs.length ? await listPayrollItemsForRun(workspace.id, runs[0].id) : [];
      const employeesWithPersonalAddresses = await Promise.all(employees.map(async (employee) => {
        if (!employee.email) return { ...employee, walletAddress: null, walletNetwork: null, bchAddress: null, bchNetwork: null, tokenAddress: null, tokenNetwork: null, stellarAddress: null, stellarNetwork: null };
        const [bchDestination, tokenDestination, stellarDestination] = await Promise.all([
          getPersonalPayrollDestination({ email: employee.email, asset: "BCH" }),
          getPersonalPayrollDestination({ email: employee.email, asset: "PUSD" }),
          getPersonalStellarDestination({ email: employee.email }),
        ]);
        const isStellarAsset = employee.preferredAsset === "XLM" || employee.preferredAsset === "USDC";
        const destination = isStellarAsset ? stellarDestination : employee.preferredAsset === "BCH" ? bchDestination : tokenDestination;
        return { ...employee, walletAddress: destination?.address ?? null, walletNetwork: isStellarAsset ? (stellarDestination ? "stellar-testnet" : null) : destination && "network" in destination ? destination.network : null, bchAddress: bchDestination?.address ?? null, bchNetwork: bchDestination?.network ?? null, tokenAddress: tokenDestination?.address ?? null, tokenNetwork: tokenDestination?.network ?? null, stellarAddress: stellarDestination?.address ?? null, stellarNetwork: stellarDestination ? "stellar-testnet" as const : null };
      }));
      return { employees: employeesWithPersonalAddresses, runs, latestItems: items, members: members.map((member) => { const payrollEmployee = employeesWithPersonalAddresses.find((employee) => employee.email?.toLowerCase() === member.email.toLowerCase()); return { ...member, payrollEmployeeId: payrollEmployee?.id ?? null, payrollActive: Boolean(payrollEmployee?.active), payrollRoleTitle: payrollEmployee?.roleTitle ?? null, payrollAmount: payrollEmployee?.monthlyDisplayAmount ?? null, payrollAmountUnit: payrollEmployee?.monthlyAmountUnit ?? null, payrollPreferredAsset: payrollEmployee?.preferredAsset ?? null, stellarAddress: payrollEmployee?.stellarAddress ?? null }; }) };
    }),
    employeePayroll: protectedProcedure.query(async ({ ctx }) => {
      const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
      await requireOrganizationWorkspace(workspace);
      if (!await getWorkspaceRoleForUser({ userId: ctx.user.id, workspaceId: workspace.id })) throw new TRPCError({ code: "FORBIDDEN", message: "Join this organization to view your payroll profile." });
      return getEmployeePayrollForUser({ workspaceId: workspace.id, email: ctx.user.email });
    }),
    addPayrollMember: protectedProcedure
      .input(z.object({ memberUserId: z.number().int().positive(), roleTitle: z.string().trim().min(1).max(120), amount: z.string().trim().min(1).max(80) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        return addMemberToPayroll({ workspaceId: workspace.id, actorUserId: ctx.user.id, memberUserId: input.memberUserId, roleTitle: input.roleTitle, amountAtomic: toAtomicAmount(input.amount, "PUSD"), displayAmount: input.amount });
      }),
    addPayrollMembers: protectedProcedure
      .input(z.object({ members: z.array(z.object({ memberUserId: z.number().int().positive(), roleTitle: z.string().trim().min(1).max(120), amount: z.string().trim().min(1).max(80) })).min(1).max(100) }).superRefine(({ members }, context) => {
        const ids = members.map((member) => member.memberUserId);
        if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "A staff member was selected more than once." });
      }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        return addMembersToPayroll({ workspaceId: workspace.id, actorUserId: ctx.user.id, members: input.members.map((member) => ({ memberUserId: member.memberUserId, roleTitle: member.roleTitle, amountAtomic: toAtomicAmount(member.amount, "PUSD"), displayAmount: member.amount })) });
      }),
    updatePayrollEnrollment: protectedProcedure
      .input(z.object({ employeeId: z.number().int().positive(), active: z.boolean().optional(), roleTitle: z.string().trim().min(1).max(120).optional(), amount: z.string().trim().min(1).max(80).optional() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const employee = (await listEmployeesForWorkspace(workspace.id)).find((row) => row.id === input.employeeId);
        if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "Payroll member was not found." });
        const amount = input.amount === undefined ? {} : { amountAtomic: toAtomicAmount(input.amount, "PUSD"), displayAmount: input.amount };
        const updated = await updateEmployeePayrollEnrollment({ workspaceId: workspace.id, actorUserId: ctx.user.id, employeeId: input.employeeId, active: input.active, roleTitle: input.roleTitle, ...amount });
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Payroll member was not found." });
        return updated;
      }),
    updateMyPayrollPreference: protectedProcedure
      .input(z.object({ asset: z.enum(["BCH", "PUSD", "MUSD", "XLM", "USDC"]) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        if (!await getWorkspaceRoleForUser({ userId: ctx.user.id, workspaceId: workspace.id })) throw new TRPCError({ code: "FORBIDDEN", message: "Join this organization before setting a payroll destination." });
        const isStellarAsset = input.asset === "XLM" || input.asset === "USDC";
        const destination = isStellarAsset
          ? await getPersonalStellarDestination({ email: ctx.user.email })
          : await getPersonalPayrollDestination({ email: ctx.user.email, asset: input.asset as Asset });
        if (!destination) throw new TRPCError({ code: "PRECONDITION_FAILED", message: isStellarAsset ? "Save a Stellar Testnet address in your personal Profile settings first." : `Set a default Chipnet ${input.asset === "BCH" ? "BCH" : "CashTokens"} receiving address in your personal Profile settings first.` });
        const employee = (await listEmployeesForWorkspace(workspace.id)).find((row) => row.email?.toLowerCase() === ctx.user.email.toLowerCase() && row.active);
        if (!employee) throw new TRPCError({ code: "NOT_FOUND", message: "Ask your organization admin to add you to payroll before setting your payout preference." });
        const updated = await updateEmployeePayoutPreference({ workspaceId: workspace.id, email: ctx.user.email, asset: input.asset });
        if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Your payroll profile could not be updated." });
        return updated;
      }),
    createPayrollRun: protectedProcedure
      .input(z.object({ period: z.string().trim().min(1).max(40), sourceAsset: z.enum(["BCH", "PUSD", "MUSD"]), items: z.array(z.object({ employeeId: z.number().int().positive(), amount: z.string().trim().min(1).max(80) })).min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const employees = await listEmployeesForWorkspace(workspace.id);
        const preferredFor = (item: { employeeId: number }) => employees.find((employee) => employee.id === item.employeeId)?.preferredAsset;
        const stellarInputs = input.items.filter((item) => preferredFor(item) === "XLM" || preferredFor(item) === "USDC");
        const xlmInputs = stellarInputs.filter((item) => preferredFor(item) === "XLM");
        const usdcInputs = stellarInputs.filter((item) => preferredFor(item) === "USDC");
        if (stellarInputs.length && input.sourceAsset !== "PUSD") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Payroll runs with Stellar recipients must use PUSD as the source asset." });
        if (stellarInputs.length > 100) throw new TRPCError({ code: "BAD_REQUEST", message: "A Stellar payroll run can include up to 100 Stellar recipients." });
        if (stellarInputs.length && input.items.length > 50) throw new TRPCError({ code: "BAD_REQUEST", message: "A PUSD-funded payroll run with Stellar recipients can include up to 50 total staff payouts." });
        if (stellarInputs.length && input.items.some((item) => preferredFor(item) === "MUSD")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A PUSD-funded run cannot currently combine Stellar recipients and MUSD recipients. Prepare separate runs." });
        let stellarFunding: { address: string; amountAtomic: string; quote: unknown } | undefined;
        const stellarAmountByEmployee = new Map<number, string>();
        if (stellarInputs.length) {
          const fundingAddress = process.env.CHIPNET_CROSSCHAIN_PUSD_ADDRESS?.trim();
          if (!fundingAddress) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The project Chipnet PUSD deposit address is not configured for Stellar payroll." });
          const decodedFunding = cashAddressToLockingBytecode(fundingAddress);
          if (typeof decodedFunding === "string" || decodedFunding.prefix !== "bchtest" || !decodedFunding.tokenSupport) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The configured Stellar payroll deposit must be a token-aware Chipnet PUSD address." });
          const xlmAmounts = xlmInputs.map((item) => ({ employeeId: item.employeeId, amountAtomic: BigInt(toAtomicAmount(item.amount, "PUSD")) }));
          const usdcAmounts = usdcInputs.map((item) => ({ employeeId: item.employeeId, amountAtomic: BigInt(toAtomicAmount(item.amount, "PUSD")) }));
          const xlmRequestedTotal = xlmAmounts.reduce((sum, item) => sum + item.amountAtomic, 0n);
          const usdcRequestedTotal = usdcAmounts.reduce((sum, item) => sum + item.amountAtomic, 0n);
          const xlmQuote = xlmRequestedTotal > 0n ? await quotePusdToStellarXlm(xlmRequestedTotal.toString()) : null;
          const usdcQuote = usdcRequestedTotal > 0n ? await quotePusdToStellarUsdc(usdcRequestedTotal.toString()) : null;
          if (xlmQuote) {
            const xlmTotal = BigInt(xlmQuote.destinationAmountAtomic);
            let allocated = 0n;
            for (const [index, item] of xlmAmounts.entries()) {
              const amount = index === xlmAmounts.length - 1 ? xlmTotal - allocated : xlmTotal * item.amountAtomic / xlmRequestedTotal;
              if (amount <= 0n) throw new TRPCError({ code: "BAD_REQUEST", message: "A payroll amount is too small to produce a positive XLM payout." });
              stellarAmountByEmployee.set(item.employeeId, amount.toString());
              allocated += amount;
            }
          }
          for (const item of usdcAmounts) stellarAmountByEmployee.set(item.employeeId, (item.amountAtomic * 100_000n).toString());
          stellarFunding = { address: fundingAddress, amountAtomic: (xlmRequestedTotal + usdcRequestedTotal).toString(), quote: { xlm: xlmQuote, usdc: usdcQuote } };
        }
        const items = await Promise.all(input.items.map(async (item) => {
          const employee = employees.find((row) => row.id === item.employeeId);
          if (!employee?.email || !employee.active) throw new TRPCError({ code: "NOT_FOUND", message: "An active payroll member’s personal account could not be found." });
          const payoutAsset = employee.preferredAsset;
          if (payoutAsset === "XLM" || payoutAsset === "USDC") {
            const destination = await getPersonalStellarDestination({ email: employee.email });
            if (!destination || !validateStellarPublicKey(destination.address)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Set a valid Stellar Testnet receiving address for ${employee.fullName} in Profile settings before creating this run.` });
            if (payoutAsset === "USDC" && !stellarInputs.some((stellarItem) => stellarItem.employeeId === item.employeeId)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This USDC payout is missing its Stellar quote." });
            return { employeeId: item.employeeId, amountAtomic: stellarAmountByEmployee.get(item.employeeId)!, requestedAmountAtomic: toAtomicAmount(item.amount, "PUSD"), displayAmount: item.amount, asset: payoutAsset, payoutAddress: destination.address };
          }
          requireNetworkTokenCategory("PUSD", "chipnet");
          if (payoutAsset !== "BCH") requireNetworkTokenCategory(payoutAsset, "chipnet");
          const quote = await getIntentQuote({ sell: "PUSD", buy: payoutAsset, amount: item.amount, network: "chipnet" });
          const destination = await getPersonalPayrollDestination({ email: employee.email, asset: payoutAsset, network: "chipnet" });
          if (!destination) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Set the staff member’s default Chipnet ${payoutAsset === "BCH" ? "BCH" : "CashTokens"} address in Profile settings before creating this run.` });
          return { employeeId: item.employeeId, amountAtomic: quote.outputAmount, requestedAmountAtomic: toAtomicAmount(item.amount, "PUSD"), displayAmount: item.amount, asset: payoutAsset, payoutAddress: destination.address };
        }));
        return createPayrollRunForWorkspace({ workspaceId: workspace.id, actorUserId: ctx.user.id, period: input.period, sourceAsset: input.sourceAsset, items, ...(stellarFunding ? { stellarFunding } : {}) });
      }),
    recordStellarPayrollFunding: protectedProcedure
      .input(z.object({ runId: z.number().int().positive(), txid: z.string().regex(/^[0-9a-fA-F]{64}$/), sourceSpendAtomic: z.string().regex(/^\d+$/), bchCostAtomic: z.string().regex(/^\d+$/) }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        return recordStellarPayrollFunding({ workspaceId: workspace.id, runId: input.runId, txid: input.txid, sourceSpendAtomic: input.sourceSpendAtomic, bchCostAtomic: input.bchCostAtomic });
      }),
    settleStellarPayroll: protectedProcedure
      .input(z.object({ runId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        let run = await getPayrollRunForWorkspace(workspace.id, input.runId);
        if (!run || !run.stellarFundingAddress || !run.stellarFundingAmountAtomic || !run.stellarFundingTxid) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The payroll run has no saved Stellar funding transaction." });
        if (run.stellarPayoutTxid) {
          const savedTransaction = await getStellarTestnetTransactionStatus(run.stellarPayoutTxid);
          if (savedTransaction.found && savedTransaction.successful) {
            if (run.status !== "completed") await completeStellarPayrollRun({ workspaceId: workspace.id, runId: run.id, txid: run.stellarPayoutTxid });
            return { status: "completed" as const, txid: run.stellarPayoutTxid };
          }
          if (savedTransaction.found && !savedTransaction.successful) {
            await resetFailedStellarPayrollForRetry({ workspaceId: workspace.id, runId: run.id, failedTxid: run.stellarPayoutTxid });
            run = await getPayrollRunForWorkspace(workspace.id, input.runId);
            if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Payroll run was not found." });
          } else if (run.status === "completed" && !run.stellarPayoutSignedXdr) {
            return { status: "pending" as const, reason: "stellar_transaction_not_found" as const };
          }
        }
        if (!run.stellarFundingTxid || !run.stellarFundingAddress || !run.stellarFundingAmountAtomic) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The payroll run has no saved Stellar funding transaction." });
        const items = await listPayrollItemsForRun(workspace.id, run.id);
        const stellarItems = items.filter((item) => item.asset === "XLM" || item.asset === "USDC");
        if (!stellarItems.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This payroll run has no Stellar recipients." });
        const pendingBchItems = items.filter((item) => item.asset !== "XLM" && item.asset !== "USDC" && item.status !== "verified");
        if (pendingBchItems.length) return { status: "pending" as const, reason: "chipnet_outputs_pending" as const };

        let payoutTxid = run.stellarPayoutTxid;
        let signedXdr = run.stellarPayoutSignedXdr;
        if (!payoutTxid || !signedXdr) {
          const sourceStatus = await getTransactionStatus({ txid: run.stellarFundingTxid, network: "chipnet" });
          if (!sourceStatus.found || sourceStatus.confirmations < 1) return { status: "pending" as const, confirmations: sourceStatus.confirmations };
          const tokenCategory = getCashTokenCategories("chipnet").PUSD;
          if (!tokenCategory) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PUSD is not configured on Chipnet." });
          const fundingVerification = await verifyRecipientOutput({ txid: run.stellarFundingTxid, recipientAddress: run.stellarFundingAddress, expectedAsset: "PUSD", expectedAmountAtomic: run.stellarFundingAmountAtomic, tokenCategory, network: "chipnet" });
          if (!fundingVerification.verified) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The funding transaction does not contain the full PUSD amount reserved for Stellar payroll." });
          try {
            const prepared = await sendStellarTestnetPayrollBatch({ payouts: stellarItems.map((item) => ({ destination: item.payoutAddress || "", amountAtomic: item.amountAtomic, asset: item.asset as "XLM" | "USDC" })) });
            const saved = await saveStellarPayrollTransaction({ workspaceId: workspace.id, runId: run.id, txid: prepared.txid, signedXdr: prepared.signedXdr });
            payoutTxid = saved.stellarPayoutTxid;
            signedXdr = saved.stellarPayoutSignedXdr;
          } catch (error) {
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error instanceof Error ? error.message : "Could not prepare the Stellar payroll payout." });
          }
        }
        if (!payoutTxid || !signedXdr) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Stellar payroll transaction was not saved safely." });
        try {
          await broadcastStellarTestnetXlm({ signedXdr, expectedTxid: payoutTxid });
          await completeStellarPayrollRun({ workspaceId: workspace.id, runId: run.id, txid: payoutTxid });
          return { status: "completed" as const, txid: payoutTxid };
        } catch (error) {
          if (error instanceof StellarTransactionFailedError) {
            await markStellarPayrollFailed({ workspaceId: workspace.id, runId: run.id, txid: payoutTxid, reason: error.message });
            return { status: "failed" as const, txid: payoutTxid, reason: error.message };
          }
          throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `The Stellar payroll transaction is saved and safe to retry: ${error instanceof Error ? error.message : "Stellar Testnet is unavailable"}` });
        }
      }),
    approvePayrollRun: protectedProcedure
      .input(z.object({ runId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => { const workspace = await getOrCreateWorkspaceForUser(ctx.user.id); await requireOrganizationWorkspace(workspace); await requireWorkspaceAdmin(ctx.user.id, workspace.id); return approvePayrollRun({ workspaceId: workspace.id, actorUserId: ctx.user.id, runId: input.runId }); }),
    updatePayrollRun: protectedProcedure
      .input(z.object({ runId: z.number().int().positive(), status: z.enum(["processing", "completed", "partial", "failed", "cancelled"]), txid: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(), sourceSpendAtomic: z.string().regex(/^\d+$/).optional(), bchCostAtomic: z.string().regex(/^\d+$/).optional() }))
      .mutation(async ({ ctx, input }) => { const workspace = await getOrCreateWorkspaceForUser(ctx.user.id); await requireOrganizationWorkspace(workspace); await requireWorkspaceAdmin(ctx.user.id, workspace.id); return updatePayrollRunStatus({ workspaceId: workspace.id, runId: input.runId, status: input.status }); }),
    updatePayrollRunSourceAsset: protectedProcedure
      .input(z.object({ runId: z.number().int().positive(), sourceAsset: z.enum(["BCH", "PUSD", "MUSD"]) }))
      .mutation(async ({ ctx, input }) => { const workspace = await getOrCreateWorkspaceForUser(ctx.user.id); await requireOrganizationWorkspace(workspace); await requireWorkspaceAdmin(ctx.user.id, workspace.id); return updatePayrollRunSourceAsset({ workspaceId: workspace.id, runId: input.runId, sourceAsset: input.sourceAsset }); }),
    updatePayrollItem: protectedProcedure
      .input(z.object({ itemId: z.number().int().positive(), status: z.enum(["quoted", "awaiting_signature", "broadcast", "verified", "failed"]), intentId: z.number().int().positive().optional(), txid: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(), failureReason: z.string().max(500).optional(), amountAtomic: z.string().regex(/^\d+$/).optional() }))
      .mutation(async ({ ctx, input }) => { const workspace = await getOrCreateWorkspaceForUser(ctx.user.id); await requireOrganizationWorkspace(workspace); await requireWorkspaceAdmin(ctx.user.id, workspace.id); return updatePayrollItem({ ...input, workspaceId: workspace.id }); }),
    verifyPayrollItem: protectedProcedure
      .input(z.object({ itemId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const workspace = await getOrCreateWorkspaceForUser(ctx.user.id);
        await requireOrganizationWorkspace(workspace);
        await requireWorkspaceAdmin(ctx.user.id, workspace.id);
        const item = await getPayrollItemForWorkspace(workspace.id, input.itemId);
        if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Payroll item was not found in this organization." });
        if (item.status === "verified") return { status: "verified" as const, confirmations: 0, txid: item.txid };
        if (!item.intentId || !item.txid || !item.payoutAddress) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This payroll item has no saved broadcast transaction to verify." });
        const intent = await getPaymentIntentForWorkspace(workspace.id, item.intentId);
        if (!intent || intent.txid !== item.txid || intent.recipientAsset !== item.asset || intent.recipientAddress !== item.payoutAddress || intent.expectedOutputAtomic !== item.amountAtomic) {
          throw new TRPCError({ code: "CONFLICT", message: "The saved payroll transaction does not match this recipient, asset, or payout amount." });
        }
        const network = item.payoutAddress.startsWith("bchtest:") ? "chipnet" : "mainnet";
        const txStatus = await getTransactionStatus({ txid: item.txid, network });
        if (!txStatus.found) return { status: "pending" as const, confirmations: 0, txid: item.txid };
        if (txStatus.confirmations < 1) {
          await updatePayrollItem({ workspaceId: workspace.id, itemId: item.id, status: "broadcast", intentId: intent.id, txid: item.txid });
          return { status: "pending" as const, confirmations: txStatus.confirmations, txid: item.txid };
        }
        const tokenCategory = item.asset === "BCH" ? undefined : requireNetworkTokenCategory(item.asset, network);
        const verification = await verifyRecipientOutput({ txid: item.txid, recipientAddress: item.payoutAddress, expectedAsset: item.asset, expectedAmountAtomic: intent.expectedOutputAtomic, tokenCategory, network });
        if (!verification.verified) return { status: "rejected" as const, confirmations: txStatus.confirmations, txid: item.txid };
        await finalizeVerifiedIntent({ workspaceId: workspace.id, intentId: intent.id, txid: item.txid, verified: true, verifiedAmountAtomic: verification.amountAtomic });
        await updatePayrollItem({ workspaceId: workspace.id, itemId: item.id, status: "verified", intentId: intent.id, txid: item.txid });
        const [run, employee] = await Promise.all([
          getPayrollRunForWorkspace(workspace.id, item.runId),
          listEmployeesForWorkspace(workspace.id).then((rows) => rows.find((row) => row.id === item.employeeId)),
        ]);
        if (run && employee) {
          const escape = (value: string) => value.replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
          const documentHtml = `<article><h1>Volta Finance payslip</h1><p><strong>Employee:</strong> ${escape(employee.fullName)}</p><p><strong>Period:</strong> ${escape(run.period)}</p><p><strong>Requested:</strong> ${escape(item.displayAmount)} ${item.requestedAmountUnit}</p><p><strong>Received:</strong> ${escape(formatAtomicAmount(verification.amountAtomic, item.asset))} ${item.asset}</p><p><strong>Receiving address:</strong> ${escape(item.payoutAddress)}</p><p><strong>Transaction:</strong> ${escape(item.txid)}</p><p><strong>Status:</strong> Verified on Bitcoin Cash</p></article>`;
          await createPayslipForItem({ workspaceId: workspace.id, runId: item.runId, payrollItemId: item.id, employeeId: item.employeeId, documentHtml });
        }
        const allItems = await listPayrollItemsForRun(workspace.id, item.runId);
        const verifiedCount = allItems.filter((row) => row.id === item.id || row.status === "verified").length;
        const runStatus = verifiedCount === allItems.length ? "completed" : verifiedCount > 0 ? "partial" : "processing";
        await updatePayrollRunStatus({ workspaceId: workspace.id, runId: item.runId, status: runStatus });
        return { status: "verified" as const, confirmations: txStatus.confirmations, txid: item.txid };
      }),
    createPayslip: protectedProcedure
      .input(z.object({ runId: z.number().int().positive(), payrollItemId: z.number().int().positive(), employeeId: z.number().int().positive(), documentHtml: z.string().max(100_000) }))
      .mutation(async ({ ctx, input }) => { const workspace = await getOrCreateWorkspaceForUser(ctx.user.id); await requireOrganizationWorkspace(workspace); await requireWorkspaceAdmin(ctx.user.id, workspace.id); const run = await getPayrollRunForWorkspace(workspace.id, input.runId); if (!run) throw new Error("Payroll run was not found in this workspace"); return createPayslipForItem({ ...input, workspaceId: workspace.id }); }),
  }),
});

export type AppRouter = typeof appRouter;

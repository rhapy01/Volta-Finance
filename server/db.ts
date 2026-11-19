import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { cashAddressToLockingBytecode } from "@bitauth/libauth";
import * as schema from "../drizzle/schema";
import { type Asset, type PayrollAsset, type PaymentDestinationAsset, type TreasuryPlanConfiguration, auditEvents, blockchainTransactions, crosschainIntents, employees, invoices, ledgerEntries, notifications, paymentDestinations, paymentIntents, payrollItems, payrollRuns, payslips, stellarDestinations, treasuryPlans, users, userSessions, userWorkspacePreferences, wallets, workspaceInvites, workspaceMembers, workspaces } from "../drizzle/schema";
import { nanoid } from "nanoid";
import { formatAtomicAmount } from "./integrations/cauldron";
import { formatStellarXlmAtomic } from "./integrations/stellar";

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;
let _db: AppDatabase | null = null;
let _pool: Pool | null = null;

export async function createNotification(input: { recipientUserId: number; workspaceId?: number | null; category: "invoice" | "payment" | "payroll" | "team" | "system"; title: string; body: string; href?: string; entityType?: string; entityId?: string }) {
  const db = await getDb();
  if (!db) return;
  await db.insert(notifications).values({ ...input, workspaceId: input.workspaceId ?? null, href: input.href ?? null, entityType: input.entityType ?? null, entityId: input.entityId ?? null });
}

export async function listNotificationsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select().from(notifications).where(eq(notifications.recipientUserId, userId)).orderBy(desc(notifications.createdAt)).limit(50);
  const [unread] = await db.select({ count: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)));
  return { items: rows, unreadCount: unread?.count ?? 0 };
}

export async function markNotificationRead(input: { userId: number; notificationId?: number; all?: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const filter = input.all ? and(eq(notifications.recipientUserId, input.userId), isNull(notifications.readAt)) : and(eq(notifications.recipientUserId, input.userId), eq(notifications.id, input.notificationId ?? -1), isNull(notifications.readAt));
  await db.update(notifications).set({ readAt: new Date() }).where(filter);
  return { success: true };
}

// The runtime URL should be Neon’s pooled connection string. Drizzle Kit uses
// DATABASE_URL_UNPOOLED for schema changes.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 60_000, connectionTimeoutMillis: 10_000 });
      _pool.on("error", (error) => console.error("[Database] Idle Neon connection failed:", error.message));
      _db = drizzle(_pool, { schema });
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      await _pool?.end().catch(() => undefined);
      _pool = null;
      _db = null;
    }
  }
  return _db;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return result[0];
}

export async function listInvoiceRecipientTargets(email: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  if (!user) return undefined;
  const targets = await db.select({ id: workspaces.id, name: workspaces.name, type: workspaces.type, ownerUserId: workspaces.ownerUserId })
    .from(workspaces).where(and(eq(workspaces.ownerUserId, user.id), inArray(workspaces.type, ["personal", "organization"])));
  return { user, personal: targets.find((target) => target.type === "personal") ?? null, organizations: targets.filter((target) => target.type === "organization") };
}

export async function createAccount(input: { email: string; passwordHash: string; name?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(users).values({ email: input.email, passwordHash: input.passwordHash, name: input.name?.trim() || null, loginMethod: "email_password" }).onConflictDoNothing({ target: users.email }).returning();
    const user = inserted[0];
    if (!user) return undefined;
    const workspaceRows = await tx.insert(workspaces).values({ ownerUserId: user.id, name: "Personal account", type: "personal" }).returning({ id: workspaces.id });
    const workspaceId = workspaceRows[0]?.id;
    if (!workspaceId) throw new Error("Workspace creation failed");
    await tx.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: "owner" });
    return user;
  });
}

export async function createUserSession(input: { userId: number; tokenHash: string; expiresAt: Date }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  await db.insert(userSessions).values(input);
}

export async function getUserForSession(tokenHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const rows = await db.select({ user: users }).from(userSessions).innerJoin(users, eq(userSessions.userId, users.id)).where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, new Date()))).limit(1);
  return rows[0]?.user;
}

export async function deleteUserSession(tokenHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  await db.delete(userSessions).where(eq(userSessions.tokenHash, tokenHash));
}

export async function getOrCreateWorkspaceForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");

  const [preferred] = await db.select({ workspace: workspaces }).from(userWorkspacePreferences).innerJoin(workspaceMembers, and(eq(userWorkspacePreferences.workspaceId, workspaceMembers.workspaceId), eq(userWorkspacePreferences.userId, workspaceMembers.userId))).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(userWorkspacePreferences.userId, userId)).limit(1);
  if (preferred?.workspace) return preferred.workspace;
  const [membership] = await db.select({ workspace: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId)).orderBy(desc(workspaceMembers.createdAt), desc(workspaceMembers.id)).limit(1);
  if (membership?.workspace) return membership.workspace;

  const inserted = await db.insert(workspaces).values({ ownerUserId: userId, name: "Personal account", type: "personal" }).returning({ id: workspaces.id });
  const workspaceId = inserted[0]?.id;
  if (!workspaceId) throw new Error("Workspace creation failed");
  await db.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
  await db.insert(userWorkspacePreferences).values({ userId, workspaceId }).onConflictDoUpdate({ target: userWorkspacePreferences.userId, set: { workspaceId, updatedAt: new Date() } });
  const created = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!created[0]) throw new Error("Workspace creation failed");
  return created[0];
}

export async function listWorkspacesForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select({ id: workspaces.id, name: workspaces.name, type: workspaces.type, ownerUserId: workspaces.ownerUserId, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId)).orderBy(desc(workspaceMembers.createdAt));
}

export async function setActiveWorkspaceForUser(input: { userId: number; workspaceId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [membership] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).limit(1);
  if (!membership) return false;
  await db.insert(userWorkspacePreferences).values(input).onConflictDoUpdate({ target: userWorkspacePreferences.userId, set: { workspaceId: input.workspaceId, updatedAt: new Date() } });
  return true;
}

export async function getWorkspaceRoleForUser(input: { userId: number; workspaceId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [membership] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId))).limit(1);
  return membership?.role;
}

export async function createOrganizationForUser(input: { ownerUserId: number; name: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [organization] = await tx.insert(workspaces).values({ ownerUserId: input.ownerUserId, name: input.name.trim(), type: "organization" }).returning();
    if (!organization) throw new Error("Organization could not be created");
    await tx.insert(workspaceMembers).values({ workspaceId: organization.id, userId: input.ownerUserId, role: "owner" });
    await tx.insert(userWorkspacePreferences).values({ userId: input.ownerUserId, workspaceId: organization.id }).onConflictDoUpdate({ target: userWorkspacePreferences.userId, set: { workspaceId: organization.id, updatedAt: new Date() } });
    return organization;
  });
}

export async function renameWorkspaceForOwner(input: { workspaceId: number; ownerUserId: number; name: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [workspace] = await db.update(workspaces).set({ name: input.name.trim(), updatedAt: new Date() }).where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.ownerUserId, input.ownerUserId))).returning();
  return workspace;
}

export async function createWorkspaceInvite(input: { workspaceId: number; email: string; role: "admin" | "employee"; tokenHash: string; invitedByUserId: number; expiresAt: Date }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const normalizedEmail = input.email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: workspaceInvites.id }).from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, input.workspaceId), eq(workspaceInvites.email, normalizedEmail), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date()))).orderBy(desc(workspaceInvites.createdAt)).limit(1);
    const inviteValues = { ...input, email: normalizedEmail, createdAt: new Date() };
    const [invite] = existing
      ? await tx.update(workspaceInvites).set(inviteValues).where(eq(workspaceInvites.id, existing.id)).returning({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, createdAt: workspaceInvites.createdAt })
      : await tx.insert(workspaceInvites).values(inviteValues).returning({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, createdAt: workspaceInvites.createdAt });
    const [invitee, workspace] = await Promise.all([
      tx.select({ id: users.id }).from(users).where(eq(users.email, normalizedEmail)).limit(1),
      tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1),
    ]);
    if (invitee[0]) {
      await tx.delete(notifications).where(and(eq(notifications.entityType, "workspace_invite"), eq(notifications.entityId, String(invite.id))));
      await tx.insert(notifications).values({ recipientUserId: invitee[0].id, workspaceId: input.workspaceId, category: "team", title: "Organization invitation", body: `You have been invited to join ${workspace[0]?.name || "an organization"}. Accept it from your personal workspace dashboard.`, href: "/app", entityType: "workspace_invite", entityId: String(invite.id) });
    }
    return invite;
  });
}

export async function listWorkspaceInvites(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, acceptedAt: workspaceInvites.acceptedAt, createdAt: workspaceInvites.createdAt }).from(workspaceInvites).where(eq(workspaceInvites.workspaceId, workspaceId)).orderBy(desc(workspaceInvites.createdAt));
}

export async function listPendingWorkspaceInvitesForEmail(email: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select({ id: workspaceInvites.id, email: workspaceInvites.email, role: workspaceInvites.role, expiresAt: workspaceInvites.expiresAt, createdAt: workspaceInvites.createdAt, workspaceName: workspaces.name, inviterName: users.name, inviterEmail: users.email })
    .from(workspaceInvites).innerJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id)).innerJoin(users, eq(workspaceInvites.invitedByUserId, users.id))
    .where(and(eq(workspaceInvites.email, email.trim().toLowerCase()), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date())))
    .orderBy(desc(workspaceInvites.createdAt));
}

export async function deletePendingWorkspaceInvite(inviteId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.transaction(async (tx) => {
    await tx.delete(notifications).where(and(eq(notifications.entityType, "workspace_invite"), eq(notifications.entityId, String(inviteId))));
    await tx.delete(workspaceInvites).where(and(eq(workspaceInvites.id, inviteId), isNull(workspaceInvites.acceptedAt)));
  });
}

export async function acceptWorkspaceInvite(input: { userId: number; email: string; tokenHash: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [invite] = await tx.select().from(workspaceInvites).where(and(eq(workspaceInvites.tokenHash, input.tokenHash), eq(workspaceInvites.email, input.email.trim().toLowerCase()), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date()))).limit(1);
    if (!invite) return false;
    await tx.insert(workspaceMembers).values({ workspaceId: invite.workspaceId, userId: input.userId, role: invite.role }).onConflictDoNothing();
    await tx.update(workspaceInvites).set({ acceptedAt: new Date() }).where(eq(workspaceInvites.id, invite.id));
    await tx.insert(userWorkspacePreferences).values({ userId: input.userId, workspaceId: invite.workspaceId }).onConflictDoUpdate({ target: userWorkspacePreferences.userId, set: { workspaceId: invite.workspaceId, updatedAt: new Date() } });
    const [joinedUser, workspace] = await Promise.all([
      tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1),
      tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1),
    ]);
    if (invite.invitedByUserId !== input.userId) await tx.insert(notifications).values({ recipientUserId: invite.invitedByUserId, workspaceId: invite.workspaceId, category: "team", title: "Organization invitation accepted", body: `${joinedUser[0]?.name || joinedUser[0]?.email || "A teammate"} joined ${workspace[0]?.name || "your organization"}.`, href: "/payroll", entityType: "workspace_member", entityId: String(input.userId) });
    return true;
  });
}

export async function acceptWorkspaceInviteById(input: { userId: number; email: string; inviteId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [invite] = await tx.select().from(workspaceInvites).where(and(eq(workspaceInvites.id, input.inviteId), eq(workspaceInvites.email, input.email.trim().toLowerCase()), isNull(workspaceInvites.acceptedAt), gt(workspaceInvites.expiresAt, new Date()))).limit(1);
    if (!invite) return false;
    await tx.insert(workspaceMembers).values({ workspaceId: invite.workspaceId, userId: input.userId, role: invite.role }).onConflictDoNothing();
    await tx.update(workspaceInvites).set({ acceptedAt: new Date() }).where(eq(workspaceInvites.id, invite.id));
    await tx.insert(userWorkspacePreferences).values({ userId: input.userId, workspaceId: invite.workspaceId }).onConflictDoUpdate({ target: userWorkspacePreferences.userId, set: { workspaceId: invite.workspaceId, updatedAt: new Date() } });
    const [joinedUser, workspace] = await Promise.all([
      tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1),
      tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1),
    ]);
    if (invite.invitedByUserId !== input.userId) await tx.insert(notifications).values({ recipientUserId: invite.invitedByUserId, workspaceId: invite.workspaceId, category: "team", title: "Organization invitation accepted", body: `${joinedUser[0]?.name || joinedUser[0]?.email || "A teammate"} joined ${workspace[0]?.name || "your organization"}.`, href: "/payroll", entityType: "workspace_member", entityId: String(input.userId) });
    return true;
  });
}

export async function listWalletsForWorkspaceUser(workspaceId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.select().from(wallets).where(and(eq(wallets.workspaceId, workspaceId), eq(wallets.userId, userId))).orderBy(desc(wallets.createdAt));
}

export async function linkWalletForWorkspaceUser(input: { workspaceId: number; userId: number; provider: string; network: "mainnet" | "chipnet" | "testnet"; address: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const rows = await db.insert(wallets).values({ ...input, connectionStatus: "connected" }).onConflictDoUpdate({
    target: [wallets.userId, wallets.network, wallets.address],
    set: { workspaceId: input.workspaceId, provider: input.provider, connectionStatus: "connected", updatedAt: new Date() },
  }).returning();
  const wallet = rows[0];
  if (!wallet) throw new Error("Wallet link could not be saved");
  return wallet;
}

export async function unlinkWalletForWorkspaceUser(input: { workspaceId: number; userId: number; walletId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const result = await db.update(wallets).set({ connectionStatus: "disconnected", updatedAt: new Date() }).where(and(eq(wallets.id, input.walletId), eq(wallets.workspaceId, input.workspaceId), eq(wallets.userId, input.userId))).returning({ id: wallets.id });
  return result.length > 0;
}

export async function listPaymentDestinationsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.select().from(paymentDestinations).where(eq(paymentDestinations.userId, userId)).orderBy(desc(paymentDestinations.createdAt));
}

function isCashTokenDestination(destination: { asset: PaymentDestinationAsset; address: string }) {
  if (destination.asset !== "BCH") return true;
  const decoded = cashAddressToLockingBytecode(destination.address);
  return typeof decoded !== "string" && decoded.tokenSupport;
}

export async function getPersonalPayrollDestination(input: { email: string; asset: Asset; network?: "mainnet" | "chipnet" }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const [user] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email.trim().toLowerCase()}`).limit(1);
  if (!user) return undefined;
  const destinations = await db.select().from(paymentDestinations).where(and(
    eq(paymentDestinations.userId, user.id),
    ...(input.network ? [eq(paymentDestinations.network, input.network)] : []),
  )).orderBy(desc(paymentDestinations.createdAt));
  const tokenTyped = destinations.filter((destination) => destination.asset !== "BCH" && isCashTokenDestination(destination));
  const tokenCapable = destinations.filter(isCashTokenDestination);
  // A CashTokens-aware CashAddress can look like BCH at a glance and legacy
  // rows may still carry the old BCH database tag. Keep it in the token group,
  // matching the profile list's effective asset classification.
  const bchTyped = destinations.filter((destination) => destination.asset === "BCH" && !isCashTokenDestination(destination));
  const candidates = input.asset === "BCH"
    ? bchTyped.length ? bchTyped : destinations
    : tokenTyped.length ? tokenTyped : tokenCapable;
  if (input.network) return candidates.find((destination) => destination.isDefault) ?? candidates[0];
  for (const network of ["chipnet", "mainnet"] as const) {
    const onNetwork = candidates.filter((destination) => destination.network === network);
    if (onNetwork.length) return onNetwork.find((destination) => destination.isDefault) ?? onNetwork[0];
  }
  return candidates.find((destination) => destination.isDefault) ?? candidates[0];
}

export async function getPersonalStellarDestination(input: { email: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const [user] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email.trim().toLowerCase()}`).limit(1);
  if (!user) return undefined;
  const [destination] = await db.select().from(stellarDestinations).where(eq(stellarDestinations.userId, user.id)).orderBy(desc(stellarDestinations.isDefault), desc(stellarDestinations.createdAt)).limit(1);
  return destination;
}

export async function getPaymentDestinationForUser(input: { userId: number; destinationId: number; asset: "BCH" | "PUSD" | "MUSD"; network: "mainnet" | "chipnet" }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const matches = await db.select().from(paymentDestinations).where(and(
    eq(paymentDestinations.id, input.destinationId),
    eq(paymentDestinations.userId, input.userId),
    eq(paymentDestinations.network, input.network),
  )).limit(1);
  const destination = matches[0];
  if (!destination) return undefined;
  const decoded = cashAddressToLockingBytecode(destination.address);
  if (typeof decoded === "string") return undefined;
  if (input.asset === "BCH") return !decoded.tokenSupport ? destination : undefined;
  return decoded.tokenSupport ? destination : undefined;
}

export async function addPaymentDestination(input: { userId: number; label: string; asset: Extract<PaymentDestinationAsset, "BCH" | "TOKEN">; network: "mainnet" | "chipnet"; address: string; makeDefault: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.transaction(async (tx) => {
    if (input.makeDefault) {
      const existing = await tx.select({ id: paymentDestinations.id, asset: paymentDestinations.asset, address: paymentDestinations.address }).from(paymentDestinations).where(and(eq(paymentDestinations.userId, input.userId), eq(paymentDestinations.network, input.network)));
      const targetIsToken = input.asset === "TOKEN";
      const defaultsToClear = existing.filter((destination) => isCashTokenDestination(destination) === targetIsToken).map((destination) => destination.id);
      if (defaultsToClear.length) await tx.update(paymentDestinations).set({ isDefault: false, updatedAt: new Date() }).where(inArray(paymentDestinations.id, defaultsToClear));
    }
    const [created] = await tx.insert(paymentDestinations).values({ ...input, isDefault: input.makeDefault }).returning();
    if (!created) throw new Error("Payment destination could not be saved");
    return created;
  });
}

export async function setDefaultPaymentDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: paymentDestinations.id, asset: paymentDestinations.asset, network: paymentDestinations.network, address: paymentDestinations.address }).from(paymentDestinations).where(and(eq(paymentDestinations.id, input.destinationId), eq(paymentDestinations.userId, input.userId))).limit(1);
    if (!target) return false;
    const existing = await tx.select({ id: paymentDestinations.id, asset: paymentDestinations.asset, address: paymentDestinations.address }).from(paymentDestinations).where(and(eq(paymentDestinations.userId, input.userId), eq(paymentDestinations.network, target.network)));
    const targetIsToken = isCashTokenDestination(target);
    const defaultsToClear = existing.filter((destination) => isCashTokenDestination(destination) === targetIsToken).map((destination) => destination.id);
    if (defaultsToClear.length) await tx.update(paymentDestinations).set({ isDefault: false, updatedAt: new Date() }).where(inArray(paymentDestinations.id, defaultsToClear));
    await tx.update(paymentDestinations).set({ isDefault: true, updatedAt: new Date() }).where(and(eq(paymentDestinations.id, target.id), eq(paymentDestinations.userId, input.userId)));
    return true;
  });
}

export async function deletePaymentDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const deleted = await db.delete(paymentDestinations).where(and(eq(paymentDestinations.id, input.destinationId), eq(paymentDestinations.userId, input.userId))).returning({ id: paymentDestinations.id });
  return deleted.length > 0;
}

export async function listStellarDestinationsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.select().from(stellarDestinations).where(eq(stellarDestinations.userId, userId)).orderBy(desc(stellarDestinations.isDefault), desc(stellarDestinations.createdAt));
}

export async function getStellarDestinationForUser(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const [destination] = await db.select().from(stellarDestinations).where(and(eq(stellarDestinations.userId, input.userId), eq(stellarDestinations.id, input.destinationId))).limit(1);
  return destination;
}

export async function addStellarDestination(input: { userId: number; label: string; address: string; makeDefault: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const destination = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(stellarDestinations).where(and(eq(stellarDestinations.userId, input.userId), eq(stellarDestinations.address, input.address))).limit(1);
    if (input.makeDefault) await tx.update(stellarDestinations).set({ isDefault: false, updatedAt: new Date() }).where(eq(stellarDestinations.userId, input.userId));
    if (existing) {
      const [updated] = await tx.update(stellarDestinations).set({ label: input.label, isDefault: input.makeDefault || existing.isDefault, updatedAt: new Date() }).where(eq(stellarDestinations.id, existing.id)).returning();
      if (!updated) throw new Error("Stellar address could not be updated");
      return updated;
    }
    const [created] = await tx.insert(stellarDestinations).values({ ...input, isDefault: input.makeDefault }).returning();
    if (!created) throw new Error("Stellar address could not be saved");
    return created;
  });
  if (input.makeDefault) {
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (user?.email) await db.update(employees).set({ preferredAsset: "XLM", updatedAt: new Date() }).where(and(sql`lower(${employees.email}) = ${user.email.trim().toLowerCase()}`, eq(employees.active, 1)));
  }
  return destination;
}

export async function setDefaultStellarDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: stellarDestinations.id }).from(stellarDestinations).where(and(eq(stellarDestinations.userId, input.userId), eq(stellarDestinations.id, input.destinationId))).limit(1);
    if (!target) return false;
    await tx.update(stellarDestinations).set({ isDefault: false, updatedAt: new Date() }).where(eq(stellarDestinations.userId, input.userId));
    await tx.update(stellarDestinations).set({ isDefault: true, updatedAt: new Date() }).where(eq(stellarDestinations.id, target.id));
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (user?.email) await tx.update(employees).set({ preferredAsset: "XLM", updatedAt: new Date() }).where(and(sql`lower(${employees.email}) = ${user.email.trim().toLowerCase()}`, eq(employees.active, 1)));
    return true;
  });
}

export async function deleteStellarDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available. Set DATABASE_URL to a Neon PostgreSQL connection string.");
  const [deleted] = await db.delete(stellarDestinations).where(and(eq(stellarDestinations.userId, input.userId), eq(stellarDestinations.id, input.destinationId))).returning({ id: stellarDestinations.id });
  return Boolean(deleted);
}

export async function listTreasuryActivity(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select({
    id: ledgerEntries.id,
    invoiceId: ledgerEntries.invoiceId,
    asset: ledgerEntries.asset,
    amountAtomic: ledgerEntries.amountAtomic,
    direction: ledgerEntries.direction,
    state: ledgerEntries.state,
    txid: ledgerEntries.externalTxid,
    account: ledgerEntries.account,
    createdAt: ledgerEntries.createdAt,
    invoicePublicId: invoices.publicId,
    description: invoices.description,
    clientName: invoices.clientName,
  }).from(ledgerEntries)
    .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
    .where(and(eq(ledgerEntries.workspaceId, workspaceId), eq(ledgerEntries.state, "posted"), eq(ledgerEntries.account, "cash")))
    .orderBy(desc(ledgerEntries.createdAt));

  const totals = { BCH: { received: 0n, sent: 0n }, PUSD: { received: 0n, sent: 0n }, MUSD: { received: 0n, sent: 0n } };
  for (const row of rows) {
    const kind = row.direction === "debit" ? "received" : "sent";
    totals[row.asset][kind] += BigInt(row.amountAtomic);
  }
  const toStrings = Object.fromEntries(Object.entries(totals).map(([asset, values]) => [asset, {
    received: values.received.toString(),
    sent: values.sent.toString(),
    net: (values.received - values.sent).toString(),
  }])) as Record<Asset, { received: string; sent: string; net: string }>;
  return { totals: toStrings, items: rows.slice(0, 200), entryCount: rows.length };
}

const emptyTreasuryPlan: TreasuryPlanConfiguration = {
  allocations: { tax: 0, savings: 0, payroll: 0, operating: 0 },
  reserveGoal: null,
  recurringPlan: null,
};

export async function getTreasuryPlan(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [row] = await db.select().from(treasuryPlans).where(eq(treasuryPlans.workspaceId, workspaceId)).limit(1);
  return row?.configuration ?? emptyTreasuryPlan;
}

export async function saveTreasuryPlan(input: { workspaceId: number; userId: number; configuration: TreasuryPlanConfiguration }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.insert(treasuryPlans).values({ workspaceId: input.workspaceId, updatedByUserId: input.userId, configuration: input.configuration })
    .onConflictDoUpdate({ target: treasuryPlans.workspaceId, set: { updatedByUserId: input.userId, configuration: input.configuration, updatedAt: new Date() } });
  return input.configuration;
}

export async function listInvoicesForWorkspace(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(invoices).where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.direction, "receivable"))).orderBy(desc(invoices.createdAt));
}

export async function getWorkspacePaymentMetrics(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const routesFreshSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [workspaceInvoices, paidInvoicesThisMonth, paymentRoutes, crosschainRoutes] = await Promise.all([
    db.select({ status: invoices.status }).from(invoices).where(and(or(eq(invoices.workspaceId, workspaceId), eq(invoices.recipientWorkspaceId, workspaceId)), inArray(invoices.status, ["draft", "submitted", "awaiting_payment", "awaiting_verification"]))),
    db.select({ id: invoices.id, requestAsset: invoices.requestAsset, displayAmount: invoices.displayAmount }).from(invoices).where(and(eq(invoices.workspaceId, workspaceId), eq(invoices.direction, "receivable"), eq(invoices.status, "paid"), gte(invoices.updatedAt, monthStart))),
    db.select({ id: paymentIntents.id }).from(paymentIntents).where(and(eq(paymentIntents.workspaceId, workspaceId), inArray(paymentIntents.status, ["awaiting_signature", "broadcast", "pending_verification"]), gte(paymentIntents.updatedAt, routesFreshSince))),
    db.select({ id: crosschainIntents.id }).from(crosschainIntents).where(and(eq(crosschainIntents.workspaceId, workspaceId), inArray(crosschainIntents.status, ["pending_verification", "paying"]), gte(crosschainIntents.updatedAt, routesFreshSince), gt(crosschainIntents.expiresAt, now))),
  ]);
  const usdtReceivedCents = paidInvoicesThisMonth.reduce((sum, invoice) => {
    if (invoice.requestAsset !== "USDT") return sum;
    const cents = Math.round(Number(invoice.displayAmount) * 100);
    return Number.isFinite(cents) ? sum + cents : sum;
  }, 0);
  return {
    openInvoices: workspaceInvoices.length,
    paidInvoicesThisMonth: paidInvoicesThisMonth.length,
    receivedThisMonthUsdt: (usdtReceivedCents / 100).toFixed(2),
    activeRoutes: paymentRoutes.length + crosschainRoutes.length,
  };
}

/** A workspace-scoped accounting view assembled from posted journal entries and source records. */
export async function getFinancialRecordsForWorkspace(workspaceId: number, userEmail?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [currentWorkspace] = await db.select({ type: workspaces.type }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const includePersonalPayroll = currentWorkspace?.type === "personal" && Boolean(userEmail);
  const payrollScope = includePersonalPayroll
    ? or(eq(payrollRuns.workspaceId, workspaceId), and(sql`lower(${employees.email}) = ${userEmail!.trim().toLowerCase()}`, inArray(payrollItems.status, ["verified", "broadcast"])))
    : eq(payrollRuns.workspaceId, workspaceId);
  const [journal, invoiceRecords, intentRecords, crosschainRecords, payrollRecords] = await Promise.all([
    db.select({ id: ledgerEntries.id, invoiceId: ledgerEntries.invoiceId, asset: ledgerEntries.asset, amountAtomic: ledgerEntries.amountAtomic, direction: ledgerEntries.direction, state: ledgerEntries.state, txid: ledgerEntries.externalTxid, account: ledgerEntries.account, createdAt: ledgerEntries.createdAt, invoicePublicId: invoices.publicId, description: invoices.description, clientName: invoices.clientName, senderName: invoices.senderName, senderEmail: invoices.senderEmail, recipientEmail: invoices.recipientEmail, receivingAddress: invoices.receivingAddress, requestAsset: invoices.requestAsset, invoiceAmountAtomic: invoices.amountAtomic, invoiceDisplayAmount: invoices.displayAmount, receivedAmountAtomic: invoices.receivedAmountAtomic, deliveryAsset: invoices.deliveryAsset, deliveryNetwork: invoices.deliveryNetwork })
      .from(ledgerEntries).leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id)).where(eq(ledgerEntries.workspaceId, workspaceId)).orderBy(desc(ledgerEntries.createdAt)).limit(500),
    db.select().from(invoices).where(or(eq(invoices.workspaceId, workspaceId), eq(invoices.recipientWorkspaceId, workspaceId))).orderBy(desc(invoices.createdAt)).limit(200),
    db.select().from(paymentIntents).where(eq(paymentIntents.workspaceId, workspaceId)).orderBy(desc(paymentIntents.createdAt)).limit(200),
    db.select().from(crosschainIntents).where(eq(crosschainIntents.workspaceId, workspaceId)).orderBy(desc(crosschainIntents.createdAt)).limit(200),
    db.select({ id: payrollItems.id, workspaceId: payrollItems.workspaceId, runId: payrollItems.runId, employeeId: payrollItems.employeeId, payoutAddress: payrollItems.payoutAddress, amountAtomic: payrollItems.amountAtomic, requestedAmountAtomic: payrollItems.requestedAmountAtomic, displayAmount: payrollItems.displayAmount, requestedAmountUnit: payrollItems.requestedAmountUnit, asset: payrollItems.asset, status: payrollItems.status, txid: payrollItems.txid, failureReason: payrollItems.failureReason, createdAt: payrollItems.createdAt, updatedAt: payrollItems.updatedAt, period: payrollRuns.period, runPublicId: payrollRuns.publicId, sourceAsset: payrollRuns.sourceAsset, runStatus: payrollRuns.status, employeeName: employees.fullName, employeeEmail: employees.email, organizationName: workspaces.name })
      .from(payrollItems).innerJoin(payrollRuns, and(eq(payrollItems.runId, payrollRuns.id), eq(payrollItems.workspaceId, payrollRuns.workspaceId))).innerJoin(employees, and(eq(payrollItems.employeeId, employees.id), eq(payrollItems.workspaceId, employees.workspaceId))).innerJoin(workspaces, eq(payrollRuns.workspaceId, workspaces.id)).where(payrollScope).orderBy(desc(payrollItems.createdAt)).limit(500),
  ]);
  const transactionIds = [...new Set([...journal.map((entry) => entry.txid), ...invoiceRecords.map((invoice) => invoice.paymentTxid)].filter((txid): txid is string => Boolean(txid)))];
  const transactionIntents = await listPaymentIntentSummariesForTransactions(transactionIds);
  const convertedPaymentTxids = new Set(transactionIntents.map((intent) => intent.txid).filter((txid): txid is string => Boolean(txid)));
  const balances = { BCH: { receivedAtomic: 0n, spentAtomic: 0n }, PUSD: { receivedAtomic: 0n, spentAtomic: 0n }, MUSD: { receivedAtomic: 0n, spentAtomic: 0n }, XLM: { receivedAtomic: 0n, spentAtomic: 0n }, USDC: { receivedAtomic: 0n, spentAtomic: 0n }, USDT: { receivedAtomic: 0n, spentAtomic: 0n } };
  for (const entry of journal) {
    if (entry.state !== "posted") continue;
    const amount = BigInt(entry.amountAtomic);
    if (entry.account === "cash") {
      // Paid invoice rows are reconciled below from the invoice and payment
      // intent records. Older settlements may not have journal rows, and some
      // converted invoices used the delivered asset where the payer's source
      // asset should be reflected.
      if (entry.invoiceId != null) continue;
      if (entry.direction === "credit" && entry.txid && convertedPaymentTxids.has(entry.txid)) continue;
      balances[entry.asset][entry.direction === "debit" ? "receivedAtomic" : "spentAtomic"] += amount;
    } else if (entry.account === "intent:payer") {
      balances[entry.asset].spentAtomic += amount;
    }
  }
  for (const invoice of invoiceRecords) {
    if (invoice.status !== "paid") continue;
    const isIssuer = invoice.workspaceId === workspaceId && invoice.direction === "receivable";
    const isPayer = invoice.recipientWorkspaceId === workspaceId || (invoice.workspaceId === workspaceId && invoice.direction === "payable");
    const settlement = invoice.metadata && typeof invoice.metadata === "object" ? (invoice.metadata as Record<string, unknown>).crosschainSettlement as Record<string, unknown> | undefined : undefined;
    if (isIssuer) {
      if (invoice.deliveryAsset === "XLM") {
        const received = typeof settlement?.destinationAmountAtomic === "string" ? settlement.destinationAmountAtomic : invoice.receivedAmountAtomic;
        if (received) balances.XLM.receivedAtomic += BigInt(received);
      } else {
        const amount = invoice.receivedAmountAtomic || invoice.amountAtomic;
        balances[invoice.asset].receivedAtomic += BigInt(amount);
      }
    } else if (isPayer) {
      // A cross-chain invoice's source spend is captured from the intent below.
      if (invoice.deliveryAsset === "XLM") continue;
      const sourceTxid = typeof settlement?.sourceTxid === "string" ? settlement.sourceTxid : invoice.paymentTxid;
      const sourceIntent = transactionIntents.find((intent) => intent.txid === sourceTxid);
      if (sourceIntent) balances[sourceIntent.payerAsset].spentAtomic += BigInt(sourceIntent.inputAmountAtomic);
      else balances[invoice.asset].spentAtomic += BigInt(invoice.receivedAmountAtomic || invoice.amountAtomic);
    }
  }
  for (const intent of crosschainRecords) {
    if (intent.status === "completed") balances[intent.sourceAsset].spentAtomic += BigInt(intent.sourceAmountAtomic);
  }
  if (includePersonalPayroll) {
    for (const item of payrollRecords) {
      if (item.workspaceId !== workspaceId && item.employeeEmail?.trim().toLowerCase() === userEmail!.trim().toLowerCase() && item.status === "verified") {
        balances[item.asset].receivedAtomic += BigInt(item.amountAtomic);
      }
    }
  }
  const balanceSummary = Object.fromEntries(Object.entries(balances).map(([asset, amounts]) => [asset, { receivedAtomic: amounts.receivedAtomic.toString(), spentAtomic: amounts.spentAtomic.toString(), netAtomic: (amounts.receivedAtomic - amounts.spentAtomic).toString() }]));
  const payrollWithRecipientScope = payrollRecords.map((item) => ({ ...item, personalIncome: includePersonalPayroll && item.workspaceId !== workspaceId && item.employeeEmail?.trim().toLowerCase() === userEmail!.trim().toLowerCase() }));
  return { workspaceId, balances: balanceSummary, journal, invoices: invoiceRecords, intents: intentRecords, transactionIntents, crosschain: crosschainRecords, payroll: payrollWithRecipientScope };
}

export async function listInvoiceInboxForUser(input: { workspaceId: number; userId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(invoices).where(eq(invoices.recipientWorkspaceId, input.workspaceId)).orderBy(desc(invoices.createdAt));
}

export async function listPaymentIntentSummariesForTransactions(txids: string[]) {
  if (!txids.length) return [];
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select({ txid: paymentIntents.txid, payerAsset: paymentIntents.payerAsset, inputAmountAtomic: paymentIntents.inputAmountAtomic })
    .from(paymentIntents).where(inArray(paymentIntents.txid, txids)).orderBy(desc(paymentIntents.updatedAt));
}

export async function getInvoiceForRecipient(input: { workspaceId: number; userId: number; publicId: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [invoice] = await db.select().from(invoices).where(and(eq(invoices.publicId, input.publicId), eq(invoices.recipientWorkspaceId, input.workspaceId))).limit(1);
  return invoice;
}

export async function getInvoiceForWorkspace(workspaceId: number, publicId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const result = await db.select().from(invoices).where(eq(invoices.publicId, publicId)).limit(1);
  return result[0]?.workspaceId === workspaceId ? result[0] : undefined;
}

export async function createInvoiceForWorkspace(input: {
  workspaceId: number;
  createdByUserId: number;
  senderName: string;
  senderEmail: string;
  description: string;
  clientName: string;
  amountAtomic: string;
  displayAmount: string;
  requestAsset: "USDT" | "BCH" | "PUSD" | "MUSD";
  asset: "BCH" | "PUSD" | "MUSD";
  deliveryAsset?: "XLM" | null;
  deliveryNetwork?: "stellar-testnet" | null;
  dueDate: string;
  receivingAddress?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const publicId = `INV-${nanoid(8).toUpperCase()}`;
  const inserted = await db.insert(invoices).values({
    publicId,
    workspaceId: input.workspaceId,
    createdByUserId: input.createdByUserId,
    senderName: input.senderName,
    senderEmail: input.senderEmail.trim().toLowerCase(),
    description: input.description.trim(),
    direction: "receivable",
    clientName: input.clientName,
    amountAtomic: input.amountAtomic,
    displayAmount: input.displayAmount,
    requestAsset: input.requestAsset,
    asset: input.asset,
    deliveryAsset: input.deliveryAsset ?? null,
    deliveryNetwork: input.deliveryNetwork ?? null,
    dueDate: input.dueDate,
    receivingAddress: input.receivingAddress || null,
    status: "draft",
  }).returning({ id: invoices.id });
  await db.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorUserId: input.createdByUserId,
    action: "invoice.draft_created",
    entityType: "invoice",
    entityId: publicId,
    metadata: { asset: input.asset, amountAtomic: input.amountAtomic },
  });
  const invoiceId = inserted[0]?.id;
  if (!invoiceId) throw new Error("Invoice creation failed");
  const created = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!created[0]) throw new Error("Invoice creation failed");
  return created[0];
}

export async function updateDraftInvoiceForWorkspace(input: {
  workspaceId: number;
  userId: number;
  publicId: string;
  clientName: string;
  amountAtomic: string;
  displayAmount: string;
  requestAsset: "USDT";
  asset: "BCH" | "PUSD" | "MUSD";
  deliveryAsset?: "XLM" | null;
  deliveryNetwork?: "stellar-testnet" | null;
  dueDate: string;
  receivingAddress: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(invoices).set({
    clientName: input.clientName.trim(),
    description: input.clientName.trim(),
    amountAtomic: input.amountAtomic,
    displayAmount: input.displayAmount,
    requestAsset: input.requestAsset,
    asset: input.asset,
    deliveryAsset: input.deliveryAsset ?? null,
    deliveryNetwork: input.deliveryNetwork ?? null,
    dueDate: input.dueDate,
    receivingAddress: input.receivingAddress,
    updatedAt: new Date(),
  }).where(and(
    eq(invoices.publicId, input.publicId),
    eq(invoices.workspaceId, input.workspaceId),
    eq(invoices.status, "draft"),
  )).returning();
  if (!updated) return undefined;
  await db.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    action: "invoice.draft_updated",
    entityType: "invoice",
    entityId: input.publicId,
    metadata: { asset: input.asset, amountAtomic: input.amountAtomic },
  });
  return updated;
}

export async function sendDraftInvoice(input: { workspaceId: number; userId: number; publicId: string; recipientUserId: number; recipientWorkspaceId: number; recipientEmail: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(invoices).set({ recipientUserId: input.recipientUserId, recipientWorkspaceId: input.recipientWorkspaceId, recipientEmail: input.recipientEmail.trim().toLowerCase(), status: "awaiting_payment", updatedAt: new Date() }).where(and(eq(invoices.publicId, input.publicId), eq(invoices.workspaceId, input.workspaceId), eq(invoices.status, "draft"))).returning();
  if (!updated) return undefined;
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.userId, action: "invoice.sent", entityType: "invoice", entityId: input.publicId, metadata: { recipientEmail: input.recipientEmail.trim().toLowerCase() } });
  await createNotification({ recipientUserId: input.recipientUserId, workspaceId: input.recipientWorkspaceId, category: "invoice", title: "New invoice received", body: `${updated.clientName} sent invoice ${updated.publicId} for ${updated.displayAmount} ${updated.requestAsset}.`, href: "/payments", entityType: "invoice", entityId: updated.publicId });
  return updated;
}

export async function finalizeInvoiceBatch(input: { payerWorkspaceId: number; payerUserId: number; invoices: Array<{ id: number; publicId: string; workspaceId: number; amountAtomic: string; requestAsset: string; receivedAmountAtomic: string; asset: "BCH" | "PUSD" | "MUSD"; clientName: string }>; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    for (const invoice of input.invoices) {
      const [current] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1);
      if (!current) throw new Error(`Invoice ${invoice.publicId} is no longer available`);
      if (current.status === "paid") {
        if (current.paymentTxid !== input.txid) throw new Error(`Invoice ${invoice.publicId} has already been paid by another transaction`);
        continue;
      }
      if ((current.status !== "awaiting_payment" && current.status !== "awaiting_verification") || (current.status === "awaiting_verification" && current.paymentTxid !== input.txid)) throw new Error(`Invoice ${invoice.publicId} is no longer payable`);
      const escaped = (value: string) => value.replace(/[&<>\']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;" })[character] || character);
      const receiptHtml = `<article><h1>Volta Finance payment receipt</h1><p><strong>Invoice:</strong> ${escaped(current.publicId)}</p><p><strong>From:</strong> ${escaped(current.senderName || current.clientName)}</p><p><strong>For:</strong> ${escaped(current.description || current.clientName)}</p><p><strong>Requested:</strong> ${escaped(current.displayAmount)} ${escaped(current.requestAsset)}</p><p><strong>Recipient received:</strong> ${escaped(formatAtomicAmount(current.receivedAmountAtomic || current.amountAtomic, current.asset))} ${escaped(current.asset)}</p><p><strong>Transaction:</strong> ${escaped(input.txid)}</p><p><strong>Status:</strong> Verified on Bitcoin Cash</p></article>`;
      const requestedLedgerAsset: Asset = current.requestAsset === "USDT" ? "PUSD" : current.requestAsset as Asset;
      const statusPredicate = current.status === "awaiting_verification"
        ? and(eq(invoices.id, current.id), eq(invoices.status, "awaiting_verification"), eq(invoices.paymentTxid, input.txid))
        : and(eq(invoices.id, current.id), eq(invoices.status, "awaiting_payment"), isNull(invoices.paymentTxid));
      const [claimed] = await tx.update(invoices).set({ status: "paid", paymentTxid: input.txid, receiptHtml, updatedAt: new Date() }).where(statusPredicate).returning({ id: invoices.id });
      if (!claimed) {
        const [latest] = await tx.select({ status: invoices.status, paymentTxid: invoices.paymentTxid }).from(invoices).where(eq(invoices.id, current.id)).limit(1);
        if (latest?.status === "paid" && latest.paymentTxid === input.txid) continue;
        throw new Error(`Invoice ${current.publicId} was settled by a different payment`);
      }
      if (current.direction === "receivable") {
        await tx.insert(ledgerEntries).values([
          { workspaceId: current.workspaceId, invoiceId: current.id, asset: current.asset, amountAtomic: current.receivedAmountAtomic || current.amountAtomic, direction: "debit", state: "posted", externalTxid: input.txid, account: "cash" },
          { workspaceId: current.workspaceId, invoiceId: current.id, asset: current.asset, amountAtomic: current.receivedAmountAtomic || current.amountAtomic, direction: "credit", state: "posted", externalTxid: input.txid, account: "accounts.receivable" },
        ]);
      } else {
        await tx.insert(ledgerEntries).values([
          { workspaceId: current.workspaceId, invoiceId: current.id, asset: requestedLedgerAsset, amountAtomic: current.amountAtomic, direction: "debit", state: "posted", externalTxid: input.txid, account: "accounts.payable" },
          { workspaceId: current.workspaceId, invoiceId: current.id, asset: current.asset, amountAtomic: current.receivedAmountAtomic || current.amountAtomic, direction: "credit", state: "posted", externalTxid: input.txid, account: "cash" },
        ]);
      }
      if (current.direction === "receivable" && current.workspaceId !== input.payerWorkspaceId) await tx.insert(ledgerEntries).values([
        { workspaceId: input.payerWorkspaceId, invoiceId: current.id, asset: requestedLedgerAsset, amountAtomic: current.amountAtomic, direction: "debit", state: "posted", externalTxid: input.txid, account: "invoice.expense" },
        { workspaceId: input.payerWorkspaceId, invoiceId: current.id, asset: current.asset, amountAtomic: current.receivedAmountAtomic || current.amountAtomic, direction: "credit", state: "posted", externalTxid: input.txid, account: "cash" },
      ]);
      if (current.recipientUserId) await tx.insert(auditEvents).values({ workspaceId: current.recipientWorkspaceId || input.payerWorkspaceId, actorUserId: input.payerUserId, action: "invoice.payment.receipt_delivered", entityType: "invoice", entityId: current.publicId, metadata: { txid: input.txid, amountAtomic: current.amountAtomic } });
      if (current.createdByUserId && current.createdByUserId !== input.payerUserId) await tx.insert(notifications).values({ recipientUserId: current.createdByUserId, workspaceId: current.workspaceId, category: "payment", title: "Invoice paid", body: `${current.publicId} was paid. Receipt and transaction details are available in Volta Finance.`, href: "/payments", entityType: "invoice", entityId: current.publicId });
      if (current.recipientUserId && current.recipientUserId !== current.createdByUserId && current.recipientUserId !== input.payerUserId) await tx.insert(notifications).values({ recipientUserId: current.recipientUserId, workspaceId: current.recipientWorkspaceId, category: "payment", title: "Payment completed", body: `Payment for invoice ${current.publicId} has been verified.`, href: "/payments", entityType: "invoice", entityId: current.publicId });
    }
    return { status: "paid" as const, txid: input.txid, invoiceIds: input.invoices.map((invoice) => invoice.publicId) };
  });
}

export async function createExternalInvoiceSubmission(input: { recipientUserId: number; workspaceId: number; recipientEmail: string; senderName: string; senderEmail: string; description: string; amountAtomic: string; displayAmount: string; requestAsset: "USDT" | "BCH" | "PUSD" | "MUSD"; asset: "BCH" | "PUSD" | "MUSD"; dueDate: string; receivingAddress: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const publicId = `EXT-${nanoid(8).toUpperCase()}`;
  const [created] = await db.insert(invoices).values({
    publicId, workspaceId: input.workspaceId, createdByUserId: input.recipientUserId,
    recipientUserId: input.recipientUserId, recipientWorkspaceId: input.workspaceId,
    recipientEmail: input.recipientEmail.trim().toLowerCase(), senderName: input.senderName.trim(), senderEmail: input.senderEmail.trim().toLowerCase(),
    direction: "payable", clientName: input.senderName.trim(), description: input.description.trim(), amountAtomic: input.amountAtomic, displayAmount: input.displayAmount, requestAsset: input.requestAsset,
    asset: input.asset, dueDate: input.dueDate, receivingAddress: input.receivingAddress, status: "submitted",
  }).returning();
  if (!created) throw new Error("Invoice submission could not be saved");
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.recipientUserId, action: "invoice.external.submitted", entityType: "invoice", entityId: publicId, metadata: { senderEmail: input.senderEmail.trim().toLowerCase() } });
  await createNotification({ recipientUserId: input.recipientUserId, workspaceId: input.workspaceId, category: "invoice", title: "Guest invoice received", body: `${input.senderName.trim()} (${input.senderEmail.trim()}) submitted invoice ${publicId} for ${input.displayAmount} ${input.requestAsset}.`, href: "/payments", entityType: "invoice", entityId: publicId });
  return created;
}

export async function updateIncomingInvoiceStatus(input: { userId: number; workspaceId: number; publicId: string; status: "awaiting_payment" | "cancelled" }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [invoice] = await db.update(invoices).set({ status: input.status, updatedAt: new Date() }).where(and(eq(invoices.publicId, input.publicId), eq(invoices.workspaceId, input.workspaceId), eq(invoices.recipientWorkspaceId, input.workspaceId), eq(invoices.direction, "payable"), eq(invoices.status, "submitted"))).returning();
  if (invoice) await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.userId, action: input.status === "awaiting_payment" ? "invoice.external.accepted" : "invoice.external.rejected", entityType: "invoice", entityId: invoice.publicId, metadata: { senderEmail: invoice.senderEmail } });
  return invoice;
}

export async function markInvoiceBatchBroadcast(input: { userId: number; workspaceId: number; receivedAmounts: Array<{ publicId: string; amountAtomic: string }>; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const updated = [];
    for (const item of input.receivedAmounts) {
      const [row] = await tx.update(invoices).set({ status: "awaiting_verification", paymentTxid: input.txid, receivedAmountAtomic: item.amountAtomic, updatedAt: new Date() })
        // Incoming invoices belong to the sender's workspace but are payable from
        // the recipient's workspace. The router already verifies recipient access;
        // constrain this conditional update to that inbox and the payable state.
        .where(and(eq(invoices.publicId, item.publicId), eq(invoices.recipientWorkspaceId, input.workspaceId), eq(invoices.status, "awaiting_payment"))).returning({ id: invoices.id });
      if (!row) throw new Error("One or more invoices changed before this batch could be recorded");
      updated.push(row);
    }
    await tx.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.userId, action: "invoice.batch.broadcast", entityType: "invoice_batch", entityId: input.txid, metadata: { invoiceIds: input.receivedAmounts.map((item) => item.publicId) } });
    return updated;
  });
}

export async function attachExternalInvoice(input: { workspaceId: number; publicId: string; externalInvoiceId: string; paymentUrl: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const existing = await getInvoiceForWorkspace(input.workspaceId, input.publicId);
  if (!existing) throw new Error("Invoice was not found in this workspace");
  await db.update(invoices).set({ externalInvoiceId: input.externalInvoiceId, status: "awaiting_payment", metadata: { paymentUrl: input.paymentUrl } }).where(eq(invoices.id, existing.id));
  if (existing.createdByUserId) await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: existing.createdByUserId, action: "paymenthub.invoice.created", entityType: "invoice", entityId: input.publicId, metadata: { externalInvoiceId: input.externalInvoiceId } });
  const updated = await db.select().from(invoices).where(eq(invoices.id, existing.id)).limit(1);
  return updated[0];
}

export async function applyPaymentHubWebhook(input: { externalInvoiceId: string; event: string; status: string; paymentTxid?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const existing = await db.select().from(invoices).where(eq(invoices.externalInvoiceId, input.externalInvoiceId)).limit(1);
  const invoice = existing[0];
  if (!invoice) return { matched: false as const };
  const status = input.status.toUpperCase() === "PAID" || input.event === "invoice.paid"
    ? "awaiting_verification"
    : input.status.toUpperCase() === "EXPIRED" || input.event === "invoice.expired"
      ? "expired"
      : input.status.toUpperCase() === "CANCELLED" || input.event === "invoice.cancelled"
        ? "cancelled"
        : invoice.status;
  await db.update(invoices).set({ status, paymentTxid: input.paymentTxid || invoice.paymentTxid }).where(eq(invoices.id, invoice.id));
  if (invoice.createdByUserId) await db.insert(auditEvents).values({
    workspaceId: invoice.workspaceId,
    actorUserId: invoice.createdByUserId,
    action: input.event || "paymenthub.invoice.updated",
    entityType: "invoice",
    entityId: invoice.publicId,
    metadata: { externalInvoiceId: input.externalInvoiceId, paymentTxid: input.paymentTxid || null, status },
  });
  return { matched: true as const, status, publicId: invoice.publicId };
}

export async function finalizeVerifiedInvoice(input: { workspaceId: number; publicId: string; txid: string; verifiedAmountAtomic: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const invoice = await getInvoiceForWorkspace(input.workspaceId, input.publicId);
  if (!invoice) throw new Error("Invoice was not found in this workspace");
  if (invoice.status === "paid") return { status: "paid" as const, publicId: invoice.publicId, txid: invoice.paymentTxid };
  if (invoice.status !== "awaiting_verification" && invoice.status !== "awaiting_payment") throw new Error(`Invoice is not ready for verification (${invoice.status})`);
  if (input.verifiedAmountAtomic !== invoice.amountAtomic) throw new Error("Verified payment amount does not match the invoice");
  const posted = await db.select().from(ledgerEntries).where(and(eq(ledgerEntries.invoiceId, invoice.id), eq(ledgerEntries.state, "posted"))).limit(1);
  if (posted[0]) return { status: "paid" as const, publicId: invoice.publicId, txid: posted[0].externalTxid };
  const safe = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] || character);
  const receiptHtml = `<article><h1>Volta Finance payment receipt</h1><p><strong>Invoice:</strong> ${safe(invoice.publicId)}</p><p><strong>Client:</strong> ${safe(invoice.clientName)}</p><p><strong>Amount:</strong> ${safe(invoice.displayAmount)} ${invoice.asset}</p><p><strong>Transaction:</strong> ${safe(input.txid)}</p><p><strong>Status:</strong> Verified on Bitcoin Cash</p></article>`;
  await db.update(invoices).set({ status: "paid", paymentTxid: input.txid, receiptHtml, updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
  await db.insert(ledgerEntries).values([
    { workspaceId: invoice.workspaceId, invoiceId: invoice.id, asset: invoice.asset, amountAtomic: invoice.amountAtomic, direction: "debit", state: "posted", externalTxid: input.txid, account: "cash" },
    { workspaceId: invoice.workspaceId, invoiceId: invoice.id, asset: invoice.asset, amountAtomic: invoice.amountAtomic, direction: "credit", state: "posted", externalTxid: input.txid, account: "accounts.receivable" },
  ]);
  if (invoice.createdByUserId) await db.insert(auditEvents).values({ workspaceId: invoice.workspaceId, actorUserId: invoice.createdByUserId, action: "invoice.payment.verified", entityType: "invoice", entityId: invoice.publicId, metadata: { txid: input.txid, amountAtomic: input.verifiedAmountAtomic } });
  return { status: "paid" as const, publicId: invoice.publicId, txid: input.txid };
}

export async function createPaymentIntent(input: {
  workspaceId: number;
  createdByUserId: number;
  payerAsset: "BCH" | "PUSD" | "MUSD";
  recipientAsset: "BCH" | "PUSD" | "MUSD";
  recipientAddress: string;
  inputAmountAtomic: string;
  expectedOutputAtomic: string;
  quote: unknown;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const publicId = `INT-${nanoid(10).toUpperCase()}`;
  const inserted = await db.insert(paymentIntents).values({ publicId, workspaceId: input.workspaceId, createdByUserId: input.createdByUserId, payerAsset: input.payerAsset, recipientAsset: input.recipientAsset, recipientAddress: input.recipientAddress, inputAmountAtomic: input.inputAmountAtomic, expectedOutputAtomic: input.expectedOutputAtomic, quote: input.quote, status: "quoted" }).returning({ id: paymentIntents.id });
  const intentId = inserted[0]?.id;
  if (!intentId) throw new Error("Payment intent creation failed");
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.createdByUserId, action: "payment_intent.quoted", entityType: "payment_intent", entityId: publicId, metadata: { payerAsset: input.payerAsset, recipientAsset: input.recipientAsset, inputAmountAtomic: input.inputAmountAtomic, expectedOutputAtomic: input.expectedOutputAtomic } });
  const created = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  if (!created[0]) throw new Error("Payment intent creation failed");
  return created[0];
}

export async function createCrosschainIntent(input: {
  workspaceId: number;
  createdByUserId: number;
  sourceAsset: "BCH" | "PUSD";
  sourceAmountAtomic: string;
  invoicePublicId?: string;
  depositAddress: string;
  destinationAddress: string;
  expectedOutputAtomic: string;
  quote: unknown;
  expiresAt: Date;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const publicId = `XINT-${nanoid(10).toUpperCase()}`;
  const [created] = await db.insert(crosschainIntents).values({
    publicId,
    workspaceId: input.workspaceId,
    createdByUserId: input.createdByUserId,
    sourceAsset: input.sourceAsset,
    sourceAmountAtomic: input.sourceAmountAtomic,
    invoicePublicId: input.invoicePublicId ?? null,
    depositAddress: input.depositAddress,
    destinationAddress: input.destinationAddress,
    expectedOutputAtomic: input.expectedOutputAtomic,
    quote: input.quote,
    expiresAt: input.expiresAt,
  }).returning();
  if (!created) throw new Error("Crosschain intent creation failed");
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.createdByUserId, action: "crosschain_intent.created", entityType: "crosschain_intent", entityId: publicId, metadata: { sourceAsset: input.sourceAsset, sourceNetwork: "chipnet", sourceAmountAtomic: input.sourceAmountAtomic, destinationAsset: "XLM", destinationNetwork: "stellar-testnet", destinationAddress: input.destinationAddress, expectedOutputAtomic: input.expectedOutputAtomic } });
  return created;
}

export async function getCrosschainIntentForInvoice(input: { workspaceId: number; invoicePublicId: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [intent] = await db.select().from(crosschainIntents).where(and(eq(crosschainIntents.workspaceId, input.workspaceId), eq(crosschainIntents.invoicePublicId, input.invoicePublicId))).orderBy(desc(crosschainIntents.createdAt)).limit(1);
  return intent;
}

export async function expireUnfundedCrosschainIntent(input: { workspaceId: number; intentId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [expired] = await db.update(crosschainIntents).set({ status: "expired" })
    .where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId), eq(crosschainIntents.status, "awaiting_payment"), isNull(crosschainIntents.sourceTxid))).returning();
  return expired;
}

export async function finalizeCrosschainInvoice(input: { payerWorkspaceId: number; actorUserId: number; publicId: string; sourceAsset: "BCH" | "PUSD"; sourceAmountAtomic: string; stellarAmountAtomic: string; destinationAddress: string; sourceTxid: string; stellarTxid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    // A sent invoice remains `receivable` from the issuer's perspective. For
    // settlement, the authenticated payer workspace is identified by the
    // recipientWorkspaceId; filtering on the issuer-relative direction hid
    // valid incoming invoices from crosschain settlement.
    const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.publicId, input.publicId), eq(invoices.recipientWorkspaceId, input.payerWorkspaceId))).limit(1);
    if (!invoice) throw new Error("The invoice linked to this crosschain payment is no longer in this workspace.");
    if (invoice.deliveryAsset !== "XLM" || invoice.deliveryNetwork !== "stellar-testnet" || invoice.receivingAddress !== input.destinationAddress) throw new Error("The Stellar payout address does not match the address saved on this invoice.");
    const metadata = invoice.metadata && typeof invoice.metadata === "object" ? invoice.metadata as Record<string, unknown> : {};
    const existingSettlement = metadata.crosschainSettlement as { stellarTxid?: string } | undefined;
    if (invoice.status === "paid" && existingSettlement?.stellarTxid === input.stellarTxid) return invoice;
    if (invoice.status !== "awaiting_payment") throw new Error("This invoice is no longer awaiting payment.");
    const safe = (value: string) => value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] || character);
    const paidAmount = formatAtomicAmount(input.sourceAmountAtomic, input.sourceAsset);
    const receiptHtml = `<article><h1>Volta Finance crosschain invoice receipt</h1><p><strong>Invoice:</strong> ${safe(invoice.publicId)}</p><p><strong>Requested:</strong> ${safe(invoice.displayAmount)} ${safe(invoice.requestAsset)}</p><p><strong>Paid with:</strong> ${safe(paidAmount)} ${safe(input.sourceAsset)} on Chipnet</p><p><strong>Recipient received:</strong> ${safe(formatStellarXlmAtomic(input.stellarAmountAtomic))} XLM on Stellar Testnet</p><p><strong>Stellar recipient:</strong> ${safe(input.destinationAddress)}</p><p><strong>Chipnet transaction:</strong> ${safe(input.sourceTxid)}</p><p><strong>Stellar transaction:</strong> ${safe(input.stellarTxid)}</p><p><strong>Status:</strong> Confirmed testnet payment</p></article>`;
    const crosschainSettlement = { sourceAsset: input.sourceAsset, sourceNetwork: "chipnet", sourceAmountAtomic: input.sourceAmountAtomic, sourceTxid: input.sourceTxid, destinationAsset: "XLM", destinationNetwork: "stellar-testnet", destinationAmountAtomic: input.stellarAmountAtomic, destinationAddress: input.destinationAddress, stellarTxid: input.stellarTxid };
    const [updated] = await tx.update(invoices).set({ status: "paid", paymentTxid: input.stellarTxid, receiptHtml, metadata: { ...metadata, crosschainSettlement }, updatedAt: new Date() }).where(and(eq(invoices.id, invoice.id), eq(invoices.status, "awaiting_payment"))).returning();
    if (!updated) throw new Error("The invoice changed while its crosschain payment was being recorded.");
    await tx.insert(auditEvents).values({ workspaceId: invoice.workspaceId, actorUserId: invoice.createdByUserId ?? input.actorUserId, action: "invoice.crosschain.paid", entityType: "invoice", entityId: invoice.publicId, metadata: crosschainSettlement });
    return updated;
  });
}

export async function getCrosschainIntentForWorkspace(input: { workspaceId: number; intentId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [intent] = await db.select().from(crosschainIntents).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId))).limit(1);
  return intent;
}

export async function listCrosschainIntentsForWorkspace(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(crosschainIntents).where(eq(crosschainIntents.workspaceId, workspaceId)).orderBy(desc(crosschainIntents.createdAt)).limit(20);
}

export async function recordCrosschainSourceTx(input: { workspaceId: number; intentId: number; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [used] = await db.select({ id: crosschainIntents.id }).from(crosschainIntents).where(eq(crosschainIntents.sourceTxid, input.txid)).limit(1);
  if (used && used.id !== input.intentId) throw new Error("This Chipnet transaction has already been linked to another crosschain intent.");
  const [current] = await db.select().from(crosschainIntents).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId))).limit(1);
  if (!current) throw new Error("Crosschain intent was not found in this workspace");
  if (current.sourceTxid) {
    if (current.sourceTxid !== input.txid) throw new Error("This crosschain intent already has a different BCH transaction.");
    return current;
  }
  // Quote expiry stops a payer from starting a new payment. It must not orphan
  // a transaction that the wallet already signed and broadcast while the quote
  // was still on screen; settlement rechecks the confirmed on-chain output
  // against this intent's exact asset, address, and amount before paying XLM.
  if (current.status !== "awaiting_payment" && current.status !== "expired") throw new Error("This crosschain intent is no longer awaiting payment.");
  let updated: typeof crosschainIntents.$inferSelect | undefined;
  try {
  [updated] = await db.update(crosschainIntents).set({ sourceTxid: input.txid, status: "pending_verification" }).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId), inArray(crosschainIntents.status, ["awaiting_payment", "expired"]))).returning();
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") throw new Error("This Chipnet transaction has already been linked to another crosschain intent.");
    throw error;
  }
  if (!updated) throw new Error("This crosschain intent changed before its BCH payment could be recorded.");
  return updated;
}

export async function saveCrosschainStellarTransaction(input: { workspaceId: number; intentId: number; txid: string; signedXdr: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(crosschainIntents).set({ status: "paying", stellarTxid: input.txid, stellarSignedXdr: input.signedXdr }).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId), eq(crosschainIntents.status, "pending_verification"))).returning();
  if (updated) return updated;
  const [current] = await db.select().from(crosschainIntents).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId))).limit(1);
  if (current?.status === "paying" && current.stellarTxid === input.txid) return current;
  throw new Error("Crosschain intent is not ready for Stellar payout.");
}

export async function completeCrosschainIntent(input: { workspaceId: number; intentId: number; stellarTxid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(crosschainIntents).set({ status: "completed", stellarTxid: input.stellarTxid, stellarSignedXdr: null, failureReason: null }).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId), eq(crosschainIntents.status, "paying"))).returning();
  if (updated) {
    await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: updated.createdByUserId, action: "crosschain_intent.completed", entityType: "crosschain_intent", entityId: updated.publicId, metadata: { sourceTxid: updated.sourceTxid, stellarTxid: input.stellarTxid, sourceAmountAtomic: updated.sourceAmountAtomic, expectedOutputAtomic: updated.expectedOutputAtomic } });
    return updated;
  }
  const [current] = await db.select().from(crosschainIntents).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId))).limit(1);
  if (current?.status === "completed" && current.stellarTxid === input.stellarTxid) return current;
  throw new Error("Crosschain intent changed before settlement completed.");
}

export async function failCrosschainIntent(input: { workspaceId: number; intentId: number; reason: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(crosschainIntents).set({ status: "failed", failureReason: input.reason.slice(0, 1000) }).where(and(eq(crosschainIntents.id, input.intentId), eq(crosschainIntents.workspaceId, input.workspaceId), eq(crosschainIntents.status, "pending_verification"))).returning();
  return updated;
}

export async function getPaymentIntentForWorkspace(workspaceId: number, intentId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).limit(1);
  return rows[0]?.workspaceId === workspaceId ? rows[0] : undefined;
}

export async function recordUnsignedTransaction(input: { workspaceId: number; intentId: number; unsignedTxHex: string; metadata: unknown }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const inserted = await db.insert(blockchainTransactions).values({ workspaceId: input.workspaceId, intentId: input.intentId, status: "unsigned", unsignedTxHex: input.unsignedTxHex, metadata: input.metadata }).returning({ id: blockchainTransactions.id });
  await db.update(paymentIntents).set({ status: "awaiting_signature" }).where(eq(paymentIntents.id, input.intentId));
  const transactionId = inserted[0]?.id;
  if (!transactionId) throw new Error("Transaction record creation failed");
  return transactionId;
}

export async function markPaymentIntentBroadcast(input: { workspaceId: number; intentId: number; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const intent = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.intentId)).limit(1);
  if (!intent[0] || intent[0].workspaceId !== input.workspaceId) throw new Error("Payment intent was not found in this workspace");
  await db.update(paymentIntents).set({ status: "pending_verification", txid: input.txid }).where(eq(paymentIntents.id, input.intentId));
  await db.update(blockchainTransactions).set({ status: "broadcast", txid: input.txid }).where(eq(blockchainTransactions.intentId, input.intentId));
  return { intentId: input.intentId, txid: input.txid, status: "pending_verification" as const };
}

export async function finalizeVerifiedIntent(input: { workspaceId: number; intentId: number; txid: string; verified: boolean; verifiedAmountAtomic: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const intent = await db.select().from(paymentIntents).where(eq(paymentIntents.id, input.intentId)).limit(1);
  if (!intent[0] || intent[0].workspaceId !== input.workspaceId) throw new Error("Payment intent was not found in this workspace");
  if (!input.verified) {
    await db.update(paymentIntents).set({ status: "failed", failureReason: "Recipient output verification failed" }).where(eq(paymentIntents.id, input.intentId));
    await db.update(blockchainTransactions).set({ status: "failed", txid: input.txid }).where(eq(blockchainTransactions.intentId, input.intentId));
    return { status: "failed" as const, txid: input.txid };
  }
  if (intent[0].status === "completed") return { status: "completed" as const, txid: input.txid };
  await db.insert(ledgerEntries).values([
    { workspaceId: input.workspaceId, asset: intent[0].payerAsset, amountAtomic: intent[0].inputAmountAtomic, direction: "debit", state: "posted", externalTxid: input.txid, account: "intent:payer" },
    { workspaceId: input.workspaceId, asset: intent[0].recipientAsset, amountAtomic: input.verifiedAmountAtomic, direction: "credit", state: "posted", externalTxid: input.txid, account: "intent:recipient" },
  ]);
  await db.update(paymentIntents).set({ status: "completed", txid: input.txid, expectedOutputAtomic: input.verifiedAmountAtomic }).where(eq(paymentIntents.id, input.intentId));
  await db.update(blockchainTransactions).set({ status: "confirmed", txid: input.txid }).where(eq(blockchainTransactions.intentId, input.intentId));
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: intent[0].createdByUserId, action: "payment_intent.verified", entityType: "payment_intent", entityId: intent[0].publicId, metadata: { txid: input.txid, verified: true } });
  await createNotification({ recipientUserId: intent[0].createdByUserId, workspaceId: input.workspaceId, category: "payment", title: "Payment completed", body: `Your ${intent[0].payerAsset} to ${intent[0].recipientAsset} payment is verified. Transaction ${input.txid.slice(0, 12)}…`, href: "/records", entityType: "payment_intent", entityId: intent[0].publicId });
  return { status: "completed" as const, txid: input.txid };
}

export async function listEmployeesForWorkspace(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(employees).where(eq(employees.workspaceId, workspaceId)).orderBy(desc(employees.createdAt));
}

export async function listOrganizationMembersForWorkspace(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select({ userId: users.id, email: users.email, name: users.name, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(desc(workspaceMembers.createdAt));
}

export async function addMemberToPayroll(input: { workspaceId: number; actorUserId: number; memberUserId: number; roleTitle: string; amountAtomic: string; displayAmount: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [member] = await db.select({ userId: users.id, name: users.name, email: users.email })
    .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.memberUserId))).limit(1);
  if (!member) throw new Error("Choose a current member of this organization");
  const [existing] = await db.select().from(employees).where(and(eq(employees.workspaceId, input.workspaceId), sql`lower(${employees.email}) = ${member.email.toLowerCase()}`)).limit(1);
  if (existing) {
    const [updated] = await db.update(employees).set({ fullName: member.name || member.email, roleTitle: input.roleTitle.trim(), monthlyAmountAtomic: input.amountAtomic, monthlyDisplayAmount: input.displayAmount, monthlyAmountUnit: "USDT", active: 1, updatedAt: new Date() }).where(eq(employees.id, existing.id)).returning();
    await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.member.added", entityType: "employee", entityId: String(existing.id), metadata: { email: member.email } });
    await createNotification({ recipientUserId: member.userId, workspaceId: input.workspaceId, category: "payroll", title: "Added to organization payroll", body: `You were added to payroll as ${input.roleTitle.trim()}. Add your payout address and preferred asset in your organization settings.`, href: "/payroll", entityType: "employee", entityId: String(existing.id) });
    return updated;
  }
  const [stellarDefault] = await db.select({ id: stellarDestinations.id }).from(stellarDestinations).where(and(eq(stellarDestinations.userId, member.userId), eq(stellarDestinations.isDefault, true))).limit(1);
  const [created] = await db.insert(employees).values({ workspaceId: input.workspaceId, fullName: member.name || member.email, email: member.email, roleTitle: input.roleTitle.trim(), walletAddress: null, preferredAsset: stellarDefault ? "XLM" : "BCH", monthlyAmountAtomic: input.amountAtomic, monthlyDisplayAmount: input.displayAmount, monthlyAmountUnit: "USDT", active: 1 }).returning();
  if (!created) throw new Error("Payroll member could not be saved");
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.member.added", entityType: "employee", entityId: String(created.id), metadata: { email: member.email } });
  await createNotification({ recipientUserId: member.userId, workspaceId: input.workspaceId, category: "payroll", title: "Added to organization payroll", body: `You were added to payroll as ${input.roleTitle.trim()}. Add your payout address and preferred asset in your organization settings.`, href: "/payroll", entityType: "employee", entityId: String(created.id) });
  return created;
}

export async function addMembersToPayroll(input: { workspaceId: number; actorUserId: number; members: Array<{ memberUserId: number; roleTitle: string; amountAtomic: string; displayAmount: string }> }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const added = [];
    for (const item of input.members) {
      const [member] = await tx.select({ userId: users.id, name: users.name, email: users.email })
        .from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, item.memberUserId))).limit(1);
      if (!member) throw new Error("A selected person is no longer a member of this organization. Refresh and try again.");
      const [existing] = await tx.select().from(employees).where(and(eq(employees.workspaceId, input.workspaceId), sql`lower(${employees.email}) = ${member.email.toLowerCase()}`)).limit(1);
      const [stellarDefault] = await tx.select({ id: stellarDestinations.id }).from(stellarDestinations).where(and(eq(stellarDestinations.userId, member.userId), eq(stellarDestinations.isDefault, true))).limit(1);
      const employee = existing
        ? (await tx.update(employees).set({ fullName: member.name || member.email, roleTitle: item.roleTitle.trim(), monthlyAmountAtomic: item.amountAtomic, monthlyDisplayAmount: item.displayAmount, monthlyAmountUnit: "USDT", active: 1, updatedAt: new Date() }).where(eq(employees.id, existing.id)).returning())[0]
        : (await tx.insert(employees).values({ workspaceId: input.workspaceId, fullName: member.name || member.email, email: member.email, roleTitle: item.roleTitle.trim(), walletAddress: null, preferredAsset: stellarDefault ? "XLM" : "BCH", monthlyAmountAtomic: item.amountAtomic, monthlyDisplayAmount: item.displayAmount, monthlyAmountUnit: "USDT", active: 1 }).returning())[0];
      if (!employee) throw new Error(`Could not add ${member.email} to payroll.`);
      added.push(employee);
      await tx.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.member.added", entityType: "employee", entityId: String(employee.id), metadata: { email: member.email } });
      await tx.insert(notifications).values({ recipientUserId: member.userId, workspaceId: input.workspaceId, category: "payroll", title: "Added to organization payroll", body: `You were added to payroll as ${item.roleTitle.trim()}. Add your payout address and preferred asset in your organization workspace.`, href: "/payroll", entityType: "employee", entityId: String(employee.id) });
    }
    return added;
  });
}

export async function updateEmployeePayoutPreference(input: { workspaceId: number; email: string; asset: PayrollAsset }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(employees).set({ preferredAsset: input.asset, updatedAt: new Date() })
    .where(and(eq(employees.workspaceId, input.workspaceId), sql`lower(${employees.email}) = ${input.email.trim().toLowerCase()}`, eq(employees.active, 1))).returning({ id: employees.id, preferredAsset: employees.preferredAsset, walletAddress: employees.walletAddress });
  return updated;
}

export async function updateEmployeePayrollEnrollment(input: { workspaceId: number; actorUserId: number; employeeId: number; active?: boolean; amountAtomic?: string; displayAmount?: string; roleTitle?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const values: Partial<typeof employees.$inferInsert> = { updatedAt: new Date() };
  if (input.active !== undefined) values.active = input.active ? 1 : 0;
  if (input.amountAtomic !== undefined) values.monthlyAmountAtomic = input.amountAtomic;
  if (input.displayAmount !== undefined) values.monthlyDisplayAmount = input.displayAmount;
  if (input.amountAtomic !== undefined) values.monthlyAmountUnit = "USDT";
  if (input.roleTitle !== undefined) values.roleTitle = input.roleTitle.trim();
  const [updated] = await db.update(employees).set(values).where(and(eq(employees.id, input.employeeId), eq(employees.workspaceId, input.workspaceId))).returning();
  if (updated) await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: input.active === false ? "payroll.member.removed" : "payroll.member.updated", entityType: "employee", entityId: String(input.employeeId), metadata: { roleTitle: input.roleTitle, displayAmount: input.displayAmount, active: updated.active } });
  return updated;
}

export async function getEmployeePayrollForUser(input: { workspaceId: number; email: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [employee] = await db.select().from(employees).where(and(eq(employees.workspaceId, input.workspaceId), sql`lower(${employees.email}) = ${input.email.trim().toLowerCase()}`)).limit(1);
  if (!employee) return { employee: null, payments: [] };
  const payments = await db.select({ period: payrollRuns.period, runStatus: payrollRuns.status, amountAtomic: payrollItems.amountAtomic, requestedAmountAtomic: payrollItems.requestedAmountAtomic, displayAmount: payrollItems.displayAmount, requestedAmountUnit: payrollItems.requestedAmountUnit, asset: payrollItems.asset, status: payrollItems.status, txid: payrollItems.txid, payslipHtml: payslips.documentHtml, paidAt: payrollItems.updatedAt })
    .from(payrollItems).innerJoin(payrollRuns, and(eq(payrollItems.runId, payrollRuns.id), eq(payrollItems.workspaceId, payrollRuns.workspaceId)))
    .leftJoin(payslips, and(eq(payslips.payrollItemId, payrollItems.id), eq(payslips.employeeId, employee.id), eq(payslips.workspaceId, input.workspaceId)))
    .where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.employeeId, employee.id))).orderBy(desc(payrollItems.updatedAt));
  const [bchDestination, tokenDestination, stellarDestination] = await Promise.all([
    getPersonalPayrollDestination({ email: input.email, asset: "BCH" }),
    getPersonalPayrollDestination({ email: input.email, asset: "PUSD" }),
    getPersonalStellarDestination({ email: input.email }),
  ]);
  const isStellarAsset = employee.preferredAsset === "XLM" || employee.preferredAsset === "USDC";
  const destination = isStellarAsset ? stellarDestination : employee.preferredAsset === "BCH" ? bchDestination : tokenDestination;
  return { employee: { id: employee.id, fullName: employee.fullName, roleTitle: employee.roleTitle, preferredAsset: employee.preferredAsset, walletAddress: destination?.address ?? null, walletNetwork: isStellarAsset ? (stellarDestination ? "stellar-testnet" : null) : (destination && "network" in destination ? destination.network : null), bchAddress: bchDestination?.address ?? null, bchNetwork: bchDestination?.network ?? null, tokenAddress: tokenDestination?.address ?? null, tokenNetwork: tokenDestination?.network ?? null, stellarAddress: stellarDestination?.address ?? null, stellarNetwork: stellarDestination ? "stellar-testnet" as const : null, monthlyDisplayAmount: employee.monthlyDisplayAmount, monthlyAmountUnit: employee.monthlyAmountUnit, active: Boolean(employee.active) }, payments };
}

export async function importEmployeesForWorkspace(input: { workspaceId: number; actorUserId: number; rows: Array<{ fullName: string; email?: string; roleTitle: string; walletAddress?: string; preferredAsset: "BCH" | "PUSD" | "MUSD"; monthlyAmountAtomic: string; monthlyDisplayAmount: string }> }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  if (!input.rows.length || input.rows.length > 500) throw new Error("Employee import must contain between 1 and 500 rows");
  await db.insert(employees).values(input.rows.map((row) => ({ ...row, workspaceId: input.workspaceId, email: row.email || null, walletAddress: row.walletAddress || null })));
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.employees.imported", entityType: "employee", entityId: null, metadata: { count: input.rows.length } });
  return listEmployeesForWorkspace(input.workspaceId);
}

export async function createPayrollRunForWorkspace(input: { workspaceId: number; actorUserId: number; period: string; sourceAsset: "BCH" | "PUSD" | "MUSD"; items: Array<{ employeeId: number; amountAtomic: string; requestedAmountAtomic: string; displayAmount: string; asset: PayrollAsset; payoutAddress: string }>; stellarFunding?: { address: string; amountAtomic: string; quote: unknown } }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  if (!input.items.length) throw new Error("Cannot create a payroll run without employees");
  const employeeRows = await listEmployeesForWorkspace(input.workspaceId);
  const employeeById = new Map(employeeRows.map((employee) => [employee.id, employee]));
  if (input.items.some((item) => !employeeById.has(item.employeeId))) throw new Error("Payroll contains an employee outside this workspace");
  if (new Set(input.items.map((item) => item.employeeId)).size !== input.items.length) throw new Error("A payroll run can include each staff member only once");
  if (input.items.some((item) => { const employee = employeeById.get(item.employeeId); return !employee?.active || !item.payoutAddress || employee.preferredAsset !== item.asset || employee.monthlyAmountUnit !== "USDT"; })) throw new Error("Every payroll member must have a saved USDT pay amount, personal payout address, and selected payout asset");
  if (input.items.some((item) => item.asset === "XLM" || item.asset === "USDC") && (input.sourceAsset !== "PUSD" || !input.stellarFunding)) throw new Error("Stellar payroll requires PUSD funding and a configured Stellar destination.");
  const total = input.items.reduce((sum, item) => sum + BigInt(item.requestedAmountAtomic), 0n).toString();
  const publicId = `PAY-${nanoid(10).toUpperCase()}`;
  const inserted = await db.insert(payrollRuns).values({ publicId, workspaceId: input.workspaceId, createdByUserId: input.actorUserId, period: input.period, sourceAsset: input.sourceAsset, totalAmountAtomic: total, totalAmountUnit: "USDT", status: "draft", ...(input.stellarFunding ? { stellarFundingAddress: input.stellarFunding.address, stellarFundingAmountAtomic: input.stellarFunding.amountAtomic, stellarPayoutQuote: input.stellarFunding.quote } : {}) }).returning({ id: payrollRuns.id });
  const runId = inserted[0]?.id;
  if (!runId) throw new Error("Payroll run creation failed");
  await db.insert(payrollItems).values(input.items.map((item) => ({ ...item, requestedAmountUnit: "USDT" as const, runId, workspaceId: input.workspaceId, status: "pending" as const })));
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.run.created", entityType: "payroll_run", entityId: publicId, metadata: { period: input.period, count: input.items.length, sourceAsset: input.sourceAsset } });
  const created = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  if (!created[0]) throw new Error("Payroll run creation failed");
  return created[0];
}

export async function listPayrollRunsForWorkspace(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(payrollRuns).where(eq(payrollRuns.workspaceId, workspaceId)).orderBy(desc(payrollRuns.createdAt));
}

export async function getPayrollRunForWorkspace(workspaceId: number, runId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId)).limit(1);
  return rows[0]?.workspaceId === workspaceId ? rows[0] : undefined;
}

export async function listPayrollItemsForRun(workspaceId: number, runId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(payrollItems).where(and(eq(payrollItems.workspaceId, workspaceId), eq(payrollItems.runId, runId)));
}

export async function getPayrollItemForWorkspace(workspaceId: number, itemId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const rows = await db.select().from(payrollItems).where(and(eq(payrollItems.workspaceId, workspaceId), eq(payrollItems.id, itemId))).limit(1);
  return rows[0];
}

export async function approvePayrollRun(input: { workspaceId: number; actorUserId: number; runId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const run = await getPayrollRunForWorkspace(input.workspaceId, input.runId);
  if (!run) throw new Error("Payroll run was not found in this workspace");
  if (run.status !== "draft") throw new Error("Only draft payroll runs can be approved");
  await db.update(payrollRuns).set({ status: "approved" }).where(eq(payrollRuns.id, input.runId));
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: input.actorUserId, action: "payroll.run.approved", entityType: "payroll_run", entityId: run.publicId, metadata: { totalAmountAtomic: run.totalAmountAtomic } });
  return { ...run, status: "approved" as const };
}

export async function updatePayrollRunStatus(input: { workspaceId: number; runId: number; status: "processing" | "completed" | "partial" | "failed" | "cancelled"; txid?: string; sourceSpendAtomic?: string; bchCostAtomic?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const run = await getPayrollRunForWorkspace(input.workspaceId, input.runId);
  if (!run) throw new Error("Payroll run was not found in this workspace");
  if ((input.status === "processing" || input.status === "completed") && input.txid && input.sourceSpendAtomic !== undefined && input.bchCostAtomic !== undefined) {
    const [existingDebit] = await db.select({ id: ledgerEntries.id }).from(ledgerEntries).where(and(eq(ledgerEntries.workspaceId, input.workspaceId), eq(ledgerEntries.externalTxid, input.txid), eq(ledgerEntries.account, "cash"), isNull(ledgerEntries.invoiceId))).limit(1);
    if (!existingDebit) {
      const debits = [];
      const entryState = input.status === "completed" ? "posted" as const : "pending" as const;
      if (BigInt(input.sourceSpendAtomic) > 0n) debits.push({ workspaceId: input.workspaceId, asset: run.sourceAsset, amountAtomic: input.sourceSpendAtomic, direction: "credit" as const, state: entryState, externalTxid: input.txid, account: "cash" });
      if (run.sourceAsset !== "BCH" && BigInt(input.bchCostAtomic) > 0n) debits.push({ workspaceId: input.workspaceId, asset: "BCH" as const, amountAtomic: input.bchCostAtomic, direction: "credit" as const, state: entryState, externalTxid: input.txid, account: "cash" });
      if (debits.length) await db.insert(ledgerEntries).values(debits);
    }
  }
  if (input.status === "completed") {
    const [runItem] = await db.select({ txid: payrollItems.txid }).from(payrollItems).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId))).limit(1);
    if (runItem?.txid) await db.update(ledgerEntries).set({ state: "posted" }).where(and(eq(ledgerEntries.workspaceId, input.workspaceId), eq(ledgerEntries.externalTxid, runItem.txid), eq(ledgerEntries.account, "cash"), isNull(ledgerEntries.invoiceId), eq(ledgerEntries.state, "pending")));
  }
  if (input.status === "cancelled") {
    if (run.status !== "draft" && run.status !== "approved") throw new Error("Only an unpaid draft or approved payroll run can be cancelled");
    const items = await db.select({ status: payrollItems.status }).from(payrollItems).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId)));
    if (items.some((item) => item.status !== "pending")) throw new Error("This run has already started processing and can no longer be cancelled");
  }
  await db.update(payrollRuns).set({ status: input.status }).where(eq(payrollRuns.id, input.runId));
  return { ...run, status: input.status };
}

export async function recordStellarPayrollFunding(input: { workspaceId: number; runId: number; txid: string; sourceSpendAtomic: string; bchCostAtomic: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId))).limit(1);
    if (!run?.stellarFundingAmountAtomic || !run.stellarFundingAddress) throw new Error("This payroll run has no Stellar funding plan.");
    if (run.stellarFundingTxid && run.stellarFundingTxid !== input.txid) throw new Error("This payroll run already has a different funding transaction. Recheck it before proceeding.");
    if (!run.stellarFundingTxid) {
      const [existingDebit] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(and(eq(ledgerEntries.workspaceId, input.workspaceId), eq(ledgerEntries.externalTxid, input.txid), eq(ledgerEntries.account, "cash"), isNull(ledgerEntries.invoiceId))).limit(1);
      if (!existingDebit) {
        const entries = [];
        if (BigInt(input.sourceSpendAtomic) > 0n) entries.push({ workspaceId: input.workspaceId, asset: run.sourceAsset, amountAtomic: input.sourceSpendAtomic, direction: "credit" as const, state: "pending" as const, externalTxid: input.txid, account: "cash" });
        if (run.sourceAsset !== "BCH" && BigInt(input.bchCostAtomic) > 0n) entries.push({ workspaceId: input.workspaceId, asset: "BCH" as const, amountAtomic: input.bchCostAtomic, direction: "credit" as const, state: "pending" as const, externalTxid: input.txid, account: "cash" });
        if (entries.length) await tx.insert(ledgerEntries).values(entries);
      }
    }
    const [updated] = await tx.update(payrollRuns).set({ stellarFundingTxid: input.txid, status: "processing", updatedAt: new Date() }).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId))).returning();
    if (!updated) throw new Error("Could not save the Stellar payroll funding transaction.");
    return updated;
  });
}

export async function saveStellarPayrollTransaction(input: { workspaceId: number; runId: number; txid: string; signedXdr: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [updated] = await db.update(payrollRuns).set({ stellarPayoutTxid: input.txid, stellarPayoutSignedXdr: input.signedXdr }).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId), isNull(payrollRuns.stellarPayoutTxid))).returning();
  if (updated) return updated;
  const run = await getPayrollRunForWorkspace(input.workspaceId, input.runId);
  if (run?.stellarPayoutTxid === input.txid && run.stellarPayoutSignedXdr === input.signedXdr) return run;
  throw new Error("A Stellar payroll transaction has already been prepared. Recheck the saved transaction before retrying.");
}

export async function resetFailedStellarPayrollForRetry(input: { workspaceId: number; runId: number; failedTxid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId))).limit(1);
    if (!run || run.stellarPayoutTxid !== input.failedTxid) throw new Error("The failed Stellar transaction no longer matches this payroll run.");
    await tx.update(payrollRuns).set({ status: "processing", stellarPayoutTxid: null, stellarPayoutSignedXdr: null, updatedAt: new Date() }).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId)));
    await tx.update(payrollItems).set({ status: "pending", txid: null, failureReason: null, updatedAt: new Date() }).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId), inArray(payrollItems.asset, ["XLM", "USDC"])));
    await tx.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: run.createdByUserId, action: "payroll.stellar.retry_started", entityType: "payroll_run", entityId: run.publicId, metadata: { failedStellarTxid: input.failedTxid } });
  });
}

export async function markStellarPayrollFailed(input: { workspaceId: number; runId: number; txid: string; reason: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId))).limit(1);
    if (!run || run.stellarPayoutTxid !== input.txid) throw new Error("The failed Stellar transaction no longer matches this payroll run.");
    await tx.update(payrollItems).set({ status: "failed", txid: input.txid, failureReason: input.reason, updatedAt: new Date() }).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId), inArray(payrollItems.asset, ["XLM", "USDC"])));
    await tx.update(payrollRuns).set({ status: "partial", stellarPayoutSignedXdr: null, updatedAt: new Date() }).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId)));
    await tx.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: run.createdByUserId, action: "payroll.stellar.failed", entityType: "payroll_run", entityId: run.publicId, metadata: { stellarTxid: input.txid, reason: input.reason } });
  });
}

export async function completeStellarPayrollRun(input: { workspaceId: number; runId: number; txid: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const run = await getPayrollRunForWorkspace(input.workspaceId, input.runId);
  if (!run || !run.stellarFundingTxid || run.stellarPayoutTxid !== input.txid) throw new Error("The Stellar payroll transaction does not match this saved run.");
  const runItems = await listPayrollItemsForRun(input.workspaceId, input.runId);
  if (runItems.some((item) => item.asset !== "XLM" && item.asset !== "USDC" && item.status !== "verified")) throw new Error("Verify every Chipnet payout before completing the Stellar payroll run.");
  await db.update(payrollItems).set({ status: "verified", txid: input.txid, updatedAt: new Date() }).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId), inArray(payrollItems.asset, ["XLM", "USDC"])));
  await db.update(payrollRuns).set({ status: "completed", stellarPayoutSignedXdr: null, updatedAt: new Date() }).where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId)));
  await db.update(ledgerEntries).set({ state: "posted" }).where(and(eq(ledgerEntries.workspaceId, input.workspaceId), eq(ledgerEntries.externalTxid, run.stellarFundingTxid), eq(ledgerEntries.account, "cash"), isNull(ledgerEntries.invoiceId), eq(ledgerEntries.state, "pending")));
  await db.insert(auditEvents).values({ workspaceId: input.workspaceId, actorUserId: run.createdByUserId, action: "payroll.stellar.completed", entityType: "payroll_run", entityId: run.publicId, metadata: { fundingTxid: run.stellarFundingTxid, stellarTxid: input.txid } });
  return { ...run, status: "completed" as const, stellarPayoutTxid: input.txid };
}

export async function updatePayrollRunSourceAsset(input: { workspaceId: number; runId: number; sourceAsset: Asset }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const run = await getPayrollRunForWorkspace(input.workspaceId, input.runId);
  if (!run) throw new Error("Payroll run was not found in this workspace");
  if (run.status !== "draft" && run.status !== "approved") throw new Error("Choose the payment asset before payroll processing starts");
  const items = await db.select({ status: payrollItems.status }).from(payrollItems).where(and(eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId)));
  if (items.some((item) => item.status !== "pending")) throw new Error("The payment asset cannot change after a payout has started");
  await db.update(payrollRuns).set({ sourceAsset: input.sourceAsset }).where(and(eq(payrollRuns.id, input.runId), eq(payrollRuns.workspaceId, input.workspaceId)));
  return { ...run, sourceAsset: input.sourceAsset };
}

export async function updatePayrollItem(input: { workspaceId: number; itemId: number; status: "quoted" | "awaiting_signature" | "broadcast" | "verified" | "failed"; intentId?: number; txid?: string; failureReason?: string; amountAtomic?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const existing = await db.select().from(payrollItems).where(eq(payrollItems.id, input.itemId)).limit(1);
  if (!existing[0] || existing[0].workspaceId !== input.workspaceId) throw new Error("Payroll item was not found in this workspace");
  await db.update(payrollItems).set({ status: input.status, intentId: input.intentId, txid: input.txid, failureReason: input.failureReason ?? null, ...(input.amountAtomic ? { amountAtomic: input.amountAtomic } : {}) }).where(and(eq(payrollItems.id, input.itemId), eq(payrollItems.workspaceId, input.workspaceId)));
  if (input.status === "verified") {
    const [employee] = await db.select({ userId: users.id, employeeId: employees.id, email: employees.email, name: employees.fullName }).from(payrollItems).innerJoin(employees, eq(payrollItems.employeeId, employees.id)).leftJoin(users, sql`lower(${users.email}) = lower(${employees.email})`).where(eq(payrollItems.id, input.itemId)).limit(1);
    if (employee?.userId) await createNotification({ recipientUserId: employee.userId, workspaceId: input.workspaceId, category: "payroll", title: "Payroll payment verified", body: `Your payment${input.txid ? ` (${input.txid.slice(0, 12)}…)` : ""} is verified and your payslip is available in Volta Finance.`, href: "/payroll", entityType: "payroll_item", entityId: String(input.itemId) });
  }
  return { itemId: input.itemId, status: input.status, txid: input.txid };
}

export async function createPayslipForItem(input: { workspaceId: number; runId: number; payrollItemId: number; employeeId: number; documentHtml: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const item = await db.select().from(payrollItems).where(and(eq(payrollItems.id, input.payrollItemId), eq(payrollItems.workspaceId, input.workspaceId), eq(payrollItems.runId, input.runId), eq(payrollItems.employeeId, input.employeeId))).limit(1);
  if (!item[0]) throw new Error("Payroll item was not found in this workspace");
  const existing = await db.select({ publicId: payslips.publicId }).from(payslips).where(and(eq(payslips.payrollItemId, input.payrollItemId), eq(payslips.workspaceId, input.workspaceId))).limit(1);
  if (existing[0]) return existing[0].publicId;
  const publicId = `SLIP-${nanoid(10).toUpperCase()}`;
  await db.insert(payslips).values({ publicId, workspaceId: input.workspaceId, runId: input.runId, payrollItemId: input.payrollItemId, employeeId: input.employeeId, status: "available", documentHtml: input.documentHtml });
  return publicId;
}

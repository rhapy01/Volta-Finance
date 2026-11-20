import { and, desc, eq } from "drizzle-orm";
import { evmDestinations, users, type EvmReceiveAsset, type EvmReceiveNetwork } from "../drizzle/schema";
import { getDb } from "./db";
import { parseEvmPayrollRoute, type EvmPayrollRoute } from "./integrations/evmNetworks";

export async function listEvmDestinationsForUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.select().from(evmDestinations).where(eq(evmDestinations.userId, userId)).orderBy(desc(evmDestinations.isDefault), desc(evmDestinations.createdAt));
}

export async function addEvmDestination(input: { userId: number; label: string; network: EvmReceiveNetwork; asset: EvmReceiveAsset; address: string; makeDefault: boolean }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(evmDestinations).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.network, input.network), eq(evmDestinations.asset, input.asset), eq(evmDestinations.address, input.address))).limit(1);
    if (input.makeDefault) await tx.update(evmDestinations).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.network, input.network), eq(evmDestinations.asset, input.asset)));
    if (existing) {
      const [updated] = await tx.update(evmDestinations).set({ label: input.label, isDefault: input.makeDefault || existing.isDefault, isArchived: false, updatedAt: new Date() }).where(eq(evmDestinations.id, existing.id)).returning();
      return updated;
    }
    const [created] = await tx.insert(evmDestinations).values({ ...input, isDefault: input.makeDefault }).returning();
    return created;
  });
}

export async function setDefaultEvmDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db.transaction(async (tx) => {
    const [destination] = await tx.select().from(evmDestinations).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.id, input.destinationId))).limit(1);
    if (!destination) return false;
    await tx.update(evmDestinations).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.network, destination.network), eq(evmDestinations.asset, destination.asset)));
    await tx.update(evmDestinations).set({ isDefault: true, isArchived: false, updatedAt: new Date() }).where(eq(evmDestinations.id, destination.id));
    return true;
  });
}

export async function deleteEvmDestination(input: { userId: number; destinationId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [deleted] = await db.delete(evmDestinations).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.id, input.destinationId))).returning({ id: evmDestinations.id });
  return deleted;
}

export async function getDefaultEvmDestination(input: { userId: number; network: EvmReceiveNetwork; asset: EvmReceiveAsset }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const [destination] = await db.select().from(evmDestinations).where(and(eq(evmDestinations.userId, input.userId), eq(evmDestinations.network, input.network), eq(evmDestinations.asset, input.asset), eq(evmDestinations.isDefault, true))).limit(1);
  return destination;
}

export async function getPersonalEvmDestination(input: { email: string; route: EvmPayrollRoute }) {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  const route = parseEvmPayrollRoute(input.route);
  if (!route) return undefined;
  const [destination] = await db.select({ id: evmDestinations.id, label: evmDestinations.label, network: evmDestinations.network, asset: evmDestinations.asset, address: evmDestinations.address }).from(evmDestinations)
    .innerJoin(users, eq(evmDestinations.userId, users.id))
    .where(and(eq(users.email, input.email.trim().toLowerCase()), eq(evmDestinations.network, route.network), eq(evmDestinations.asset, route.asset), eq(evmDestinations.isDefault, true)))
    .limit(1);
  return destination;
}

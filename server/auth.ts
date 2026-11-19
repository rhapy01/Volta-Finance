import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createAccount, createUserSession, deleteUserSession, getUserByEmail, getUserForSession } from "./db";

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_BYTES = 64;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type PublicUser = { id: number; email: string; name: string | null; role: "user" | "admin"; createdAt: Date };

export function publicUser(user: { id: number; email: string; name: string | null; role: "user" | "admin"; createdAt: Date }): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt };
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, SCRYPT_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [scheme, n, r, p, salt, hash] = encoded.split("$");
  if (scheme !== "scrypt" || n !== String(SCRYPT_N) || r !== String(SCRYPT_R) || p !== String(SCRYPT_P) || !salt || !hash || !/^[0-9a-f]{128}$/i.test(hash)) return false;
  const derivedKey = await scrypt(password, salt, SCRYPT_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(derivedKey, Buffer.from(hash, "hex"));
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function startUserSession(userId: number) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await createUserSession({ userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt };
}

export async function registerWithPassword(input: { email: string; password: string; name?: string }) {
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const user = await createAccount({ email, passwordHash, name: input.name });
  if (!user) return undefined;
  const session = await startUserSession(user.id);
  return { user, session };
}

export async function authenticateWithPassword(emailInput: string, password: string) {
  const user = await getUserByEmail(normalizeEmail(emailInput));
  if (!user || !(await verifyPassword(password, user.passwordHash))) return undefined;
  const session = await startUserSession(user.id);
  return { user, session };
}

export async function getSessionUser(token: string | undefined) {
  if (!token || token.length > 200) return undefined;
  return getUserForSession(hashSessionToken(token));
}

export async function endSession(token: string | undefined) {
  if (token && token.length <= 200) await deleteUserSession(hashSessionToken(token));
}

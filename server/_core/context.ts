import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { parse } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { getSessionUser, publicUser } from "../auth";
import type { PublicUser } from "../auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: PublicUser | null;
  sessionToken: string | undefined;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  const sessionToken = parse(opts.req.headers.cookie ?? "")[COOKIE_NAME];
  const account = await getSessionUser(sessionToken).catch((error) => {
    console.error("[Auth] Session lookup failed:", error instanceof Error ? error.message : "unknown error");
    return undefined;
  });

  return {
    req: opts.req,
    res: opts.res,
    user: account ? publicUser(account) : null,
    sessionToken,
  };
}

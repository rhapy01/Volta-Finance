import type { CookieOptions, Request } from "express";

export function getSessionCookieOptions(_req: Request): CookieOptions {
  const production = process.env.NODE_ENV === "production" || process.argv.includes("--production");
  return { httpOnly: true, path: "/", sameSite: "lax", secure: production };
}

// The build script creates this bundled server entry before Vercel packages the function.
// @ts-expect-error generated build artifact
import app from "../dist/api-handler.mjs";

export const config = { maxDuration: 60 };

export default function handler(req: any, res: any) {
  const route = typeof req.query.__path === "string" ? req.query.__path : "";
  const query = new URL(req.url || "/", "https://voltrafinance.vercel.app").searchParams;
  query.delete("__path");
  req.url = `/api/${route}${query.size ? `?${query.toString()}` : ""}`;
  return app(req, res);
}

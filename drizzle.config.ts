import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const directConnectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

export default defineConfig({
  schema: "./drizzle/schema.ts",
  // PostgreSQL migration history for Neon.
  out: "./drizzle/postgres",
  dialect: "postgresql",
  ...(directConnectionString ? { dbCredentials: { url: directConnectionString } } : {}),
});

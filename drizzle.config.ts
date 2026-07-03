// drizzle-kit configuration
// Usage: pnpm drizzle-kit generate → generates migrations/
//        pnpm drizzle-kit push     → apply to SQLite

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/api-services/src/db/drizzle-schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SQLITE_DB_PATH || "./data/onzo.db",
  },
});

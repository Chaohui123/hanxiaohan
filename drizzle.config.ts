import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/api-services/src/db/drizzle-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://onzo:onzo@localhost:5432/onzo_prod",
  },
});

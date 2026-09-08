import { defineConfig } from "drizzle-kit";

// Generate only: migrations are applied with `wrangler d1 migrations apply`
// (npm run db:migrate:local / db:migrate:remote), which owns the D1 credentials.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});

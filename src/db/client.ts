import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

// The ONLY place the app touches the database driver.
export function createDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

export type DB = ReturnType<typeof createDb>;

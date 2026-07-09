import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

// The ONLY place the app touches the database driver.
// To migrate off Neon: replace these two imports with `drizzle-orm/node-postgres`
// + `pg` Pool (Node), or `drizzle-orm/postgres-js` + `postgres`. Schema/queries unchanged.
export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export type DB = ReturnType<typeof createDb>;

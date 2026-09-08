import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { createDb } from "../../src/db/client.ts";

const MIGRATIONS_DIR = new URL("../../drizzle/", import.meta.url);

export async function freshDb() {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { DB: ":memory:" },
    r2Buckets: { KNOWLEDGE: "knowledge" },
  });
  const binding = (await miniflare.getD1Database("DB")) as unknown as D1Database;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim().replace(/;$/, "");
      if (trimmed) await binding.prepare(trimmed).run();
    }
  }
  return { db: createDb(binding), binding, miniflare, bucket: () => miniflare.getR2Bucket("KNOWLEDGE") };
}

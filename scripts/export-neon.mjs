// One-off Neon -> JSON dump, used once to seed D1. Reads DATABASE_URL from .env.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "scripts/export");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync(resolve(root, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not found in environment or .env");
}

const sql = neon(loadDatabaseUrl());

const tables = (
  await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `
)
  .map((row) => row.table_name)
  .filter((name) => !name.startsWith("__drizzle"));

mkdirSync(outDir, { recursive: true });
const counts = {};
for (const table of tables) {
  const rows = await sql(`select * from "${table}"`);
  counts[table] = rows.length;
  writeFileSync(resolve(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
}
writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify({ exportedAt: new Date().toISOString(), counts }, null, 2));
console.log(JSON.stringify(counts, null, 2));

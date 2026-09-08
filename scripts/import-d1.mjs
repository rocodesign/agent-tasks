// One-off loader: pushes the Neon dump in scripts/export/ into D1.
// Usage: node scripts/import-d1.mjs [--local]   (default: --remote)
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exportDir = resolve(root, "scripts/export");
const sqlDir = resolve(exportDir, "sql");
const target = process.argv.includes("--local") ? "--local" : "--remote";
const ROWS_PER_FILE = 200;

// Parents before children: D1 enforces foreign keys.
const TABLES = ["accounts", "machines", "sessions", "tasks", "dismissals", "api_keys", "verification"];

// Postgres timestamptz columns become epoch-millisecond integers in SQLite.
const TIMESTAMP_COLUMNS = new Set([
  "created_at",
  "updated_at",
  "last_used_at",
  "expires_at",
  "first_seen",
  "last_seen",
  "summarized_at",
  "summarized_through",
  "started_at",
  "last_activity_at",
  "acknowledged_at",
]);

function literal(column, value) {
  if (value === null || value === undefined) return "NULL";
  if (TIMESTAMP_COLUMNS.has(column)) {
    const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isNaN(ms) ? "NULL" : String(ms);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

rmSync(sqlDir, { recursive: true, force: true });
mkdirSync(sqlDir, { recursive: true });

const files = [];
let fileIndex = 0;
for (const table of TABLES) {
  const path = resolve(exportDir, `${table}.json`);
  if (!existsSync(path)) continue;
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!rows.length) continue;
  const columns = Object.keys(rows[0]);
  const columnList = columns.map((c) => `"${c}"`).join(", ");
  for (let start = 0; start < rows.length; start += ROWS_PER_FILE) {
    const chunk = rows.slice(start, start + ROWS_PER_FILE);
    const statements = chunk.map(
      (row) => `INSERT OR REPLACE INTO "${table}" (${columnList}) VALUES (${columns.map((c) => literal(c, row[c])).join(", ")});`,
    );
    const file = resolve(sqlDir, `${String(fileIndex++).padStart(3, "0")}_${table}.sql`);
    writeFileSync(file, `${statements.join("\n")}\n`);
    files.push({ file, table, rows: chunk.length });
  }
}

if (!files.length) {
  console.log("nothing to import");
  process.exit(0);
}

for (const { file, table, rows } of files) {
  console.log(`importing ${rows} row(s) into ${table} from ${file}`);
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "agent-tasks", target, "--yes", "--file", file],
    { stdio: "inherit", cwd: root },
  );
  if (result.status !== 0) {
    console.error(`import failed on ${file}`);
    process.exit(result.status ?? 1);
  }
}
console.log(`imported ${files.reduce((sum, f) => sum + f.rows, 0)} row(s)`);

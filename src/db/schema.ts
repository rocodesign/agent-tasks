import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";

// Plain SQLite DDL for Cloudflare D1. Multi-tenant: every row is owned by an
// account (email). Machine/session ids are surrogate `${email}::${rawId}` so two
// accounts can use the same hostname/session id without colliding.
// Timestamps are epoch milliseconds; `computeVersion` compares them directly.

const now = () => new Date();

export const accounts = sqliteTable("accounts", {
  email: text("email").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    email: text("email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(), // sha-256 hex; plaintext shown once
    prefix: text("prefix").notNull(), // e.g. "at_AbCdEf" for display
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => ({ emailIdx: index("api_keys_email_idx").on(t.email) }),
);

// Email OTP codes. One active code per identifier; value is "code:attempts".
export const verification = sqliteTable("verification", {
  identifier: text("identifier").primaryKey(), // email address
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export const machines = sqliteTable(
  "machines",
  {
    id: text("id").primaryKey(), // `${email}::${rawId}`
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    os: text("os"),
    label: text("label"),
    firstSeen: integer("first_seen", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => ({
    accountIdx: index("machines_account_idx").on(t.accountEmail),
    updatedIdx: index("machines_updated_idx").on(t.updatedAt),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // `${email}::${rawSessionId}`
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    machineId: text("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    project: text("project"),
    title: text("title"),
    provider: text("provider"),
    summary: text("summary"), // AI-generated post-session digest; null until enriched
    summarizedAt: integer("summarized_at", { mode: "timestamp_ms" }),
    status: text("status").notNull().default("active"), // active | idle | ended
    endedReason: text("ended_reason"), // null while live; hook | reaper once ended
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => ({
    accountIdx: index("sessions_account_idx").on(t.accountEmail),
    machineIdx: index("sessions_machine_idx").on(t.machineId),
    updatedIdx: index("sessions_updated_idx").on(t.updatedAt),
  }),
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(), // `${sessionId}::${position}`
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"), // pending | in_progress | completed | cancelled | deferred
    source: text("source").notNull().default("live"), // live (TodoWrite mirror) | generated (post-session extraction)
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
  },
  (t) => ({
    accountIdx: index("tasks_account_idx").on(t.accountEmail),
    sessionIdx: index("tasks_session_idx").on(t.sessionId),
    updatedIdx: index("tasks_updated_idx").on(t.updatedAt),
  }),
);

// User dismissals; survive the agent's full-snapshot re-ingests.
export const dismissals = sqliteTable(
  "dismissals",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskName: text("task_name").notNull(),
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.taskName] }) }),
);

export type Account = typeof accounts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Dismissal = typeof dismissals.$inferSelect;

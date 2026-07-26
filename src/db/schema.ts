import { pgTable, text, integer, timestamp, index, primaryKey } from "drizzle-orm/pg-core";

// Plain Postgres DDL — no vendor extensions. Multi-tenant: every row is owned by an
// account (email). Machine/session ids are surrogate `${email}::${rawId}` so two
// accounts can use the same hostname/session id without colliding.

export const accounts = pgTable("accounts", {
  email: text("email").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    email: text("email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(), // sha-256 hex; plaintext shown once
    prefix: text("prefix").notNull(), // e.g. "at_AbCdEf" for display
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({ emailIdx: index("api_keys_email_idx").on(t.email) }),
);

// Email OTP codes. One active code per identifier; value is "code:attempts".
export const verification = pgTable("verification", {
  identifier: text("identifier").primaryKey(), // email address
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const machines = pgTable(
  "machines",
  {
    id: text("id").primaryKey(), // `${email}::${rawId}`
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    os: text("os"),
    label: text("label"),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index("machines_account_idx").on(t.accountEmail),
    updatedIdx: index("machines_updated_idx").on(t.updatedAt),
  }),
);

export const sessions = pgTable(
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
    status: text("status").notNull().default("active"), // active | idle | ended
    endedReason: text("ended_reason"), // null while live; hook | reaper once ended
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index("sessions_account_idx").on(t.accountEmail),
    machineIdx: index("sessions_machine_idx").on(t.machineId),
    updatedIdx: index("sessions_updated_idx").on(t.updatedAt),
  }),
);

export const tasks = pgTable(
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
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index("tasks_account_idx").on(t.accountEmail),
    sessionIdx: index("tasks_session_idx").on(t.sessionId),
    updatedIdx: index("tasks_updated_idx").on(t.updatedAt),
  }),
);

// User dismissals; survive the agent's full-snapshot re-ingests.
export const dismissals = pgTable(
  "dismissals",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    taskName: text("task_name").notNull(),
    accountEmail: text("account_email")
      .notNull()
      .references(() => accounts.email, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.taskName] }) }),
);

export type Account = typeof accounts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Dismissal = typeof dismissals.$inferSelect;

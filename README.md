# agent-tasks

Agents report the tasks they're working on to a shared remote Postgres; a polling
dashboard shows the hierarchy **Machine (source) → Session → Tasks**.

- **API + host:** Cloudflare Workers + [Hono]
- **Storage:** standard Postgres via Drizzle (Neon as the provider) — portable, no vendor extensions
- **UI:** Vite + React + Tailwind static build, served by the Worker; polls for updates
- **Auth:** email OTP login → a per-account API key (`Authorization: Bearer <key>`). Allowlist-gated. Data is **multi-tenant**: each account sees only its own machines/sessions/tasks.
- **Agent integration:** the `skill/agent-tasks-report` skill, the local `mcp/` stdio server, or the **hosted MCP** at `/mcp` (all tell the model to mirror its internal TodoWrite widget)

## Layout

```
src/
  index.ts          Hono app: routes (auth, ingest, read, /mcp), serves the SPA
  store.ts          account-scoped DB logic (ingest/tree/version/dismiss)
  auth.ts           email OTP, Resend send, API-key mint/hash, allowlist
  mcp.ts            hosted MCP over Streamable HTTP (JSON-RPC), reuses store.ts
  db/
    schema.ts       accounts / api_keys / verification / machines / sessions / tasks / dismissals
    client.ts       the ONLY driver touch point (swap to migrate vendors)
  instructions.ts   plain-text agent guide (GET /instructions)
ui/                 Vite + React + Tailwind dashboard -> builds to ui/dist
skill/agent-tasks-report/   installable Claude Code skill for agents
mcp/                MCP server: report_tasks / end_session / view_fleet (see mcp/README.md)
drizzle.config.ts   migrations (reads DATABASE_URL from .env)
```

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/request-otp` | no | Email a 6-digit code (allowlisted emails only) |
| POST | `/api/auth/verify-otp` | no | Verify code → mint + return a per-account API key |
| POST | `/api/ingest` | yes | Upsert machine+session, replace that session's tasks (full snapshot); returns `dismissed` |
| POST | `/api/dismiss` | yes | User defers a task from the UI (persists across re-ingests) |
| GET | `/api/dismissals` | yes | Un-acknowledged deferrals for a session |
| GET | `/api/version` | yes | `max(updated_at)` — cheap "did anything change?" for the poller |
| GET | `/api/tree` | yes | Full Machine → Session → Tasks hierarchy |
| POST | `/mcp` | yes | Hosted MCP (Streamable HTTP, JSON-RPC): `report_tasks` / `end_session` / `view_fleet` |
| GET | `/instructions` | no | Plain-text guide for agents |
| GET | `/health` | no | Health check |
| GET | `*` | no | Static SPA |

**Auth model:** sign in at `/` with your email → a 6-digit OTP (sent via Resend) →
the app mints an API key tied to your email and stores it in the browser. Click
**agent key** in the top bar to copy it into the MCP server / skill config. Agents and
the UI both authenticate with that key; all data is scoped to the account.

## Setup

```sh
# 1. install deps (worker + ui)
npm install
npm run ui:install

# 2. create the tables in Neon (reads .env DATABASE_URL)
npm run db:generate     # generate SQL migration from schema
npm run db:migrate      # apply it
#   or, for quick dev: npm run db:push

# 3. run locally (two terminals)
npm run dev             # wrangler dev  -> http://localhost:8787  (API)
npm run ui:dev          # vite          -> http://localhost:5173  (UI, proxies /api)
```

Local env lives in `.env` (drizzle migrations: `DATABASE_URL`) and `.dev.vars` (worker
runtime: `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `ALLOWED_EMAILS`). Both are
gitignored. To sign in locally, add your email to `ALLOWED_EMAILS`, then use the OTP
flow at the UI (the code is emailed via Resend).

## Deploy

```sh
# set production secrets once
npx wrangler secret put DATABASE_URL
npx wrangler secret put RESEND_API_KEY
# RESEND_FROM and ALLOWED_EMAILS are non-secret [vars] in wrangler.toml

# build UI + deploy worker
npm run deploy
```

Serves at `fleet.copaciu.com` (and the `*.workers.dev` URL).

## Portability

All database access flows through `src/db/client.ts` + `src/db/schema.ts` using plain
Postgres. To move off Neon/Cloudflare: change the connection string (any Postgres) and,
if leaving Workers, swap the driver in `client.ts` (`neon-http` → `node-postgres` /
`postgres-js`) and add a Node entry point. Hono runs unchanged on Node/Deno/Bun/Lambda.

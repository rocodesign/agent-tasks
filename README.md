# agent-tasks

Agents report the tasks they're working on to a Cloudflare Durable Object; a
polling dashboard shows the hierarchy **Machine (source) → Session → Tasks**.

- **API + host:** Cloudflare Workers + [Hono]
- **Live storage:** one SQLite-backed Durable Object; polling and task traffic do not wake Postgres
- **Archive:** standard Postgres via Drizzle (Neon), flushed hourly and immediately after `SessionEnd`
- **UI:** Vite + React + Tailwind static build, served by the Worker; polls for updates
- **Auth:** email OTP login → a per-account API key (`Authorization: Bearer <key>`). Allowlist-gated. Data is **multi-tenant**: each account sees only its own machines/sessions/tasks.
- **Agent integration:** the separate `rococode` plugin reports Claude Code and
  Codex lifecycle/task events to this API through silent deterministic hooks.

## Layout

```
src/
  index.ts          Hono adapter: forwards /api to the Durable Object; serves the SPA
  live-state.ts     deep live-state module: auth, tasks, reads, and archive queue
  store.ts          Postgres archive adapter
  auth.ts           email OTP, Resend send, API-key mint/hash, allowlist
  db/
    schema.ts       accounts / api_keys / verification / machines / sessions / tasks / dismissals
    client.ts       the ONLY driver touch point (swap to migrate vendors)
ui/                 Vite + React + Tailwind dashboard -> builds to ui/dist
drizzle.config.ts   migrations (reads DATABASE_URL from .env)
```

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/request-otp` | no | Email a 6-digit code (allowlisted emails only) |
| POST | `/api/auth/verify-otp` | no | Verify code → mint + return a per-account API key |
| POST | `/api/ingest` | yes | Upsert machine+session, replace that session's tasks (full snapshot); returns `dismissed` |
| POST | `/api/session/start` | yes | Register or resume a hook session |
| POST | `/api/session/end` | yes | End a hook session |
| POST | `/api/session/remove` | yes | Permanently remove a session |
| POST | `/api/dismiss` | yes | User defers a task from the UI (persists across re-ingests) |
| GET | `/api/dismissals` | yes | Un-acknowledged deferrals for a session |
| GET | `/api/version` | yes | Durable Object version counter for the poller |
| GET | `/api/tree` | yes | Full Machine → Session → Tasks hierarchy |
| GET | `/health` | no | Health check |
| GET | `*` | no | Static SPA |

**Auth model:** sign in at `/` with your email → a 6-digit OTP (sent via Resend) →
the app mints an API key tied to your email and stores it in the browser. Click
**agent key** in the top bar to copy it into `AGENT_TASKS_KEY`. Hooks and
the UI both authenticate with that key; all data is scoped to the account.

## Agent hook contract

The cross-agent reporter is distributed by the `rococode` plugin rather than this
service repository. Expose the API key to Claude Code and Codex:

```sh
export AGENT_TASKS_KEY="<agent key copied from the dashboard>"
export AGENT_TASKS_URL="https://fleet.copaciu.com" # optional; this is the default
```

The reporter calls `/api/session/start`, `/api/ingest`, and `/api/session/end`.
It registers no MCP server, model-facing tool, skill, or instructions, so reporting
consumes zero model tokens.

Optional environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_TASKS_MACHINE` | OS hostname | Stable machine id |
| `AGENT_TASKS_LABEL` | none | Human-friendly machine label |
| `AGENT_TASKS_HOOK_TIMEOUT_MS` | `3000` | REST request timeout |
| `AGENT_TASKS_STATE_DIR` | OS temp directory | Override reporter snapshot storage |

## Setup

```sh
# 1. install deps (worker + ui)
npm install
npm run ui:install

# 2. create the archive tables in Neon (reads .env DATABASE_URL)
npm run db:generate     # generate SQL migration from schema
npm run db:migrate      # apply it
#   or, for quick dev: npm run db:push

# 3. run locally (two terminals)
npm run dev             # wrangler dev  -> http://localhost:8787  (API)
npm run ui:dev          # vite          -> http://localhost:5173  (UI, proxies /api)
```

Local env lives in `.env` (drizzle migrations: `DATABASE_URL`) and `.dev.vars`
(worker runtime: `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`,
`ALLOWED_EMAILS`, `BOOTSTRAP_API_KEY`). Both are gitignored. `BOOTSTRAP_API_KEY`
imports an existing agent key into a fresh Durable Object without querying Neon.

## Deploy

```sh
# set production secrets once
npx wrangler secret put DATABASE_URL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BOOTSTRAP_API_KEY
# RESEND_FROM and ALLOWED_EMAILS are non-secret [vars] in wrangler.toml

# build UI + deploy worker
npm run deploy
```

Serves at `fleet.copaciu.com` (and the `*.workers.dev` URL).

## Live/archive behavior

Every accepted mutation is persisted to Durable Object storage before the API
responds. Repeated `/api/ingest` snapshots for the same session coalesce in the
archive queue. The first dirty mutation schedules an archive alarm for one hour
later; `SessionEnd` advances that alarm to run immediately. Failed Neon flushes
remain queued and retry in one hour, while the live API stays available.

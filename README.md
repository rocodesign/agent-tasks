# agent-tasks

Agents report the tasks they're working on to a Cloudflare Durable Object; a
polling dashboard shows the hierarchy **Machine (source) → Session → Tasks**.

- **API + host:** Cloudflare Workers + [Hono]
- **Live storage:** one SQLite-backed Durable Object; polling and task traffic never reach the archive
- **Archive:** Cloudflare D1 via Drizzle, flushed hourly and immediately after `SessionEnd`
- **Knowledge:** each enriched session is written to R2 (`majordomo-knowledge`) as `sessions/<slug>/<sessionId>.md` for AI Search
- **UI:** Vite + React + Tailwind static build, served by the Worker; polls for updates
- **Auth:** email OTP login → a per-account API key (`Authorization: Bearer <key>`), or a JWT from the Sidus shell. Allowlist-gated. Data is **multi-tenant**: each account sees only its own machines/sessions/tasks.
- **Agent integration:** the separate `rococode` plugin reports Claude Code and
  Codex lifecycle/task events to this API through silent deterministic hooks.

## Layout

```
src/
  index.ts          Hono adapter: forwards /api to the Durable Object; serves the SPA
  live-state.ts     deep live-state module: auth, tasks, reads, and archive queue
  store.ts          D1 archive adapter
  knowledge.ts      R2 session documents for AI Search
  auth.ts           email OTP, Resend send, API-key mint/hash, allowlist
  shell-jwt.ts      shell JWT verification against the shell JWKS
  db/
    schema.ts       accounts / api_keys / verification / machines / sessions / tasks / dismissals
    client.ts       the ONLY driver touch point (swap to migrate vendors)
ui/                 Vite + React + Tailwind dashboard -> builds to ui/dist
drizzle/            SQLite migrations, applied with `wrangler d1 migrations apply`
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
| POST | `/api/task/complete` | yes | Mark a task done by name (`sessionId`, `taskName`) |
| GET | `/api/dismissals` | yes | Un-acknowledged deferrals for a session |
| GET | `/api/version` | yes | Durable Object version counter for the poller |
| GET | `/api/tree` | yes | Full Machine → Session → Tasks hierarchy; `?project=` `?kind=` `?delegation=` `?machine=` |
| GET | `/api/history/sessions` | yes | Summarized sessions from D1; same filters plus `?since=` `?all=1` `?limit=` |
| GET | `/health` | no | Health check |
| GET | `*` | no | Static SPA |

**Auth model:** sign in at `/` with your email → a 6-digit OTP (sent via Resend) →
the app mints an API key tied to your email and stores it in the browser. Click
**agent key** in the top bar to copy it into `AGENT_TASKS_KEY`. Hooks and
the UI both authenticate with that key; all data is scoped to the account.

## Shell JWT

Every endpoint that takes an API key also takes a JSON Web Token (JWT) minted by
the Sidus shell. The shell holds the browser session and forwards each request
with a short-lived token, so the browser never holds a Fleet API key. Agent hooks
keep using API keys.

- Header: `Authorization: Bearer <jwt>`.
- Signature: asymmetric (EdDSA or ES256), verified against the shell JWKS.
- JWKS URL: `${SHELL_URL}/api/auth/jwks`. Issuer: `SHELL_URL`.
- Required claims: `sub` (shell user id), `email`, `iss`, `exp`, `iat`. An
  audience claim is accepted but not required.

Fleet reads the `email` claim, checks it against `ALLOWED_EMAILS`, and creates the
account on first use. The request then runs with the same account scoping an API
key for that email would give.

A bearer token is treated as a JWT when it has three dot-separated base64url
segments. Anything else takes the API-key path unchanged.

| Variable | Where | Purpose |
|----------|-------|---------|
| `SHELL_URL` | `[vars]` in `wrangler.toml` | Shell origin: the JWKS host and the expected issuer. Production: `https://sidus.copaciu.com`. Unset disables JWT auth. |

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

# 2. create the archive tables in the local D1
npm run db:generate       # generate SQL migration from schema
npm run db:migrate:local  # apply it to .wrangler local state

# 3. run locally (two terminals)
npm run dev             # wrangler dev  -> http://localhost:8787  (API)
npm run ui:dev          # vite          -> http://localhost:5173  (UI, proxies /api)
```

Local env lives in `.dev.vars` (worker runtime: `RESEND_API_KEY`, `RESEND_FROM`,
`ALLOWED_EMAILS`, `BOOTSTRAP_API_KEY`, `SHELL_URL`); it is gitignored. `.env`
holds `DATABASE_URL` for the one-off Neon export script only.
`BOOTSTRAP_API_KEY` imports an existing agent key into a fresh Durable Object
without querying the archive. Set `SHELL_URL` in `.dev.vars` to point at a shell running
locally; the `wrangler.toml` value points at production.

## Deploy

```sh
# set production secrets once
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BOOTSTRAP_API_KEY
# RESEND_FROM, ALLOWED_EMAILS and SHELL_URL are non-secret [vars] in wrangler.toml

# build UI, apply remote D1 migrations, deploy worker
npm run deploy
```

Serves at `fleet.copaciu.com` (and the `*.workers.dev` URL).

### Grant the orchestrator role

`POST /api/launch` and `launch.cancelled` need a key whose `api_keys.role` is
`orchestrator`. Every existing key has a null role and cannot assign work, so grant it
once, to Majordomo's key only:

```sh
npx wrangler d1 execute agent-tasks --remote \
  --command "UPDATE api_keys SET role = 'orchestrator' WHERE prefix = '<the key prefix>'"
```

Check it with `SELECT prefix, role FROM api_keys` before assigning any work. Any other key
holder can still read and post, but cannot start work on a machine.

## One-off Neon import

The archive used to live in Neon Postgres. `scripts/export-neon.mjs` dumps every
table to `scripts/export/*.json` (reads `DATABASE_URL` from `.env`);
`scripts/import-d1.mjs` turns that dump into batched SQL and applies it, `--local`
for a rehearsal and remote by default:

```sh
node scripts/export-neon.mjs
npm run db:migrate:remote
node scripts/import-d1.mjs
```

## Live/archive behavior

Every accepted mutation is persisted to Durable Object storage before the API
responds. Repeated `/api/ingest` snapshots for the same session coalesce in the
archive queue. The first dirty mutation schedules an archive alarm for one hour
later; `SessionEnd` advances that alarm to run immediately. Failed D1 flushes
remain queued and retry in one hour, while the live API stays available.

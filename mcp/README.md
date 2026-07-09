# agent-tasks MCP server

An MCP server that lets an agent mirror its task list to the shared **agent-tasks**
dashboard. Machine identity and session id are filled in automatically — the agent
only supplies the task list.

Get your API key by signing into the dashboard with your email (OTP) and clicking
**agent key** to copy it. This is the **local stdio** server; a **hosted** MCP also
runs on the Worker at `/mcp` (see below).

The server's `instructions` (surfaced to the model on connect) tell it to keep its
**internal TodoWrite task-list widget** and the **remote dashboard** in sync: same
names, same statuses, one `in_progress` at a time, full snapshot on every change.

## Tools

| Tool | Purpose |
|------|---------|
| `report_tasks` | Send the full current task list (snapshot). Call after every task-list change. |
| `end_session` | Mark the session ended (reuses the last reported list). |
| `view_fleet` | Read all machines/sessions/tasks (see what other agents are doing). |

## Setup

```sh
cd mcp
npm install
npm run build      # -> dist/index.js   (or use `npm run dev` / tsx for no-build)
```

## Register with Claude Code

Add to your `.mcp.json` (project) or user MCP config:

```json
{
  "mcpServers": {
    "agent-tasks": {
      "command": "node",
      "args": ["D:/Work/ai-tools/agent-tasks/mcp/dist/index.js"],
      "env": {
        "AGENT_TASKS_URL": "https://fleet.copaciu.com",
        "AGENT_TASKS_KEY": "<your api key>",
        "AGENT_TASKS_PROJECT": "${workspaceFolder}"
      }
    }
  }
}
```

No-build alternative (runs the TS directly):

```json
{
  "mcpServers": {
    "agent-tasks": {
      "command": "npx",
      "args": ["tsx", "D:/Work/ai-tools/agent-tasks/mcp/src/index.ts"],
      "env": { "AGENT_TASKS_KEY": "<your api key>" }
    }
  }
}
```

## Hosted (remote) MCP — no local process

The Worker also serves the same tools over Streamable HTTP at `/mcp`. Because it runs
on the server (not your machine), `report_tasks` requires you to pass `machine` and
`session` in the call (the local server fills those in for you).

```sh
claude mcp add --transport http agent-tasks https://fleet.copaciu.com/mcp \
  --header "Authorization: Bearer <your api key>"
```

## Env

| Var | Default | Notes |
|-----|---------|-------|
| `AGENT_TASKS_URL` | `https://fleet.copaciu.com` | Base URL of the deployed Worker. |
| `AGENT_TASKS_KEY` | — | **Required.** Shared API key (Bearer). |
| `AGENT_TASKS_SESSION_ID` | `CLAUDE_SESSION_ID` or random | Stable id for this session. |
| `AGENT_TASKS_PROJECT` | `process.cwd()` | Project/cwd label shown on the card. |
| `AGENT_TASKS_LABEL` | — | Optional machine label. |

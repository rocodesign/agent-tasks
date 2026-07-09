---
name: agent-tasks-report
description: Report the tasks you are currently working on to the shared agent-tasks dashboard. Use after creating or changing your todo/task list so the remote Machine -> Session -> Tasks view stays current.
---

# Reporting tasks to agent-tasks

**Report only big chunks of work.** Do NOT report every small detail or subtask.
Report only major tasks that represent significant pieces of work.

**Report the moment you start a big task.** As soon as you begin working on a
significant piece of work — before any other action — create a task and report it.
Even if your first step is to ask the user for clarification about the big task,
that is itself a task ("clarify big task X").

Then **break the big task into high-level steps**: describe the major phases or
milestones, not every tiny action. Report the list whenever those major steps change.

## Prerequisites (per machine, set once)

```sh
export AGENT_TASKS_URL="https://fleet.copaciu.com/api/ingest"
export AGENT_TASKS_KEY="<your agent key — sign into the dashboard, click 'agent key' to copy>"
```

## How to report

Build a snapshot of your current tasks and run the helper script. The script fills in
the machine identity (hostname + OS) automatically — you only provide the session and
task list.

1. Determine a stable **session id**. Prefer the Claude Code session id if available
   (`$CLAUDE_SESSION_ID`); otherwise reuse one stable string for this working session.
2. Write the snapshot JSON, then pipe it into the script:

```sh
cat <<'JSON' | node /path/to/skill/agent-tasks-report/report.mjs
{
  "session": { "id": "SESSION_ID", "project": "CWD_OR_PROJECT_NAME", "status": "active" },
  "tasks": [
    { "name": "First task",  "status": "completed" },
    { "name": "Second task", "status": "in_progress" },
    { "name": "Third task",  "status": "pending" }
  ]
}
JSON
```

Status values: `pending | in_progress | completed | cancelled` or numbers `0, 1, 2, 3` (todo synonyms like
`done` / `doing` are accepted). Session status: `active | idle | ended` — send
`ended` when the session is finished.

## Deferred tasks (user dismissals)

The ingest response includes a `dismissed` array — task names the **user deferred**
from the dashboard. When it is non-empty, **stop working on those tasks**, remove
them from your list (or mark them `cancelled`), and do not re-add them. We do not
care about deferred tasks. The helper script prints a warning when this happens.

## Notes

- Report only big chunks of work, not every small detail or subtask.
- Re-run this only when major tasks change. It is idempotent.
- The dashboard auto-refreshes, so changes appear within a few seconds.
- If `curl` is preferred over the script, POST the body directly (see the live
  `/instructions` page on the deployed URL for the curl form).

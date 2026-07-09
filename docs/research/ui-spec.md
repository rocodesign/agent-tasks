# Fleet — UI Specification

> A live dashboard showing what every AI coding agent across all your machines is
> currently working on. Read-only, glanceable, auto-refreshing. Hierarchy:
> **Machine (source) → Session → Tasks**.
>
> This document is the design contract for the dashboard. It is detailed enough to
> hand directly to a design tool (e.g. Claude design / the `frontend-design` skill)
> or to a developer. The current `ui/src/App.tsx` implements a baseline of this spec.

---

## 1. Purpose & principles

- **One glance, whole fleet.** A user should see, in seconds, which machines have
  active agents, what each session is doing, and which single task each agent is on
  *right now*.
- **Read-only observability.** No editing of tasks from the UI (v1). Data flows
  one way: agents → storage → dashboard.
- **Calm, dense, fast.** Developer-tool aesthetic. Lots of information, low visual
  noise. Nothing animates unless it conveys state.
- **Never lies about freshness.** A visible live indicator + "updated Ns ago" so the
  user always knows how current the view is. Errors surface, they don't hide.

---

## 2. Information architecture

Three nested levels, always in this order:

```
Machine  (the source / host)
  └─ Session  (one agent run on that machine, usually one project/cwd)
       └─ Task  (a single named item, with a status)
```

- A **Machine** is identified by hostname; it has an online/idle/offline state
  derived from `lastSeen`.
- A **Session** belongs to one machine; it has a project/cwd, a status
  (`active | idle | ended`), and an ordered list of tasks.
- A **Task** has a name, a status (`pending | in_progress | completed | cancelled`),
  and a position (display order). The **in-progress** task is the focal point of the
  whole UI — it's "what the agent is doing now."

---

## 3. Layout

Three regions: a top bar, a left sidebar, and the main content area.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Fleet   4 machines · 9 active sessions · 23 in progress      ● live 3s ago  [key] │  ← top bar
├───────────────┬───────────────────────────────────────────────────────────┤
│ [ Search…  ]  │   ┌── session card ──┐  ┌── session card ──┐  ┌──────────┐  │
│               │   │ ~/work/ai-tools  │  │ ~/api/server     │  │ ...      │  │
│ ▸ All machines│   │ mac-studio  3/7  │  │ win-desktop 1/4  │  │          │  │
│ ● mac-studio 2│   │ ─────────────────│  │ ─────────────────│  │          │  │
│ ● win-desktop1│   │ ✓ Design schema  │  │ ◉ Parse request  │  │          │  │
│ ○ eu-server  0│   │ ◉ Build ingest   │  │ ◷ Validate body  │  │          │  │
│               │   │ ◷ Wire the UI    │  │ ◷ Write tests    │  │          │  │
│               │   │ updated 12s ago  │  │ updated 4s ago   │  │          │  │
│               │   └──────────────────┘  └──────────────────┘  └──────────┘  │
└───────────────┴───────────────────────────────────────────────────────────┘
   sidebar (≈256px)                main area (responsive card grid)
```

### 3.1 Top bar
- **Left:** product wordmark **"Fleet"** (semibold), followed by a muted summary line:
  `N machines · N active sessions · N in progress`.
- **Right:** a **live indicator** — a pulsing green dot + `live · {n}s ago` when polling
  is healthy; replaced by a red error message when a poll fails or auth is rejected.
  A small **`key`** button lets the user clear/re-enter the API key.

### 3.2 Left sidebar (Machines)
- A **search field** at the top (filters across machines, projects, and task names).
- An **"All machines"** item (default selected) followed by one row per machine.
- Each machine row: **status dot** + **hostname** (monospace, truncates) + a count
  badge of active sessions, right-aligned.
- Selecting a machine filters the main area to that machine; "All machines" clears it.
- Empty: `No machines yet.`

### 3.3 Main area (Sessions)
- A **responsive grid of session cards**: 1 column on mobile, 2 on medium, 3 on
  wide screens.
- Cards are ordered by recency (most recently active first).
- When "All machines" is selected, each card also shows its machine hostname.
- Empty: a centered empty state (see §6).

---

## 4. Components

### 4.1 Session card
The primary unit. Contains:
- **Header:** project/cwd (monospace, truncates) on the left; on the right a
  `done/total` counter and a **session status pill**. When viewing all machines, the
  machine hostname appears under the project name (muted).
- **Body:** the **task checklist** — one row per task, in `position` order.
- **Footer:** `updated {time} ago` (right-aligned, muted), from `lastActivityAt`.

### 4.2 Task row
- A **status icon** + the **task name**.
- The **in-progress** task is emphasized: a thin accent (violet) left border and a
  faint accent background tint — this is the visual anchor of the card.
- Completed and cancelled task names are dimmed and struck through.

### 4.3 Status pill (session)
A small uppercase chip:
- `active` → emerald tint
- `idle` → amber tint
- `ended` → neutral/gray tint

### 4.4 Status dot (machine)
A 8px dot whose color is derived from `lastSeen`:
- **green** — seen < 2 min ago (online)
- **amber** — seen < 30 min ago (idle)
- **gray** — older (offline)

### 4.5 Key gate
A centered card shown when no API key is stored: wordmark, one line of copy, a
password input, and a "View dashboard" button. On submit the key is saved to
`localStorage` and the dashboard mounts. The key is **never** baked into the build.

---

## 5. Status semantics & color system

| Concept | Value | Icon / shape | Color |
|---|---|---|---|
| Task | `pending` | `◷` | neutral-600 |
| Task | `in_progress` | `◉` (pulse) | violet-400 (accent) |
| Task | `completed` | `✓` | emerald-400 |
| Task | `cancelled` | `✕` | neutral-600, struck |
| Task | `deferred` | `⊘` | amber-400/70, struck + `deferred` tag (user dismissed it) |
| Session | `active` | pill | emerald |
| Session | `idle` | pill | amber |
| Session | `ended` | pill | neutral |
| Machine | online / idle / offline | dot | emerald / amber / gray |

**Accent color (violet) is reserved** for two things only: the in-progress task and
the primary action (key gate button). Everything else is neutral/semantic. This keeps
the "what's happening now" signal unambiguous.

---

## 6. States

- **Key gate** — no API key stored yet (§4.5).
- **Loading** — first fetch in flight. (Baseline: shows empty grid; ideal: skeleton
  cards.)
- **Empty** — authenticated, but no data: centered `No agents reporting yet` with a
  hint pointing at `POST /api/ingest` and `/instructions`.
- **Populated** — the normal grid.
- **Error** — a poll failed: the live indicator is replaced by a red message
  (e.g. `Unauthorized — wrong API key`, or a network error). The last good data stays
  on screen; the poller keeps retrying.

---

## 7. Interactions & behavior

- **Polling.** Every 3s the client calls `GET /api/version`. If the returned version
  (max `updated_at` across tables) changed, it fetches `GET /api/tree` and re-renders;
  otherwise it does nothing. This keeps the dashboard near-real-time while making the
  steady-state cost a single tiny query per tick.
- **Auth.** Every API request sends `Authorization: Bearer <key>`. A `401` flips the
  UI into the error state with an "Unauthorized" message.
- **Dismiss / defer.** Each `pending` or `in_progress` task shows a `✕` on hover.
  Clicking it `POST`s `/api/dismiss`; the task flips to `deferred` immediately, and on
  the agent's next report the server tells it to drop the task (stop working on it,
  don't re-add it). Dismissals persist across the agent's snapshot re-ingests.
- **Selection.** Clicking a machine filters the grid; "All machines" clears it.
- **Search.** Filters machines/sessions whose hostname, project, title, or any task
  name matches the query (case-insensitive).
- **Freshness.** "updated Ns ago" in the top bar reflects the last successful poll;
  each card's footer reflects that session's own `lastActivityAt`.

---

## 8. Visual style

- **Theme:** dark by default (`bg-neutral-950`, text `neutral-200`). A light variant
  is a nice-to-have, not required for v1.
- **Typography:** sans for chrome/labels; **monospace** for machine, project, and
  task names (they're identifiers — mono makes them scannable and aligns them).
- **Surfaces:** subtle. Cards = `neutral-900/50` on `neutral-800` borders, rounded
  (`rounded-xl`). No heavy shadows. Generous but tight spacing.
- **Motion:** restrained. Only the live dot and the in-progress task icon pulse.
  New/changed cards may fade/slide in subtly; nothing bounces.
- **Reference points:** Linear, Vercel dashboard — calm, dense, fast, high contrast
  where it matters and quiet everywhere else.

---

## 9. Data the UI consumes

`GET /api/tree` returns:

```jsonc
{
  "machines": [
    {
      "id": "mac-studio",
      "hostname": "mac-studio",
      "os": "darwin",
      "label": null,
      "lastSeen": "2026-06-20T16:12:03.000Z",
      "sessions": [
        {
          "id": "sess_abc123",
          "machineId": "mac-studio",
          "project": "~/work/ai-tools/agent-tasks",
          "title": null,
          "status": "active",
          "lastActivityAt": "2026-06-20T16:12:03.000Z",
          "tasks": [
            { "id": "sess_abc123::0", "name": "Design D1 schema",      "status": "completed",   "position": 0 },
            { "id": "sess_abc123::1", "name": "Build ingest endpoint", "status": "in_progress", "position": 1 },
            { "id": "sess_abc123::2", "name": "Wire up hooks",         "status": "pending",     "position": 2 },
            { "id": "sess_abc123::3", "name": "Write UI",              "status": "pending",     "position": 3 }
          ]
        }
      ]
    }
  ]
}
```

`GET /api/version` returns `{ "version": <number> }` — the max `updated_at` epoch ms
across all tables. The client only refetches the tree when this changes.

---

## 10. Sample data to render (for design mockups)

- **`mac-studio`** (macOS, online) — 2 sessions:
  - `~/work/ai-tools/agent-tasks` (active): `Design D1 schema` ✓, `Build ingest endpoint` ◉, `Wire up hooks` ◷, `Write UI` ◷ → counter `1/4`.
  - `~/notes` (idle): all tasks ✓ → counter `3/3`.
- **`win-desktop`** (Windows, online) — 1 session:
  - `~/api/server` (active): `Parse request` ◉, `Validate body` ◷, `Write tests` ◷, `Open PR` ◷ → counter `0/4`.
- **`eu-server`** (Linux, offline) — 1 session:
  - `deploy-pipeline` (ended): all 5 tasks ✓ → pill `ended`, gray machine dot.

Top-bar summary for this data: `3 machines · 2 active sessions · 2 in progress`.

---

## 11. Responsive behavior

- **Wide (≥1280px):** 3-column card grid, sidebar visible.
- **Medium (≥768px):** 2-column grid, sidebar visible.
- **Mobile (<768px):** single column; sidebar collapses to a top dropdown/sheet for
  machine selection (nice-to-have — baseline keeps it stacked).

---

## 12. Out of scope for v1 / future ideas

- Light theme toggle.
- Per-task timing / duration and a session timeline.
- Clicking a task to see detail or history.
- More bidirectional controls (e.g. "pause this agent", reorder tasks). Dismiss/defer
  is the first write channel — the server reflects user deferrals back to the agent.
- Grouping/sorting controls (by machine, by recency, by # in progress).
- Notifications when a session finishes or stalls.
- Skeleton loading states and enter/exit animations for cards.

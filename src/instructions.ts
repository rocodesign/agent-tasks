export function instructions(baseUrl: string): string {
  return `agent-tasks: report tasks to ${baseUrl}
POST /api/ingest with {"machine":{...},"session":{...},"tasks":[{name,status}]}

REPORT ONLY BIG CHUNKS of work (not every small detail). Use NUMBERS: 0=pending, 1=in_progress, 2=completed, 3=cancelled

Response includes "dismissed" tasks to stop working on.`;
}

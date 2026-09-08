export type SessionFilters = {
  project: string | null;
  kind: string | null;
  delegation: string | null;
  machine: string | null;
};

// Automated sessions are noise in a history read: subagents fold into their parent and
// scheduled sweeps are never summarized. An explicit ?kind= still returns them.
export const HISTORY_HIDDEN_KINDS = ["subagent", "scheduled"];

export function readSessionFilters(url: URL): SessionFilters {
  return {
    project: value(url, "project"),
    kind: value(url, "kind"),
    delegation: value(url, "delegation"),
    machine: value(url, "machine"),
  };
}

export function matchesProject(
  session: { projectKey?: string | null; project?: string | null },
  project: string,
): boolean {
  if (session.projectKey) return session.projectKey === project;
  return session.project === project;
}

export function matchesSessionFilters(
  session: { projectKey?: string | null; project?: string | null; kind?: string | null; delegation?: string | null },
  filters: SessionFilters,
): boolean {
  if (filters.project && !matchesProject(session, filters.project)) return false;
  if (filters.kind && session.kind !== filters.kind) return false;
  if (filters.delegation && session.delegation !== filters.delegation) return false;
  return true;
}

export function matchesMachineFilter(
  machine: { id: string; hostname: string },
  email: string,
  value: string | null,
): boolean {
  if (!value) return true;
  return machine.hostname === value || machine.id === value || machine.id === `${email}::${value}`;
}

function value(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key)?.trim();
  return raw ? raw : null;
}

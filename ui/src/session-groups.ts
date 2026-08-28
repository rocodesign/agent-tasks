type LinkedSession = { session: { id: string; parentSessionId: string | null } };

type SessionGroup<T> = { root: T; subagents: T[] };

export function groupSessions<T extends LinkedSession>(sessions: T[]): SessionGroup<T>[] {
  const byId = new Map(sessions.map((item) => [item.session.id, item]));
  const groups = new Map<string, SessionGroup<T>>();

  for (const item of sessions) {
    let root = item;
    const seen = new Set([item.session.id]);
    while (root.session.parentSessionId) {
      const parent = byId.get(root.session.parentSessionId);
      if (!parent || seen.has(parent.session.id)) break;
      seen.add(parent.session.id);
      root = parent;
    }

    let group = groups.get(root.session.id);
    if (!group) {
      group = { root, subagents: [] };
      groups.set(root.session.id, group);
    }
    if (item.session.id !== root.session.id) group.subagents.push(item);
  }

  return [...groups.values()];
}

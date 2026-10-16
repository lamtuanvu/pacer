export function pluginManifest(version: string) {
  return {
    manifestVersion: 1,
    id: "pacer",
    publisher: "lamtuanvu",
    repository: "https://github.com/lamtuanvu/pacer",
    name: "pacer",
    version,
    description: "pacer's budget and task status at a glance. Act in the pacer app: `pacer open`.",
    engines: { orca: ">=1.4.224" },
    pluginApi: 1,
    main: "worker.mjs",
    icon: "assets/pacer-mark.svg",
    contributes: {
      panels: [{ id: "budget", title: "pacer", icon: "gauge", entry: "panel/live.html" }],
      commands: [{ id: "open", title: "pacer: Open", context: "global" }],
      // Orca starts a plugin worker only for a command or a declared event; these
      // frequent events start it soon after Orca opens. The worker ignores them.
      events: [{ on: "agent.status.changed" }, { on: "worktree.created" }],
    },
    capabilities: [
      { kind: "workspace:read" }, { kind: "notifications:show" },
      { kind: "events:subscribe" }, { kind: "storage" }, { kind: "settings:own" },
    ],
  } as const;
}

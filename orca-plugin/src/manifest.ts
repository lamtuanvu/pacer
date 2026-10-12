export function pluginManifest(version: string) {
  return {
    manifestVersion: 1,
    id: "pacer",
    publisher: "pacer",
    name: "pacer",
    version,
    description: "Budget-aware delegation: pacer's budget panel, delegate and strategy commands, and worker-finished signals.",
    engines: { orca: ">=1.4.224" },
    pluginApi: 1,
    main: "worker.mjs",
    contributes: {
      panels: [{ id: "budget", title: "pacer budget", icon: "gauge", entry: "panel/live.html" }],
      commands: [
        { id: "delegate", title: "pacer: Delegate", context: "worktree" },
        { id: "switch-strategy", title: "pacer: Switch strategy", context: "global" },
        { id: "refresh-status", title: "pacer: Refresh status", context: "global" },
        { id: "open-console", title: "pacer: Open pacer console", context: "global" },
      ],
      events: [{ on: "agent.status.changed" }, { on: "worktree.created" }],
    },
    capabilities: [
      { kind: "workspace:read" }, { kind: "terminal:send" }, { kind: "notifications:show" },
      { kind: "events:subscribe" }, { kind: "storage" }, { kind: "settings:own" },
    ],
  } as const;
}

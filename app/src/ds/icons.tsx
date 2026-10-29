export type IconName = "more" | "settings-plugins" | "chevron-left" | "settings-home" | "settings-agents" | "settings-routing" | "settings-budget" | "settings-machines" | "settings-app" | "settings-diagnostics" | "home" | "tasks" | "executors" | "accounts" | "strategy" | "hosts" | "settings" | "menu" | "overview" | "review" | "sessions" | "terminal" | "sliders" | "gauge" | "servers" | "routing" | "layers" | "download" | "bell" | "palette" | "diagnostics" | "plus" | "pr" | "commit" | "files" | "checks" | "time" | "retry" | "notes" | "branch" | "panel-left" | "panel-bottom" | "panel-right" | "split" | "external" | "end-session" | "insights" | "dispatch" | "plugin" | "search" | "stack" | "bolt" | "fork" | "check-circle" | "chevron-right" | "info";
export function Icon({ name }: { name: IconName }) {
  const paths: Partial<Record<IconName, string>> = {
    "chevron-left": "M15 6l-6 6 6 6",
    "settings-plugins": "M9 3v4M15 3v4M7 7h10v5a5 5 0 0 1-10 0zM12 17v4",
    "settings-home": "M3 12l9-8 9 8M5 10v10h14V10",
    "settings-agents": "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
    "settings-routing": "M4 12h6M10 12l6-6h4M10 12l6 6h4M10 12h10",
    "settings-budget": "M3 12h18M3 6h18M3 18h10",
    "settings-machines": "M4 5h16v10H4zM8 20h8M12 15v5",
    "settings-app": "M4 4h16v16H4zM4 9h16",
    "settings-diagnostics": "M3 12h4l3-7 4 14 3-7h4",

    "pr": "M6 8v8m0-14a3 3 0 1 0 0 6 3 3 0 0 0 0-6m0 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6M15 2l-3 3 3 3M12 5h4a3 3 0 0 1 3 3v8m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "commit": "M3 12h5m8 0h5m-9-4a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
    "files": "M8 3h8l4 4v14H8zM16 3v5h4M4 7v14",
    "checks": "m3 6 2 2 4-4M12 6h9m-18 8 2 2 4-4m3 2h9M3 21h18",
    "time": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 4v5l3 2",
    "info": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 8v5m0-8.5v.5",
    "retry": "M3 10a9 9 0 1 1 2 9M3 4v6h6",
    "notes": "M5 3h14v18H5zM8 7h8M8 11h8M8 15h5",
    "branch": "M6 7v10m0-16a3 3 0 1 0 0 6 3 3 0 0 0 0-6m0 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6M9 17a9 9 0 0 0 9-9V7m0-6a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
    "panel-left": "M3 4h18v16H3zM9 4v16",
    "panel-bottom": "M3 4h18v16H3zM3 14h18",
    "panel-right": "M3 4h18v16H3zM15 4v16",
    "split": "M3 4h18v16H3zM12 4v16",
    "external": "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
    "end-session": "M9 4H3v16h6m6-13 5 5-5 5M8 12h12",
    "insights": "M4 3v18h17M8 16v-5m5 5V6m5 10V9",
    "dispatch": "m3 3 18 9-18 9 4-9zM7 12h14",
    "stack": "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
    "bolt": "M13 2 4 14h7l-1 8 9-12h-7l1-8z",
    "fork": "M4 12h6m0 0 6-6h4m-10 6 6 6h4m-10-6h10",
    "check-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M8 12l3 3 5-6",
    "chevron-right": "m9 6 6 6-6 6",
    "search": "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14m9 16-4.5-4.5",
    "plugin": "M9 4H4v5a3 3 0 1 1 0 6v5h5a3 3 0 1 0 6 0h5v-5a3 3 0 1 0 0-6V4h-5a3 3 0 1 0-6 0z",
    sliders: "M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10M10 3v6m4 0v6M6 15v6",
    gauge: "M4 18a9 9 0 1 1 16 0M12 13l5-6M6 18h12",
    servers: "M4 3h16v7H4zM4 14h16v7H4zM7 6h1m-1 11h1",
    routing: "M5 3v12a5 5 0 0 0 5 5h9m-4-4 4 4-4 4M5 8h10a4 4 0 0 0 4-4",
    layers: "m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
    palette: "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3 9 9 0 0 0-9-7zM7 9h.01M11 6h.01M16 7h.01M6 13h.01",
    diagnostics: "M5 3v6a4 4 0 0 0 8 0V3M3 3h4m4 0h4M9 13v3a5 5 0 0 0 10 0v-3M17 10h4v3h-4z",
    plus: "M12 4v16M4 12h16",
    terminal: "M4 5h16v14H4zM7 10l3 2-3 2M12 15h5",
    home: "M4 11l8-7 8 7v9H4z", tasks: "M5 6h14M5 12h14M5 18h9", accounts: "M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a6 6 0 0 1 12 0v3M17 4a4 4 0 0 1 0 8m0 3a5 5 0 0 1 5 5",
    strategy: "M6 4v6a6 6 0 0 0 12 0V4M12 16v4", settings: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z", menu: "M4 6h16M4 12h16M4 18h16",
    overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z", review: "M5 12l4 4 10-10M5 20h14", sessions: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {name === "more" && [5,12,19].map(cx => <circle key={cx} cx={cx} cy="12" r="1.6" fill="currentColor" stroke="none" />)}
    {paths[name] && <path d={paths[name]} />}
    {name === "executors" && <><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="4" y="14" width="16" height="6" rx="1" /></>}
    {name === "hosts" && <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8" /></>}
    {name === "settings" && <circle cx="12" cy="12" r="3" />}
  </svg>;
}

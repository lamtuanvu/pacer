export type IconName = "home" | "tasks" | "executors" | "accounts" | "strategy" | "hosts" | "settings" | "menu" | "overview" | "review" | "sessions" | "terminal" | "sliders" | "gauge" | "servers" | "routing" | "layers" | "download" | "bell" | "palette" | "diagnostics" | "plus";
export function Icon({ name }: { name: IconName }) {
  const paths: Partial<Record<IconName, string>> = {
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
    strategy: "M6 4v6a6 6 0 0 0 12 0V4M12 16v4", settings: "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z", menu: "M4 6h16M4 12h16M4 18h16",
    overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z", review: "M5 12l4 4 10-10M5 20h14", sessions: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {paths[name] && <path d={paths[name]} />}
    {name === "executors" && <><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="4" y="14" width="16" height="6" rx="1" /></>}
    {name === "hosts" && <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8" /></>}
    {name === "settings" && <circle cx="12" cy="12" r="3" />}
  </svg>;
}

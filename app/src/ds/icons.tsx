export type IconName = "home" | "tasks" | "executors" | "accounts" | "strategy" | "hosts" | "settings" | "menu";
export function Icon({ name }: { name: IconName }) {
  const paths: Partial<Record<IconName, string>> = {
    home: "M4 11l8-7 8 7v9H4z", tasks: "M5 6h14M5 12h14M5 18h9", accounts: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    strategy: "M6 4v6a6 6 0 0 0 12 0V4M12 16v4", settings: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1", menu: "M4 6h16M4 12h16M4 18h16",
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {paths[name] && <path d={paths[name]} />}
    {name === "executors" && <><rect x="4" y="4" width="16" height="6" rx="1" /><rect x="4" y="14" width="16" height="6" rx="1" /></>}
    {name === "hosts" && <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8" /></>}
    {name === "settings" && <circle cx="12" cy="12" r="3" />}
  </svg>;
}

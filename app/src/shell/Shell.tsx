import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Mark } from "../ds/Mark";
import { Pill } from "../ds/Pill";
import { Icon, type IconName } from "../ds/icons";
import type { Route } from "../router";
import type { StoreState } from "../store";
const nav: { name: IconName; label: string; href: string }[] = [
  { name: "home", label: "Home", href: "#/" }, { name: "tasks", label: "Tasks", href: "#/tasks" },
  { name: "executors", label: "Executors", href: "#/executors" }, { name: "accounts", label: "Accounts & budgets", href: "#/accounts" },
  { name: "strategy", label: "Strategy", href: "#/strategy" }, { name: "hosts", label: "Hosts", href: "#/hosts" }, { name: "settings", label: "Settings", href: "#/settings" },
];
export function Shell({ state, route, children }: { state: StoreState; route: Route; children: ComponentChildren }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { setMenuOpen(false); }, [route.name, route.name === "task" ? route.id : ""]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); } };
    if (menuOpen) window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menuOpen]);
  if (state.sessionEnded) return <main className="session-ended"><Mark /><h1>Session ended.</h1><p>Run <code>pacer open</code>.</p></main>;
  const active = route.name === "task" ? "tasks" : route.name === "add-executor" ? "executors" : route.name;
  return <div className="app">
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <header className="mobile-top"><Mark size={22} /><button type="button" className="pc-btn pc-btn--secondary pc-btn--md" ref={menuButton} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button></header>
    <nav id="navigation" className={`side${menuOpen ? " side--open" : ""}`} aria-label="pacer">
      <div className="brand"><Mark size={22} /></div>
      {nav.map(item => <a key={item.name} className={`nav${active === item.name ? " on" : ""}`} href={item.href} aria-current={active === item.name ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon name={item.name} />{item.label}</a>)}
      <footer className="sidefoot"><span>pacer {state.version ?? "…"}</span><Pill tone={state.connected ? "good" : "neutral"}>{state.connected ? "Service running" : "Service disconnected"}</Pill></footer>
    </nav>
    <div className="content">
      <div aria-live="polite" role="status">{!state.connected && <div className="connection-bar">pacer isn't responding. Retrying…</div>}</div>
      <main id="main-content" tabIndex={-1} className="main">{state.snapshot ? children : <p>Connecting to pacer…</p>}</main>
    </div>
  </div>;
}

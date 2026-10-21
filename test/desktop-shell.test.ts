import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../desktop/ui/shell.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
function shell(search: string) {
  const elements = new Map<string, any>();
  const timers: (() => void)[] = [];
  let now = 0;
  const append = (...children: any[]) => {
    for (const child of children) if (child.id) elements.set(`#${child.id}`, child);
  };
  const document = {
    createElement() { return { hidden: false, textContent: "", append }; },
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        const tag = selector.startsWith("#") ? html.match(new RegExp(`<[^>]+id="${selector.slice(1)}"[^>]*>`))?.[0] || "" : "";
        const listeners = new Map<string, () => void>();
        elements.set(selector, {
          append,
          hidden: /\bhidden\b/.test(tag), checked: /\bchecked\b/.test(tag),
          href: tag.match(/href="([^"]*)"/)?.[1] || "", value: "", textContent: "",
          set innerHTML(_: string) { throw new Error("Shell details must use textContent"); },
          addEventListener(event: string, listener: () => void) { listeners.set(event, listener); },
          dispatch(event: string) { listeners.get(event)?.(); },
        });
      }
      return elements.get(selector);
    },
    body: { classList: { add() {} } },
  };
  const window: any = {};
  runInNewContext(script, { document, window, location: { search }, URLSearchParams,
    Date: { now: () => now }, setInterval: (fn: () => void) => timers.push(fn), clearInterval() {} });
  return { element: document.querySelector, render: window.renderShell,
    advance(seconds: number) { now += seconds * 1000; timers.at(-1)?.(); } };
}

test("recoverable states show only automatic starting status", () => {
  for (const state of ["not_installed", "stopped", "busy", "starting", "ready", "unavailable", "startFailed"]) {
    const page = shell(`?state=${state}`);
    expect(page.element("h1").textContent).toBe("Starting pacer…");
    expect(page.element("#message").hidden).toBe(true);
    expect(page.element("#privacy").hidden).toBe(true);
    expect(page.element("#install-help").hidden).toBe(true);
  }
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  expect(html).not.toMatch(/Try again|Start pacer|Restart pacer|pacer service install|id="command"/);
});

test("permission preview uses only the basename and an OS settings link", () => {
  const page = shell("?state=permission&path=/Volumes/External/Project");
  expect(page.element("#message").textContent).toBe("macOS needs your permission for pacer to read Project. Click Allow in the macOS dialog.");
  expect(page.element("#privacy").hidden).toBe(false);
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  expect(html).toContain('href="x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"');
  page.render({ page: "permission" });
  expect(page.element("#message").textContent).toContain("your external drive");
  page.render({ page: "starting" });
  expect(page.element("#privacy").hidden).toBe(true);
  expect(page.element("#message").hidden).toBe(true);
});

test("consent detection preview and incompatible installs have no recovery buttons", () => {
  expect(shell("?state=busy&prompt=1").element("#message").textContent).toContain("Click Allow");
  for (const state of ["oldService", "oldApp", "protocol"]) {
    const page = shell(`?state=${state}`);
    expect(page.element("#message").textContent).toContain("Install");
    expect(page.element("#privacy").hidden).toBe(true);
  }
});

test("shell uses the server page's current design tokens", () => {
  const tokens = readFileSync(new URL("../app/src/ds/tokens.css", import.meta.url), "utf8");
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  expect(css.startsWith(tokens)).toBe(true);
});

test("Starting pacer shows a subtle spinner that stops for reduced motion", async () => {
  const html = await Bun.file("desktop/ui/index.html").text(), css = await Bun.file("desktop/ui/shell.css").text(), js = await Bun.file("desktop/ui/shell.js").text();
  expect(html).toContain('id="spinner"');
  expect(css).toMatch(/\.spinner\s*\{[^}]*animation:\s*pacer-spin/);
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{\s*\.spinner\s*\{[^}]*animation:\s*none/);
  // Progress pages (installing, rolling back) keep the spinner; the other pages stop it.
  expect(js).toContain("document.querySelector('#spinner').hidden = permission || (Boolean(pages[detail.page]) && !progress.includes(detail.page));");
  expect(js).toMatch(/progress\s*=\s*\[[^\]]*'installing'[^\]]*'rollingBack'/);
});


test("stuck sign-in explains the failure, logs and background retries without a spinner", () => {
  const page = shell("?state=stuck");
  page.render({ page: "stuck", error: "Session exchange failed (HTTP 401)" });
  expect(page.element("h1").textContent).toContain("could not finish signing in");
  expect(page.element("#message").textContent).toContain("Session exchange failed (HTTP 401)");
  expect(page.element("#message").textContent).toContain("Retrying automatically");
  expect(page.element("#message").textContent).toContain("~/Library/Logs/pacer/desktop.log");
  expect(page.element("#message").hidden).toBe(false);
  expect(page.element("#spinner").hidden).toBe(true);
  page.render({ page: "starting" });
  expect(page.element("#message").hidden).toBe(true);
  expect(page.element("#spinner").hidden).toBe(false);
});

test("missing CLI page names the cause and links the install guide", () => {
  const page = shell("?state=install");
  expect(page.element("h1").textContent).toBe("pacer needs its command-line tool");
  expect(page.element("#message").textContent).toBe("The pacer app runs its background service through the pacer command-line tool, which isn't installed. Install it and this window continues on its own.");
  expect(page.element("#install-help").hidden).toBe(false);
  expect(page.element("#spinner").hidden).toBe(true);
  const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
  expect(html).toContain('id="install-help" href="https://github.com/lamtuanvu/pacer/blob/main/docs/install.md"');
  page.render({ page: "starting" });
  expect(page.element("#install-help").hidden).toBe(true);
});

test("foreign service page names the other pacer folder", () => {
  const page = shell("?state=foreign&path=~/other-pacer");
  expect(page.element("h1").textContent).toBe("Another pacer is running");
  expect(page.element("#message").textContent).toBe("The background service belongs to the pacer folder ~/other-pacer, and this app uses a different one.");
  expect(page.element("#foreign").hidden).toBe(false);
  expect(html).toMatch(/<section id="foreign" hidden>[\s\S]*<code>pacer service uninstall<\/code>[\s\S]*<\/section>/);
  expect(page.element("#install-help").hidden).toBe(true);
  expect(page.element("#spinner").hidden).toBe(true);
  page.render({ page: "starting" });
  expect(page.element("#foreign").hidden).toBe(true);
});

test("foreign service page names the ports when only the port differs", () => {
  const page = shell("?state=foreign&path=~/.pacer&port=5000&appPort=4317");
  expect(page.element("h1").textContent).toBe("Another pacer is running");
  expect(page.element("#message").textContent).toBe("The background service for the pacer folder ~/.pacer runs on port 5000, and this app uses port 4317.");
  expect(page.element("#foreign").hidden).toBe(false);
});

test.each([
  ["welcome", "Your planner plans. Your other agents do the work.", "#begin", "begin"],
  ["consent", "Here's what pacer will change", "#agree", "consent?path=0"],
  ["existing", "You already have pacer", "#use-app", "use-app"],
  ["incomplete", "This copy of pacer is incomplete", "#download", "download"],
])("%s shows its title and primary action", (state, title, action, sentinel) => {
  const page = shell(`?state=${state}`);
  expect(page.element("h1").textContent).toBe(title);
  expect(page.element(action).href).toBe(`tauri://localhost/action/${sentinel}`);
  expect(page.element(`#${state}`).hidden).toBe(false);
  expect(page.element("#spinner").hidden).toBe(true);
  page.render({ page: "starting" });
  expect(page.element(`#${state}`).hidden).toBe(true);
  expect(page.element("#spinner").hidden).toBe(false);
});

test("consent offers PATH changes only when needed and a shell file is available", () => {
  const page = shell("?state=consent&onPath=false&rc=~%2F.zshrc");
  expect(page.element("#path-row").hidden).toBe(false);
  expect(page.element("#rc").textContent).toBe("~/.zshrc");
  expect(page.element("#path").checked).toBe(false);
  for (const detail of [{ onPath: true, rc: "~/.zshrc" }, { onPath: false }, { rc: "~/.zshrc" }]) {
    page.render({ page: "consent", ...detail });
    expect(page.element("#path-row").hidden).toBe(true);
    expect(page.element("#agree").href).toBe("tauri://localhost/action/consent?path=0");
  }
});

test("PATH choice updates consent, survives refreshes and resets after leaving consent", () => {
  const page = shell("?state=consent");
  const detail = { page: "consent", onPath: false, rc: "~/.bashrc" };
  page.render(detail);
  page.element("#path").checked = true;
  page.element("#path").dispatch("change");
  expect(page.element("#agree").href).toBe("tauri://localhost/action/consent?path=1");
  page.render(detail);
  expect(page.element("#path").checked).toBe(true);
  expect(page.element("#agree").href).toBe("tauri://localhost/action/consent?path=1");
  page.element("#path").checked = false;
  page.element("#path").dispatch("change");
  expect(page.element("#agree").href).toBe("tauri://localhost/action/consent?path=0");
  page.element("#path").checked = true;
  page.render({ page: "welcome" });
  page.render(detail);
  expect(page.element("#path").checked).toBe(false);
});

test("existing installs render paths and versions as literal text", () => {
  const page = shell("?state=existing");
  const path = '/tmp/<img src=x onerror="alert(1)">/pacer';
  page.render({ page: "existing", path, installed: "0.2.2", version: "0.2.3" });
  expect(page.element("#existing-path").textContent).toBe(path);
  expect(page.element("#installed-version").textContent).toBe("0.2.2");
  expect(page.element("#app-version").textContent).toBe("0.2.3");
  expect(page.element("#keep-mine").href).toBe("tauri://localhost/action/keep-mine");
});

test("first-run markup supplies steps, consent controls, back navigation and recovery copy", () => {
  expect(html).toMatch(/<ol\b[^>]*>[\s\S]*?<li>[\s\S]*?<li>[\s\S]*?<li>[\s\S]*?<\/ol>/);
  expect(html).toContain("Takes about three minutes. Nothing changes until you agree.");
  expect(html).toMatch(/<input[^>]*id="service"[^>]*checked[^>]*disabled/);
  expect(html).toMatch(/<label[^>]*for="service"/);
  expect(html).toMatch(/<input[^>]*id="terminal"[^>]*checked[^>]*disabled/);
  expect(html).toMatch(/<label[^>]*for="terminal"/);
  expect(html).toMatch(/<label[^>]*for="path"/);
  expect(html).toContain('# &gt;&gt;&gt; pacer &gt;&gt;&gt;\nexport PATH="$HOME/.local/bin:$PATH"\n# &lt;&lt;&lt; pacer &lt;&lt;&lt;');
  expect(html).toContain('href="tauri://localhost/index.html?state=welcome"');
  expect(html).toContain("Homebrew");
  expect(html).toContain("brew uninstall pacer");
  const page = shell("?state=incomplete");
  expect(page.element("#message").textContent).toBe("The app runs pacer through a command-line tool that should come inside it, and it's missing. Download pacer again and replace this app. Your settings are kept.");
});


test("relink offers recreation and a dismissal for this launch", () => {
  const page = shell("?state=relink");
  expect(page.element("h1").textContent).toBe("pacer's terminal command was removed");
  expect(page.element("#relink").hidden).toBe(false);
  expect(page.element("#recreate-link").textContent).toBe("Recreate it");
  expect(page.element("#recreate-link").href).toBe("tauri://localhost/action/relink");
  expect(page.element("#skip-relink").textContent).toBe("Not now");
  expect(page.element("#skip-relink").href).toBe("tauri://localhost/index.html?state=starting");
  expect(page.element("#spinner").hidden).toBe(true);
  page.render({ page: "permission" });
  expect(page.element("#relink").hidden).toBe(true);
  page.render({ page: "starting" });
  expect(page.element("#relink").hidden).toBe(true);
  expect(page.element("#spinner").hidden).toBe(false);
});

test("OTA fallback pages distinguish installation, rollback, restored and failed recovery without private errors", () => {
  const copy = {
    installing: "Installing update", rollingBack: "Restoring the previous version",
    restored: "Previous version restored", recoveryFailed: "Recovery needs attention",
  };
  for (const [state, title] of Object.entries(copy)) {
    const page = shell(`?state=${state}`); page.render({ page: state, error: "private-path-and-nonce" });
    expect(page.element("h1").textContent).toBe(title);
    expect(page.element("#message").textContent).not.toContain("private-path-and-nonce");
    expect(page.element("#privacy").hidden).toBe(true); expect(page.element("#install-help").hidden).toBe(true);
  }
  expect(shell("?state=restored").element("#message").textContent).toBe("The update couldn't start. Your previous version has been restored.");
  expect(shell("?state=recoveryFailed").element("#message").textContent).not.toContain("has been restored");
  // The tray popover has no report button, so its text names where to report.
  expect(shell("?state=recoveryFailed&compact=1").element("#message").textContent).toContain("report the problem at github.com/lamtuanvu/pacer/issues.");
  expect(shell("?state=recoveryFailed").element("#message").textContent).not.toContain("github.com");
});

test("reduced motion keeps a visible static spinner arc and the report action is centred", async () => {
  const css = await Bun.file("desktop/ui/shell.css").text();
  expect(css).not.toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{\s*\.spinner\s*\{[^}]*border-top-color/);
  expect(css).toMatch(/\.actions--center\s*\{\s*justify-content:\s*center/);
});

test("fixture shell excludes the production global singleton socket before registering plugins",()=>{
 const source=readFileSync(new URL("../desktop/src-tauri/src/main.rs",import.meta.url),"utf8");
 expect(source).toMatch(/#\[cfg\(not\(feature\s*=\s*"ota-fixture"\)\)\]\s*let app = app\.plugin\(tauri_plugin_single_instance::init/);
 expect(source).toContain('identity["fixtureIsolationProtocol"] = serde_json::json!(1)');
});

test("fixture shell isolates webview storage and excludes global OS integrations",()=>{
 const source=readFileSync(new URL("../desktop/src-tauri/src/main.rs",import.meta.url),"utf8");
 expect((source.match(/\.incognito\(cfg!\(feature\s*=\s*"ota-fixture"\)\)/g)??[])).toHaveLength(3);
 expect(source).toMatch(/#\[cfg\(not\(feature\s*=\s*"ota-fixture"\)\)\]\s*let app = app\s*\.plugin\(tauri_plugin_deep_link/);
 expect(source).toContain('fn launch_at_login(_app: &AppHandle, _enabled: bool)');
 expect(source).toContain('Launch at login is unavailable in isolated fixtures');
 expect(source).toMatch(/#\[cfg\(not\(feature\s*=\s*"ota-fixture"\)\)\]\s*\{\s*let links = handle.clone/);
 expect(source).toContain('fn notify(_app: &AppHandle, _notification: notifications::Notification) {}');
});

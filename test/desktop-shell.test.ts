import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../desktop/ui/shell.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../desktop/ui/index.html", import.meta.url), "utf8");
function shell(search: string) {
  const elements = new Map<string, any>();
  const timers: (() => void)[] = [];
  let now = 0;
  let focused: any = null;
  const location = { search, href: `tauri://localhost/index.html${search}` };
  const append = (...children: any[]) => {
    for (const child of children) if (child.id) elements.set(`#${child.id}`, child);
  };
  const document = {
    createElement(tag: string) { return { tag, hidden: false, textContent: "", append }; },
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        const tag = selector.startsWith("#") ? html.match(new RegExp(`<[^>]+id="${selector.slice(1)}"[^>]*>`))?.[0] || "" : "";
        const listeners = new Map<string, () => void>();
        const element: any = {
          append, tag: tag.match(/^<(\w+)/)?.[1] || "",
          hidden: /\bhidden\b/.test(tag), checked: /\bchecked\b/.test(tag), disabled: /\bdisabled\b/.test(tag),
          href: tag.match(/href="([^"]*)"/)?.[1] || "", value: "", textContent: "", breaks: 0,
          set innerHTML(_: string) { throw new Error("Shell details must use textContent"); },
          replaceChildren(...nodes: any[]) {
            element.textContent = nodes.map(node => typeof node === "string" ? node : "").join("");
            element.breaks = nodes.filter(node => node?.tag === "wbr").length;
          },
          focus() { focused = element; },
          addEventListener(event: string, listener: () => void) { listeners.set(event, listener); },
          dispatch(event: string) { listeners.get(event)?.(); },
        };
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
    body: { classList: { add() {} } },
  };
  const window: any = {};
  runInNewContext(script, { document, window, location, URLSearchParams,
    Date: { now: () => now }, setInterval: (fn: () => void) => timers.push(fn), clearInterval() {} });
  return { element: document.querySelector, render: window.renderShell, takeover: window.renderTakeover, location,
    focused: () => focused,
    advance(seconds: number) { now += seconds * 1000; timers.at(-1)?.(); } };
}

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const inspection = {
  currentPath: "/tmp/pacer-fixture/a-rather-long-checkout-directory/.local/bin/pacer",
  currentVersion: "0.2.4", replacementPath: "/Applications/pacer.app/Contents/Resources/pacer",
  label: "com.pacer.serve", port: 4317, dataHome: "/tmp/pacer-fixture/.pacer", work: { tasks: 2, terminals: null },
};
const internal = /\b(prepared|stopping|switched|verifying|restoring|committed|recovery-failed|redetect|interrupted:|identity|verify:|helper:)\b/;

test("takeover offer has its own heading, no spinner and a tray pointer", () => {
  const page = shell("?state=takeover");
  expect(page.element("h1").textContent).toBe("Use the app's service");
  expect(page.element("#spinner").hidden).toBe(true);
  expect(page.element("#takeover").hidden).toBe(false);
  expect(page.element("#message").hidden).toBe(true);
  // A later diagnosis render (for example after the tray reloads) keeps the decision page.
  page.render({ page: "takeover" });
  expect(page.element("h1").textContent).toBe("Use the app's service");
  expect(page.element("#takeover").hidden).toBe(false);
  page.render({ page: "starting" });
  expect(page.element("#takeover").hidden).toBe(true);
  const tray = shell("?state=takeover&compact=1");
  expect(tray.element("#takeover").hidden).toBe(true);
  expect(tray.element("#message").textContent).toBe("Open the pacer window to review replacing the service.");
});

test("takeover details are literal, fully readable and use one spelling for unknown values", () => {
  const page = shell("?state=takeover");
  page.takeover({ inspection, progress: null, token: TOKEN });
  expect(page.element("#takeover-current").textContent).toBe(inspection.currentPath);
  // Paths may break only after each separator.
  expect(page.element("#takeover-current").breaks).toBe(inspection.currentPath.split("/").length - 1);
  expect(page.element("#takeover-replacement").textContent).toBe(inspection.replacementPath);
  expect(page.element("#takeover-home").textContent).toBe(inspection.dataHome);
  expect(page.element("#takeover-version").textContent).toBe("0.2.4");
  expect(page.element("#takeover-port").textContent).toBe("4317");
  expect(page.element("#takeover-tasks").textContent).toBe("2");
  expect(page.element("#takeover-terminals").textContent).toBe("Unknown");
  page.takeover({ inspection: null, progress: null, token: TOKEN });
  for (const id of ["#takeover-current", "#takeover-version", "#takeover-port", "#takeover-tasks"]) expect(page.element(id).textContent).toBe("Unknown");
  expect(html).not.toMatch(/>unknown</);
  const path = '/tmp/<img src=x onerror="alert(1)">/pacer';
  page.takeover({ inspection: { ...inspection, currentPath: path }, progress: null, token: TOKEN });
  expect(page.element("#takeover-current").textContent).toBe(path);
});

test("takeover actions are buttons that navigate only with the injected single-use token", () => {
  // Explicit tabindex keeps them on the Tab order in WKWebView without Full Keyboard Access.
  expect(html).toMatch(/<input id="takeover-relink" type="checkbox" tabindex="0">/);
  expect(html).toMatch(/<button type="button" id="takeover-confirm" class="button primary" tabindex="0">Use the app's service<\/button>/);
  expect(html).toMatch(/<button type="button" id="takeover-dismiss" class="button" tabindex="0">Not now<\/button>/);
  expect(html).toMatch(/<button type="button" id="takeover-continue" class="button primary" tabindex="0"[^>]*>Continue current service<\/button>/);
  expect(html).not.toMatch(/action\/takeover-/);
  const page = shell("?state=takeover");
  const before = page.location.href;
  // No actions, and no navigation, until the native shell supplies a token.
  expect(page.element("#takeover-actions").hidden).toBe(true);
  page.element("#takeover-confirm").dispatch("click");
  expect(page.location.href).toBe(before);
  page.takeover({ inspection, progress: null, token: TOKEN });
  expect(page.element("#takeover-actions").hidden).toBe(false);
  expect(page.element("#takeover-relink").checked).toBe(false);
  page.element("#takeover-relink").checked = true;
  page.element("#takeover-confirm").dispatch("click");
  expect(page.location.href).toBe(`tauri://localhost/action/takeover-confirm?relink=1&token=${TOKEN}`);
  // The token is used once, focus moves to the status and the choice is locked.
  expect(page.element("#takeover-actions").hidden).toBe(true);
  expect(page.element("#takeover-relink").disabled).toBe(true);
  expect(page.focused()).toBe(page.element("#takeover-progress"));
  page.location.href = before;
  page.element("#takeover-dismiss").dispatch("click");
  expect(page.location.href).toBe(before);
  page.takeover({ inspection, progress: null, token: TOKEN });
  page.element("#takeover-dismiss").dispatch("click");
  expect(page.location.href).toBe(`tauri://localhost/action/takeover-dismiss?token=${TOKEN}`);
});

test("takeover progress is plain copy, keeps focus and re-enables the offer only after an error", () => {
  const page = shell("?state=takeover");
  page.takeover({ inspection, progress: null, token: TOKEN });
  const copy = {
    prepared: "Checking the current service…", stopping: "Stopping the current service…",
    switched: "Starting the app's service…", verifying: "Checking the app's service…",
    restoring: "Restoring your current service…", committed: "The app's service is running.",
  };
  for (const [state, text] of Object.entries(copy)) {
    page.takeover({ inspection, progress: { state, error: "verify:unavailable" }, token: null });
    expect(page.element("#takeover-progress").textContent).toBe(text);
    expect(page.element("#takeover-progress").textContent).not.toMatch(internal);
    expect(page.element("#takeover-actions").hidden).toBe(true);
    expect(page.element("#takeover-relink").disabled).toBe(true);
  }
  expect(page.focused()).toBe(page.element("#takeover-progress"));
  page.takeover({ inspection, progress: { state: "committed", error: "relink" }, token: null });
  expect(page.element("#takeover-progress").textContent).toBe("The app's service is running, but the terminal command still runs the other build.");
  page.takeover({ inspection, progress: { state: "error", error: null }, token: TOKEN });
  expect(page.element("#takeover-progress").textContent).toBe("The service wasn't replaced, and nothing was changed. You can try again.");
  expect(page.element("#takeover-actions").hidden).toBe(false);
  expect(page.element("#takeover-relink").disabled).toBe(false);
  page.takeover({ inspection, progress: { state: "unheard-of" }, token: null });
  expect(page.element("#takeover-progress").textContent).toBe("Replacing the service…");
});

test("takeover outcomes explain reasons in plain copy and never show codes or update wording", () => {
  for (const [reason, text] of [
    ["redetect:identity", "The service changed after you reviewed it, so pacer left it as it was."],
    ["verify:unavailable", "The app's service didn't start correctly, so pacer put your current service back."],
    ["interrupted:switch-registration", "The replacement was interrupted, so pacer put your current service back."],
    ["stop-original:identity", "pacer couldn't stop the current service, so it kept it running."],
    ["helper:io", "pacer put your current service back."],
    [null, "pacer put your current service back."],
  ]) {
    const page = shell("?state=takeoverRestored");
    page.render({ page: "takeoverRestored", error: reason });
    expect(page.element("h1").textContent).toBe("Kept your current service");
    expect(page.element("#message").textContent).toBe(text);
    expect(page.element("#message").textContent).not.toMatch(internal);
    expect(page.element("#takeover-restored").hidden).toBe(false);
    expect(page.element("#spinner").hidden).toBe(true);
  }
  const restored = shell("?state=takeoverRestored");
  restored.render({ page: "takeoverRestored", error: "verify:unavailable" });
  expect(restored.element("#takeover-restored-actions").hidden).toBe(true);
  restored.takeover({ inspection: null, progress: null, token: TOKEN });
  expect(restored.element("#takeover-restored-actions").hidden).toBe(false);
  expect(html).toContain("Continuing hides this offer for this build of the current service.");
  restored.element("#takeover-continue").dispatch("click");
  expect(restored.location.href).toBe(`tauri://localhost/action/takeover-dismiss?token=${TOKEN}`);

  const failed = shell("?state=takeoverFailed");
  failed.render({ page: "takeoverFailed", error: "restore-registration:identity" });
  expect(failed.element("h1").textContent).toBe("Service replacement needs attention");
  expect(failed.element("#message").textContent).toContain("couldn't put your previous service back on its own");
  expect(failed.element("#message").textContent).toContain("leave those files as they are");
  expect(failed.element("#message").textContent).not.toMatch(/update|internal|restore-registration/i);
  expect(failed.element("#report-issue").hidden).toBe(false);
  expect(shell("?state=takeoverFailed&compact=1").element("#message").textContent).toContain("github.com/lamtuanvu/pacer/issues");

  const progress = shell("?state=takeoverProgress");
  expect(progress.element("h1").textContent).toBe("Replacing the pacer service");
  expect(progress.element("#message").textContent).not.toMatch(/update/i);
  expect(progress.element("#spinner").hidden).toBe(false);
  expect(progress.element("#takeover").hidden).toBe(true);
});

test("takeover warning is body text with warning tokens and a text label", () => {
  expect(html).toMatch(/<p class="callout-warn"><strong>Warning:<\/strong> pacer cannot confirm this build is idle\. Running work may be interrupted\.<\/p>/);
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.callout-warn \{[^}]*var\(--warn-bg\)[^}]*var\(--warn-fg\)/);
  expect(css).not.toMatch(/\.callout-warn \{[^}]*font-size/);
  expect(css).toMatch(/\.button:focus-visible \{ outline: 2px solid var\(--focus\)/);
});

test("takeover paths and labels wrap instead of clipping", () => {
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  // A label such as com.pacer.live.<hex>.service has no separator to break at.
  expect(css).toMatch(/\.path--wrap \{ white-space: normal; overflow-wrap: anywhere; overflow-x: visible; \}/);
});

test("takeover choice stays visible at the default window height", () => {
  // Checkbox, status and actions stay pinned to the bottom of the window while the details scroll.
  expect(html).toMatch(/<div class="takeover-choice">\s*<div class="consent-row">[\s\S]*id="takeover-progress"[\s\S]*id="takeover-actions"[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/);
  const css = readFileSync(new URL("../desktop/ui/shell.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.takeover-choice \{ position: sticky; bottom: 0;[^}]*background: var\(--surface-page\)/);
});

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

test("older live service explains missing screens and keeps current work reachable", () => {
  const page = shell("?state=outdatedService&installed=0.9.0&version=0.10.0");
  expect(page.element("h1").textContent).toBe("Your service needs an update");
  expect(page.element("#message").textContent).toContain("new Dispatcher controls are unavailable");
  expect(page.element("#live-service-version").textContent).toBe("0.9.0");
  expect(page.element("#desktop-release-version").textContent).toBe("0.10.0");
  expect(page.element("#outdated-service").hidden).toBe(false);
  expect(page.element("#continue-old-service").href).toBe("tauri://localhost/action/continue-old-service");
  expect(page.element("#service-update-guide").hidden).toBe(false);
  expect(page.element("#spinner").hidden).toBe(true);
  page.render({page:"starting"});
  expect(page.element("#outdated-service").hidden).toBe(true);
});

test("missing service release is never presented as current", () => {
  const page = shell("?state=unverifiedService&version=0.10.0");
  expect(page.element("h1").textContent).toBe("Check the service version");
  expect(page.element("#live-service-version").textContent).toBe("Unknown");
  expect(page.element("#outdated-service").hidden).toBe(false);
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

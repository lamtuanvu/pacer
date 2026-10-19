import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../desktop/ui/shell.js", import.meta.url), "utf8");
function shell(search: string) {
  const elements = new Map<string, any>();
  const timers: (() => void)[] = [];
  let now = 0;
  const document = {
    querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, value: "", textContent: "", addEventListener() {} });
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
  expect(js).toContain("document.querySelector('#spinner').hidden = permission || Boolean(pages[detail.page]);");
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
  expect(page.element("#message").textContent).toBe("The background service belongs to the pacer folder ~/other-pacer, and this app uses a different one. Stop the other service, or open the app with the same pacer folder.");
  expect(page.element("#install-help").hidden).toBe(true);
  expect(page.element("#spinner").hidden).toBe(true);
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
});

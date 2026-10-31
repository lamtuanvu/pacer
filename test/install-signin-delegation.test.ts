import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, webkit, type Page } from "playwright-core";
import { tmpDir } from "./helpers";

// Opt in: these tests need the compiled CLI and installed Playwright browsers.
// CI runs them separately from the unit suite; see docs/testing/ci-e2e.md.
const e2e = test.skipIf(process.env.PACER_E2E !== "1");
const root = resolve(import.meta.dir, "..");

test("fake agent completion mode writes the Codex summary and exits", () => {
  const cwd = tmpDir(), report = join(cwd, "summary.txt");
  const result = Bun.spawnSync([join(root, "test/fixtures/bin/fake-agent"), "exec", "-o", report], {
    cwd, env: { ...process.env, PACER_FAKE_COMPLETE: "1" }, timeout: 2000,
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(report, "utf8")).toContain("ready for review");
  expect(readFileSync(join(cwd, "takeover-change.txt"), "utf8")).toBe("headless change\n");
});

// Uses the existing production build artifact, avoiding a second compiler path.
// This must run the real CLI graph: a tiny replacement entry misses module cycles.
e2e("compiled production Core loads for version, help and JSON-RPC hello", async () => {
  const home = tmpDir(), binary = join(root, "dist", "pacer-core");
  const env = { HOME: home, PACER_HOME: join(home, ".pacer"), PACER_NO_UPDATE_CHECK: "1", PATH: process.env.PATH, TZ: "Asia/Ho_Chi_Minh" };
  for (const args of [["--version"], ["--help"]]) {
    const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain(args[0] === "--version" ? "pacer " : "usage: pacer");
  }
  const child = Bun.spawn([binary, "api", "--stdio"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n");
  child.stdin.end();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out)).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocol: "3.0.0" } });
}, 30_000);

async function sandbox() {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), repo = join(home, "repo"), codexHome = join(home, ".codex");
  // The owned executor broker requires the Pacer home to be private before it
  // claims a run directory. Match the installed app's home permissions.
  mkdirSync(pacerHome, { recursive: true, mode: 0o700 });
  for (const dir of [bin, repo, codexHome]) mkdirSync(dir, { recursive: true });
  // Routing checks for a login indicator even for the fake executor. This empty
  // marker contains no credentials and stays isolated from the host Codex home.
  writeFileSync(join(codexHome, "auth.json"), "{}");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("PACER_")) delete env[name];
  Object.assign(env, {
    HOME: home, CODEX_HOME: codexHome, PACER_HOME: pacerHome, PACER_BACKEND: "direct", PACER_NO_UPDATE_CHECK: "1",
    PACER_FAKE_COMPLETE: "1", PACER_LOGIN_ENV: "off", PATH: `${bin}:${process.env.PATH}`, TZ: "Asia/Ho_Chi_Minh",
  });
  symlinkSync(join(root, "test/fixtures/bin/fake-agent"), join(bin, "codex"));
  // Never inspect a host Orca installation or use its budgets/service manager.
  for (const name of ["orca", "launchctl", "systemctl"]) writeFileSync(join(bin, name), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {usage: reactive}}\nexecution: {backend: direct, launch_mode: headless}\n");

  async function run(argv: string[]) {
    const proc = Bun.spawn(argv, { env: argv[0] === "sh" ? {...env, TMPDIR: home} : env, cwd: repo, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    try {
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code !== 0) throw Error(`${argv[0]} ${argv[1]} exited ${code}: ${err}`);
      return out.trim();
    } finally { clearTimeout(timer); }
  }
  await run(["git", "init", "-q"]);
  await run(["git", "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);

  // Exercise the real checksum-verifying installer with this checkout's build,
  // including atomic replacement on a second install. No release network needed.
  // `bun run build` intentionally reports 0.0.0-dev; release builds embed a version.
  const version = (await run([join(root, "dist/pacer-core"), "--version"])).replace(/^pacer /, "");
  const release = join(home, "releases", version);
  mkdirSync(release, { recursive: true });
  const artifact = `pacer-${process.platform}-${process.arch}`;
  // Releases still ship the single bun-compiled CLI until the paired release (M1 plan 5).
  copyFileSync(join(root, "dist/pacer-core"), join(release, artifact));
  const hash = createHash("sha256").update(readFileSync(join(release, artifact))).digest("hex");
  writeFileSync(join(release, "SHA256SUMS"), `${hash}  ${artifact}\n`);
  Object.assign(env, { PACER_INSTALL_DIR: bin, PACER_INSTALL_VERSION: version, PACER_RELEASE_BASE: `file://${join(home, "releases")}` });
  await run(["sh", join(root, "install.sh")]);
  await run(["sh", join(root, "install.sh")]);
  const cli = (...args: string[]) => run([join(bin, "pacer"), ...args]);
  expect(await cli("--version")).toBe(`pacer ${version}`);

  // Ask the OS for a free port; the service must identify itself before use.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  env.PACER_PORT = String(port);
  const base = `http://127.0.0.1:${port}`;
  const log = join(home, "serve.log");
  const service = Bun.spawn([join(bin, "pacer"), "serve", "--port", String(port)], {
    cwd: repo, env, stdout: Bun.file(log), stderr: Bun.file(log),
  });
  async function close() {
    service.kill();
    const timer = setTimeout(() => service.kill("SIGKILL"), 5000);
    try { await service.exited; } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && service.exitCode === null) {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }).catch(() => null);
      if (response?.ok && response.headers.get("x-pacer") === "1" && (await response.json()).pid === service.pid) { ready = true; break; }
      await Bun.sleep(100);
    }
    if (!ready) throw Error(`Sandbox service did not become healthy: ${readFileSync(log, "utf8")}`);
  } catch (error) { await close(); throw error; }
  return { base, cli, repo, close };
}

e2e("installed open --print URL is accepted by the desktop auth contract", async () => {
  const s = await sandbox();
  try {
    const url = new URL(await s.cli("open", "--print"));
    expect(url.origin).toBe(s.base);
    expect(url.pathname).toBe("/app/auth");
    expect(url.searchParams.getAll("code")).toHaveLength(1);
    expect(url.searchParams.get("code")).toBeTruthy();
    // desktop/src-tauri/src/logic.rs::auth_url accepts an optional app route.
    expect(url.hash === "" || url.hash.startsWith("#/")).toBe(true);
  } finally { await s.close(); }
}, 90_000);

async function browserFetch(page: Page, path: string, params?: Record<string, unknown>) {
  return page.evaluate(async ({ path, params }) => {
    const response = await fetch(path, params === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Pacer-Client": "app" }, body: JSON.stringify(params),
    });
    if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }, { path, params });
}

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  e2e(`${name}: cross-site desktop sign-in and fake delegation reach explicit review`, async () => {
    const s = await sandbox();
    let taskId: string | undefined;
    let browser: Awaited<ReturnType<typeof engine.launch>> | undefined;
    // localhost and 127.0.0.1 are different sites, not merely different ports.
    let landing: ReturnType<typeof Bun.serve> | undefined;
    try {
      landing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<a href="#" id="signin">Sign in</a>', { headers: { "Content-Type": "text/html" } }) });
      browser = await engine.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      expect((await page.goto(`${s.base}/app/`))?.status()).toBe(401);
      const auth = await s.cli("open", "--print");
      await page.goto(`http://localhost:${landing.port}/`);
      await page.locator("#signin").evaluate((link, href) => link.setAttribute("href", href), auth);
      const appResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/app/");
      await page.locator("#signin").click();
      // A stored cookie alone is insufficient: Strict can be withheld on the
      // cross-site redirect chain. The first app document must authenticate.
      expect((await appResponse).status()).toBe(200);
      await page.waitForURL(url => url.pathname === "/app/");
      const cookie = (await context.cookies(s.base)).find(c => c.name === "pacer_session");
      expect(cookie).toBeDefined();
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite).toBe("Strict");
      expect(cookie!.domain).toBe("127.0.0.1");
      expect(cookie!.path).toBe("/");
      expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000);
      expect(await page.evaluate(() => document.cookie)).not.toContain("pacer_session");
      await browserFetch(page, "/v3/snapshot");
      expect((await context.request.get(auth)).status()).toBe(403); // single use
      // Interactive work is available without installing planner hooks/service.
      // Wait for the actual landing screen before reload, including in WebKit.
      await page.getByRole("heading", { level: 1, name: "Dispatch" }).waitFor();
      expect(new URL(page.url()).hash).not.toBe("#/setup");
      expect((await page.reload())?.status()).toBe(200);
      await page.getByRole("heading", { level: 1, name: "Dispatch" }).waitFor();

      const { result: task } = await browserFetch(page, "/v3/ops/task.delegate", {
        repo: s.repo, goal: "Create takeover-change.txt", acceptance: "test -f takeover-change.txt",
        executor: "codex", source: "ui", timeout_min: 1, worktree: "current", worktree_reason: "disposable CI fixture",
      });
      taskId = task.task_id;
      expect(taskId).toBeTruthy();
      const deadline = Date.now() + 45_000;
      let completed: { state: string; rev: number; review?: unknown } | undefined;
      while (Date.now() < deadline) {
        const { snapshot } = await browserFetch(page, "/v3/snapshot");
        const row = snapshot.tasks.find((t: { id: string }) => t.id === taskId);
        if (row && ["failed", "limit", "stopped", "partial"].includes(row.state)) throw Error(`Fake delegation settled as ${row.state}: ${JSON.stringify(row)}`);
        if (row?.state === "done") {
          expect(row.review).toBeFalsy();
          // Completion is task history; only an explicit handoff needs a decision.
          expect(snapshot.attention.some((a: { kind: string; taskId?: string }) => a.kind === "review" && a.taskId === taskId)).toBe(false);
          completed = row;
          break;
        }
        await Bun.sleep(250);
      }
      expect(completed).toBeDefined();
      const note = "Check the generated takeover-change.txt before accepting the result.";
      const { result: handoff } = await browserFetch(page, "/v3/ops/task.request_review", {
        id: taskId, note, expect_rev: completed!.rev,
      });
      expect(handoff.task.state).toBe("done");
      expect(handoff.task.reviewRequest.note).toBe(note);
      expect(handoff.task.review).toBeFalsy();
      // Snapshot projection refreshes asynchronously; retain the original deadline.
      let reviewed = false;
      while (Date.now() < deadline) {
        const { snapshot } = await browserFetch(page, "/v3/snapshot");
        const requested = snapshot.tasks.find((t: { id: string }) => t.id === taskId);
        if (snapshot.attention.some((a: { kind: string; taskId?: string }) => a.kind === "review" && a.taskId === taskId)) {
          expect(requested.state).toBe("done");
          expect(requested.reviewRequest.note).toBe(note);
          expect(requested.review).toBeFalsy();
          reviewed = true;
          break;
        }
        await Bun.sleep(250);
      }
      expect(reviewed).toBe(true);
      expect(readFileSync(join(s.repo, "takeover-change.txt"), "utf8")).toContain("headless change");
    } finally {
      if (taskId) await s.cli("stop", taskId).catch(error => console.error(`Task cleanup: ${error.message}`));
      try { await browser?.close(); }
      finally { landing?.stop(true); await s.close(); }
    }
  }, 120_000);
}

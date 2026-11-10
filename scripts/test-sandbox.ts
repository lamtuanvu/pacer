import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedPort } from "../test/child-env";

/** The macOS sandbox's localhost address covers both loopback families. */
export function testSandboxProfile(...ports: number[]): string {
  if (!ports.length || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid protected port");
  return `(version 1) (allow default) ${ports.map(port => `(deny network-outbound (remote tcp "localhost:${port}"))`).join(" ")}`;
}

if (import.meta.main) {
  const args = [process.execPath, "test", "--timeout", "30000", ...process.argv.slice(2)];
  let scratch: string | undefined;
  try {
    const env = { ...process.env };
    scratch = mkdtempSync(join(tmpdir(), "pacer-test-sandbox-"));
    env.OLLAMA_HOST = `http://127.0.0.1:${closedPort()}`;
    env.LMS_API_SERVER_INFO_PATH = join(scratch, "lms-server.json");
    writeFileSync(env.LMS_API_SERVER_INFO_PATH, JSON.stringify({ port: closedPort() }), { mode: 0o600 });
    const needsSandbox = process.platform === "darwin";
    if (needsSandbox) {
      // macOS refuses to exec its setuid /bin/ps in any sandbox. Tests need a
      // non-setuid copy for process identity checks; sign only the temporary copy.
      const ps = join(scratch, "ps");
      copyFileSync("/bin/ps", ps);
      chmodSync(ps, 0o755);
      const signed = Bun.spawnSync(["/usr/bin/codesign", "--force", "--sign", "-", ps], { stdout: "ignore", stderr: "pipe" });
      if (signed.exitCode !== 0) throw new Error(`Could not sign test ps: ${signed.stderr.toString()}`);
      // Probe a disposable port before entering the sandbox: sandbox-exec cannot
      // install a second profile from a process that is already sandboxed.
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      try {
        const url = `http://127.0.0.1:${probe.port}/`;
        const script = `try { await fetch(process.argv[1]); process.exit(0); } catch { process.exit(42); }`;
        const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", testSandboxProfile(probe.port!), process.execPath, "-e", script, url], { stdout: "ignore", stderr: "pipe" });
        if (await child.exited !== 42 || await (await fetch(url)).text() !== "ok") {
          throw new Error(`Test sandbox loopback self-check failed: ${await new Response(child.stderr).text()}`);
        }
      } finally { probe.stop(true); }
      env.PACER_TEST_PS = ps;
      env.PATH = `${scratch}:${env.PATH ?? "/usr/bin:/bin"}`;
    }
    const command = needsSandbox
      ? ["/usr/bin/sandbox-exec", "-p", testSandboxProfile(4317, 11434, 1234, 41343), ...args]
      : args;
    const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
    process.exitCode = result.exitCode ?? 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

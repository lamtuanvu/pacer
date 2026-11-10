import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The macOS sandbox's localhost address covers both loopback families. */
export function testSandboxProfile(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid protected port");
  return `(version 1) (allow default) (deny network-outbound (remote tcp "localhost:${port}"))`;
}

if (import.meta.main) {
  const args = [process.execPath, "test", "--timeout", "30000", ...process.argv.slice(2)];
  let scratch: string | undefined;
  try {
    const env = { ...process.env };
    const needsSandbox = process.platform === "darwin" && env.PACER_TEST_SANDBOX !== "1";
    if (needsSandbox) {
      // macOS refuses to exec its setuid /bin/ps in any sandbox. Tests need a
      // non-setuid copy for process identity checks; sign only the temporary copy.
      scratch = mkdtempSync(join(tmpdir(), "pacer-test-sandbox-"));
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
      env.PACER_TEST_SANDBOX = "1";
      env.PACER_TEST_PS = ps;
      env.PATH = `${scratch}:${env.PATH ?? "/usr/bin:/bin"}`;
    }
    const command = needsSandbox
      ? ["/usr/bin/sandbox-exec", "-p", testSandboxProfile(4317), ...args]
      : args;
    const result = Bun.spawnSync(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
    process.exitCode = result.exitCode ?? 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

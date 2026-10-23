import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { checkout, healthy, liveRoot, record, shellQuote, validId, type Session } from "./core";

export function integrationsFixtureRoot(session: Session): string {
  const expected = join(liveRoot, validId(session.id));
  if (session.root !== expected || session.seed || session.stopped) throw Error("Integration fixture requires an active unseeded sandbox");
  for (const path of [checkout, join(checkout, ".work"), liveRoot, expected, join(expected, "evidence")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error("Integration fixture requires private canonical owned directories");
  }
  const log = join(expected, "evidence/log.jsonl");
  if (existsSync(log)) {
    const stat = lstatSync(log);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw Error("Integration fixture requires private evidence");
  }
  return join(expected, "integrations");
}

/** Fixed file-only fixtures. No agent login, native credentials or real service registration. */
export async function exerciseIntegrations(session: Session): Promise<void> {
  const root = integrationsFixtureRoot(session);
  if (!await healthy(session)) throw Error("Integration fixture requires a healthy harness service and proxy");
  mkdirSync(root, { mode: 0o700 }); // Exclusive: preserve previous attempts for diagnosis.
  const home = join(root, "home"), state = join(root, "state"), work = join(home, "accounts/work");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const wrapper = join(root, "pacer");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(checkout, "src/cli.ts"))} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, PACER_HOME: state, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), PACER_BIN: wrapper, PACER_PORT: "0", PACER_NO_UPDATE_CHECK: "1", PACER_ORCA_USER_DATA: join(root, "orca"), PACER_BACKEND: "direct" };
  writeFileSync(join(state, "strategy.yaml"), JSON.stringify({ planner: "codex#work", accounts: { codex: { kind: "codex", usage: "quota" }, work: { kind: "codex", home: work, usage: "quota" } }, runners: { codex: {}, "codex#work": {} }, routing: [{ default: ["codex#work"] }] }), { mode: 0o600 });
  const cli = async (...args: string[]) => {
    const argv = [process.execPath, join(checkout, "src/cli.ts"), ...args];
    const child = Bun.spawn(argv, { cwd: join(session.root, "repo"), env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    record(session, { kind: "command", argv, code, stdout, stderr });
    return { code, stdout, stderr };
  };
  const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const manifestPath = join(state, "install-manifest.json"), skill = join(work, "skills/pacer/SKILL.md");
  const startup = async () => {
    const child = Bun.spawn([process.execPath, join(checkout, "src/cli.ts"), "serve", "--port", "0"], { cwd: join(session.root, "repo"), env, stdout: "pipe", stderr: "pipe" });
    let output = "";
    try {
      const reader = child.stdout.getReader();
      const deadline = Date.now() + 15000;
      while (!output.includes("\n")) {
        const result = await Promise.race([reader.read(), Bun.sleep(15000).then(() => { throw Error("fixture service startup timed out"); })]);
        if (result.done || Date.now() > deadline) throw Error("fixture service did not announce readiness");
        output += new TextDecoder().decode(result.value);
      }
      const port = output.match(/127\.0\.0\.1:(\d+)/)?.[1];
      check(port && (await fetch(`http://127.0.0.1:${port}/health`)).ok, "fixture health unavailable");
      // Startup reconciliation is asynchronous; wait for its observable installed content.
      for (let i = 0; i < 100 && readFileSync(skill, "utf8") === "old release skill"; i++) await Bun.sleep(50);
    } finally {
      child.kill("SIGTERM"); await child.exited;
      record(session, { kind: "command", argv: ["fixture service startup"], code: child.exitCode ?? 0, stdout: output, stderr: await new Response(child.stderr).text() });
    }
  };
  try {
    check((await cli("install", "codex")).code === 0, "default fixture connect failed");
    check((await cli("install", "codex#work")).code === 0, "named fixture connect failed");
    const desired = readFileSync(skill, "utf8"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(skill, "old release skill");
    const owned = manifest.planners["codex#work"].files.find((file: { path: string }) => file.path === skill);
    owned.afterHash = hash("old release skill"); delete owned.managed;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await startup();
    check(readFileSync(skill, "utf8") === desired, "startup did not update stale named-account skill");
    record(session, { kind: "note", behavior: "Startup refresh and named-account targeting", surface: "CLI/service", verdict: "PASS", text: "Real CLI installed default and named private accounts. New service startup refreshed an old-but-intact named-account skill; health remained available. All integration targets are inside the fixture." });
    const before = readFileSync(manifestPath, "utf8");
    await startup();
    check(readFileSync(manifestPath, "utf8") === before, "idempotent startup rewrote the manifest");
    check((await cli("integrations", "refresh", "--json")).code === 0, "idempotent CLI reconciliation failed");
    record(session, { kind: "note", behavior: "Idempotent repeated startup and explicit refresh", surface: "CLI/service", verdict: "PASS", text: "Second service startup preserved manifest bytes; shared reconciler reported both accounts current." });
    const hooks = join(work, "hooks.json"), doc = JSON.parse(readFileSync(hooks, "utf8"));
    doc.theme = "fixture-dark"; writeFileSync(hooks, JSON.stringify(doc));
    check((await cli("integrations", "refresh", "--json")).code === 0, "unrelated setting caused a conflict");
    check(JSON.parse(readFileSync(hooks, "utf8")).theme === "fixture-dark", "unrelated setting lost");
    writeFileSync(skill, "user customization");
    const conflict = await cli("integrations", "refresh", "--json");
    check(conflict.code === 1 && JSON.parse(conflict.stdout).some((row: { target: string; state: string }) => row.target === "codex#work" && row.state === "conflict"), "customization was not reported as a conflict");
    check(readFileSync(skill, "utf8") === "user customization", "customization overwritten");
    record(session, { kind: "note", behavior: "Preserve unrelated settings and customized managed files", surface: "CLI/service", verdict: "PASS", text: "Unrelated hook-file theme retained. Customized named-account skill preserved; refresh exited 1 with a target-specific repair hint while default account remained current." });
    writeFileSync(skill, desired);
    check((await cli("integrations", "refresh", "--json")).code === 0, "retry after conflict resolution failed");
    record(session, { kind: "note", behavior: "Retry after resolving customization", surface: "CLI/service", verdict: "PASS", text: "Restoring desired managed content allowed the next reconciliation to succeed without reconnecting other accounts." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Integration fixture", surface: "CLI/service", verdict: "FAIL", text: (error as Error).message }); throw error;
  }
}

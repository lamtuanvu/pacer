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
  const originalNamedSkill = "pre-existing named fixture skill\n";
  mkdirSync(join(work, "skills/pacer"), { recursive: true, mode: 0o700 });
  writeFileSync(skill, originalNamedSkill, { mode: 0o600 });
  const claudeSettings = join(home, ".claude", "settings.json");
  const claudeSkill = join(home, ".claude", "skills/pacer/SKILL.md");
  const originalClaudeSkill = "pre-existing Claude fixture skill\n";
  mkdirSync(join(home, ".claude/skills/pacer"), { recursive: true, mode: 0o700 });
  writeFileSync(claudeSkill, originalClaudeSkill, { mode: 0o600 });
  writeFileSync(claudeSettings, JSON.stringify({ theme: "fixture-before", userSetting: true }), { mode: 0o600 });
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

    check((await cli("install", "claude-code")).code === 0, "Claude fixture connect failed");
    const legacy = JSON.parse(readFileSync(manifestPath, "utf8"));
    const claudeFile = legacy.planners["claude-code"].files.find((file: { path: string }) => file.path === claudeSettings);
    check(claudeFile, "Claude settings ownership missing");
    delete claudeFile.managed;
    writeFileSync(manifestPath, JSON.stringify(legacy));
    const customized = JSON.parse(readFileSync(claudeSettings, "utf8"));
    customized.theme = "fixture-dark";
    writeFileSync(claudeSettings, JSON.stringify(customized));
    check((await cli("integrations", "refresh", "--json")).code === 0, "legacy Claude unrelated setting caused a conflict");
    check(JSON.parse(readFileSync(claudeSettings, "utf8")).theme === "fixture-dark", "legacy Claude unrelated setting lost");
    const ownedStatusLine = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete ownedStatusLine.planners["claude-code"].files.find((file: { path: string }) => file.path === claudeSettings).managed;
    writeFileSync(manifestPath, JSON.stringify(ownedStatusLine));
    const managedStatusLine = customized.statusLine.command;
    customized.statusLine.command = "custom-status";
    writeFileSync(claudeSettings, JSON.stringify(customized));
    const statusLineConflict = await cli("integrations", "refresh", "--json");
    check(statusLineConflict.code === 1 && JSON.parse(statusLineConflict.stdout).some((row: { target: string; state: string }) => row.target === "claude-code" && row.state === "conflict"), "legacy Claude status-line edit was not protected");
    check(JSON.parse(readFileSync(claudeSettings, "utf8")).statusLine.command === "custom-status", "legacy Claude status-line edit overwritten");
    record(session, { kind: "note", behavior: "Legacy Claude settings migration", surface: "CLI", verdict: "PASS", text: "Private CLI fixture accepted unrelated Claude settings changes and recorded managed ownership; a later edited pacer-owned status line remained untouched and reported conflict." });

    customized.statusLine.command = managedStatusLine;
    writeFileSync(claudeSettings, JSON.stringify(customized));
    check((await cli("integrations", "refresh", "--json")).code === 0, "Claude fixture conflict resolution failed");
    const defaultSkill = join(home, ".codex/skills/pacer/SKILL.md");
    const defaultBefore = readFileSync(defaultSkill, "utf8"), claudeBefore = readFileSync(claudeSettings, "utf8");
    check((await cli("uninstall", "codex#work")).code === 0, "named fixture uninstall failed");
    check(readFileSync(skill, "utf8") === originalNamedSkill, "named pre-existing skill was not restored");
    check(JSON.parse(readFileSync(hooks, "utf8")).theme === "fixture-dark", "named user setting lost during uninstall");
    check(readFileSync(defaultSkill, "utf8") === defaultBefore && readFileSync(claudeSettings, "utf8") === claudeBefore, "named uninstall changed another account");
    check(!JSON.parse(readFileSync(manifestPath, "utf8")).planners["codex#work"], "named uninstall retained its record");
    record(session, { kind: "note", behavior: "Named integration uninstall restores backups", surface: "CLI", verdict: "PASS", text: "Actual private named-target uninstall restored its pre-existing skill and preserved its unrelated setting, default Codex content and Claude settings." });

    // Fixed owned-home cleanup exercises recorded-cleanup, unlike target uninstall.
    const namedHooksBefore = readFileSync(hooks, "utf8");
    const cleanupManifestBefore = readFileSync(manifestPath, "utf8");
    const preview = await cli("uninstall", "--all", "--json");
    check(preview.code === 2, "cleanup preflight did not refuse non-TTY mutation");
    const cleanupPlan = JSON.parse(preview.stdout).plan as { kind: string; target: string; paths: string[]; action: string }[];
    const privateHomePath = (path: string) => path === home || path.startsWith(home + "/");
    check(Array.isArray(cleanupPlan) && cleanupPlan.length === 4 && cleanupPlan.every(row => {
      if (row.kind === "agent") return ["codex", "claude-code"].includes(row.target) && row.paths.length > 0 && row.paths.every(privateHomePath);
      if (row.kind === "home") return row.target === state && row.paths.length === 0;
      // The CLI always lists a binary; this entry explicitly leaves our wrapper alone.
      if (row.kind === "binary") return row.target === wrapper && row.paths.length === 0 && row.action === "left in place (use --binary to delete)";
      return false; // No service manager, plugin, PATH profile or app-link effects.
    }) && cleanupPlan.filter(row => row.kind === "agent").map(row => row.target).sort().join(",") === "claude-code,codex"
      && cleanupPlan.filter(row => row.kind === "home").length === 1 && cleanupPlan.filter(row => row.kind === "binary").length === 1, "cleanup preflight escaped fixed private fixture scope");
    check(readFileSync(manifestPath, "utf8") === cleanupManifestBefore, "cleanup preflight changed the manifest");
    const removed = await cli("uninstall", "--all", "--yes", "--json");
    check(removed.code === 0 && JSON.parse(removed.stdout).results.every((row: { status: string }) => row.status === "ok"), "recorded private-home cleanup failed");
    check(readFileSync(claudeSkill, "utf8") === originalClaudeSkill, "recorded cleanup did not restore pre-existing Claude skill");
    const restoredSettings = JSON.parse(readFileSync(claudeSettings, "utf8"));
    check(restoredSettings.theme === "fixture-dark" && restoredSettings.userSetting === true && restoredSettings.statusLine === undefined, "recorded cleanup lost user settings or retained managed status line");
    check(!existsSync(defaultSkill), "recorded cleanup retained created default skill");
    check(readFileSync(skill, "utf8") === originalNamedSkill && readFileSync(hooks, "utf8") === namedHooksBefore, "recorded cleanup changed the already disconnected named account");
    check(!existsSync(state), "recorded cleanup retained fixture state after successful restoration");
    record(session, { kind: "note", behavior: "Recorded integration cleanup restores files before private state removal", surface: "CLI", verdict: "PASS", text: "Actual fixed uninstall --all restored pre-existing Claude skill and preserved unrelated Claude settings before removing private fixture state; created default skill was removed and the disconnected named account stayed byte-identical." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Integration fixture", surface: "CLI/service", verdict: "FAIL", text: (error as Error).message }); throw error;
  }
}

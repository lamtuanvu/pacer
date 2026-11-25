/** Record TypeScript install behavior as host-neutral goldens for the Rust SDK. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyUndo, mergeUndo, piecesPresent, removeTomlTable, type UndoOp } from "../../src/install/manifest";
import { sha256 as hostSha256, shellCommand as hostShellCommand } from "../../src/install/fsx";
import * as hostManaged from "../../src/install/managed-content";
import { upsertBlock } from "../../packages/plugin-sdk/src/install/blocks";
import { policyText } from "../../packages/plugin-sdk/src/install/policy-text";
import { Txn } from "../../src/install/txn";
import { fakeCtx } from "../../test/helpers";
import { chmodSync, mkdirSync, writeFileSync as write } from "node:fs";

const HERE = new URL("../../crates/plugin-sdk/tests/fixtures/install/", import.meta.url);
const PLANNERS = ["claude-code", "codex", "cursor", "opencode"] as const;

export function recordHelpers() {
  const texts = ["", "abc", "界", "\ufeffvalue", "line\nnext", "\0"];
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const argv = [
    [],
    ["pacer", "space here", "\n", "'", "$HOME", "`literal`", "界"],
    ["/opt/My Disk/pacer", "it's"],
    ["/usr/bin/pacer_-.:=@%+-"],
  ];
  return {
    sha256: Object.fromEntries(texts.map((text) => [text, sha(text)])),
    hostAgree: texts.every((text) => sha(text) === hostSha256(text)),
    shellCommand: argv.map((items) => ({ argv: items, command: hostShellCommand(items) })),
  };
}

export function recordPolicyText() {
  return Object.fromEntries(PLANNERS.map((planner) => [planner, policyText(planner)]));
}

const block: UndoOp[] = [{ kind: "block", style: "md" }];

export function recordUndoOracle() {
  const cases: { text: string; ops: UndoOp[] }[] = [
    { text: "before\n\n<!-- >>> pacer >>> -->\n界\n<!-- <<< pacer <<< -->\n", ops: [{ kind: "block", style: "md" }] },
    { text: "anchor\n\n# >>> pacer >>>\nnew\n# <<< pacer <<<\n", ops: [{ kind: "block", style: "hash", restore: [{ text: "legacy\n", anchor: "anchor\n", spacing: "\n", atMarker: true }] }] },
    { text: "other", ops: [{ kind: "block", style: "hash", restore: [{ text: "legacy\n", anchor: "missing\n" }] }] },
    { text: '[managed] # comment\r\nx=1\r\n[next]\r\ny=2', ops: [{ kind: "toml-table", table: "managed" }] },
    { text: '\ufeff{\n// keep\n"mcp":{"pacer":{},},"mine":"界",\n}', ops: [{ kind: "json-member", path: ["mcp", "pacer"], dropEmpty: ["mcp"] }] },
    { text: '{"hooks":{"SessionStart":[{"matcher":"Bash","hooks":[{"command":"owned"},{"command":"other"}]}]}}', ops: [{ kind: "hooks", format: "claude", commands: ["owned"], restore: [{ event: "SessionStart", matcher: "Bash", hook: { command: "legacy", timeout: 15 } }] }] },
    { text: '{"hooks":{"sessionStart":[{"command":"owned","custom":true}]},"statusLine":{},"mine":1}', ops: [{ kind: "hooks", format: "cursor", commands: ["owned"], restore: [] }, { kind: "json-key", key: "statusLine" }] },
    { text: '{"key":1,"key":2}', ops: [{ kind: "json-key", key: "key" }] },
  ];
  return cases.map(({ text, ops }) => {
    const notes: string[] = [];
    return {
      text,
      ops,
      after: applyUndo(text, ops, notes),
      notes,
      present: piecesPresent(text, ops),
      merged: mergeUndo(ops, ops),
    };
  });
}

export function recordPlanOracle() {
  const ctx = fakeCtx({ now: 1700000000 });
  mkdirSync(ctx.home, { recursive: true });
  const path = join(ctx.home, "AGENTS.md");
  const legacy = join(ctx.home, "legacy.sh");
  write(path, "mine\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  write(legacy, "legacy\n", { mode: 0o700 });
  chmodSync(legacy, 0o700);
  const io = {
    read: async (file: string) => {
      try {
        return { text: readFileSync(file, "utf8"), mode: require("node:fs").statSync(file).mode };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
  const env = {
    ctx,
    now: ctx.now,
    pacerArgv: ["pacer"],
    mcp: true,
    plannerAccount: "account",
    folder: ctx.home,
    configEnv: { CODEX_HOME: ctx.home },
  };
  const sdk = new Txn(env, "codex");
  const stages: { body: string; after: boolean }[] = [];
  for (const body of ["one", "two"]) {
    stages.push({
      body,
      after: sdk.edit(path, (old) => upsertBlock(old!, body, "md"), block),
    });
  }
  sdk.moveAside(legacy);
  sdk.moveAside(legacy);
  const created = join(ctx.home, "new");
  sdk.edit(created, () => "new\n", []);
  // Backup stamps are wall-clock times; normalize them so the golden is portable.
  const normalize = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(ctx.home, "$HOME")
        .replace(/\.pacer-bak-\d{8}-\d{6}/g, ".pacer-bak-<STAMP>"),
    );
  return {
    stages,
    record: normalize(sdk.record),
    pending: normalize([...sdk.pending]),
    touched: normalize(sdk.touched),
    notes: normalize(sdk.notes),
    disk: { agents: readFileSync(path, "utf8"), legacy: readFileSync(legacy, "utf8") },
  };
}

const goldens: [string, () => unknown][] = [
  ["helpers-oracle.json", recordHelpers],
  ["policy-text.json", recordPolicyText],
  ["undo-oracle.json", recordUndoOracle],
  ["plan-oracle.json", recordPlanOracle],
];

if (import.meta.main) {
  let stale = false;
  for (const [name, record] of goldens) {
    const expected = JSON.parse(JSON.stringify(record()));
    const file = new URL(name, HERE);
    if (process.argv.includes("--check")) {
      let actual: unknown;
      try {
        actual = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        actual = null;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        console.error(`stale golden: ${name} (re-record: bun scripts/plugin-parity/install-goldens.ts)`);
        stale = true;
      }
    } else {
      writeFileSync(file, JSON.stringify(expected, null, 2) + "\n");
      console.log(`wrote ${name}`);
    }
  }
  if (stale) process.exit(1);
}

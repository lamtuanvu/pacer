#!/usr/bin/env node
/**
 * Live spike: drive `opencode acp` with a tiny stdio MCP server and ask a cheap
 * model to call `echo_secret_word`. HOME stays real (opencode sign-in); PACER_HOME
 * and cwd are temp. Never reads or copies opencode auth.json.
 *
 * Usage: node test/fixtures/acp-spike/run-acp-spike.mjs [--deny-builtins]
 * Env: SPIKE_MODEL (default opencode-go/glm-5.3-flash), SPIKE_TIMEOUT_MS (default 180000)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, "echo-secret-mcp.mjs");
const MODEL = process.env.SPIKE_MODEL ?? "opencode-go/glm-5.3-flash";
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 180_000);
const DENY_BUILTINS = process.argv.includes("--deny-builtins");
const REPO = resolve(HERE, "../../..");
const OUT_DIR = process.env.SPIKE_OUT_DIR ?? join(REPO, ".work/fixtures/acp-spike");

mkdirSync(OUT_DIR, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "pacer-acp-spike-cwd-"));
const pacerHome = mkdtempSync(join(tmpdir(), "pacer-acp-spike-home-"));
const configDir = join(pacerHome, "opencode-config");
mkdirSync(configDir, { recursive: true, mode: 0o700 });

const BUILTIN_DENY = [
  "bash", "read", "edit", "write", "webfetch", "execute", "task", "grep", "glob", "list", "patch",
];

const config = {
  $schema: "https://opencode.ai/config.json",
  model: MODEL,
  default_agent: "pacer-spike",
  instructions: [],
  plugins: [],
  agents: {
    "pacer-spike": {
      description: "ACP spike agent",
      mode: "primary",
      system:
        "You are a test agent. When asked to call echo_secret_word, call that MCP tool immediately and reply with only the word it returns. Do not invent a word.",
      ...(DENY_BUILTINS
        ? {
            permissions: BUILTIN_DENY.map((action) => ({
              action,
              resource: "*",
              effect: "deny",
            })),
          }
        : {}),
    },
  },
  // Keep MCP out of OPENCODE_CONFIG_CONTENT: ACP session/new carries mcpServers.
  policies: DENY_BUILTINS
    ? [
        { action: "tool.use", resource: "*", effect: "deny" },
        { action: "tool.use", resource: "echo-secret_*:*", effect: "allow" },
        { action: "tool.use", resource: "echo_secret_*:*", effect: "allow" },
      ]
    : [],
};

const report = {
  startedAt: new Date().toISOString(),
  opencode: null,
  model: MODEL,
  denyBuiltins: DENY_BUILTINS,
  cwd,
  pacerHome,
  // HOME preserved (not recorded as a path under tracked files later).
  homePreserved: Boolean(process.env.HOME),
  mcpPath: MCP,
  frames: [],
  permissions: [],
  toolCalls: [],
  text: [],
  sessionId: null,
  toolListed: null,
  toolCalled: false,
  secretInReply: false,
  builtinAttempted: [],
  builtinDeniedOrHidden: null,
  errors: [],
  stopReason: null,
  finishedAt: null,
};

const logPath = join(OUT_DIR, DENY_BUILTINS ? "spike-deny.log" : "spike-call.log");
const log = createWriteStream(logPath, { flags: "w" });
const note = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  process.stderr.write(`${line}\n`);
  log.write(`${line}\n`);
};

const env = {
  ...process.env,
  PACER_HOME: pacerHome,
  OPENCODE_CLIENT: "acp",
  OPENCODE_ENABLE_QUESTION_TOOL: "false",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  // Isolate project/config overlays; keep HOME and XDG_DATA_HOME so auth resolves.
  XDG_CONFIG_HOME: join(pacerHome, "xdg-config"),
  OPENCODE_CONFIG_DIR: configDir,
};

note(`cwd=${cwd}`);
note(`PACER_HOME=${pacerHome}`);
note(`model=${MODEL} denyBuiltins=${DENY_BUILTINS}`);

const child = spawn("opencode", ["acp"], {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

report.opencode = "spawned";
let nextId = 1;
const pending = new Map();

const send = (method, params) => {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  note(`→ ${method} id=${id}`);
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
};

const reply = (id, result) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const isMcpTool = (title = "", raw = {}) => {
  const blob = `${title} ${JSON.stringify(raw)}`.toLowerCase();
  return blob.includes("echo_secret_word") || blob.includes("echo-secret") || blob.includes("echo_secret");
};

const isBuiltin = (title = "", raw = {}) => {
  const blob = `${title} ${JSON.stringify(raw)}`.toLowerCase();
  return BUILTIN_DENY.some((name) => blob.includes(name));
};

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    note(`non-json stdout: ${line.slice(0, 200)}`);
    return;
  }
  report.frames.push(msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const wait = pending.get(msg.id);
    if (wait) {
      pending.delete(msg.id);
      if (msg.error) {
        note(`← error for ${wait.method}: ${JSON.stringify(msg.error)}`);
        wait.reject(msg.error);
      } else {
        note(`← result for ${wait.method}`);
        wait.resolve(msg.result);
      }
    }
    return;
  }
  if (msg.method === "session/update") {
    const update = msg.params?.update ?? {};
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && update.content?.text) {
      report.text.push(update.content.text);
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const entry = {
        kind,
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status,
        rawInput: update.rawInput,
      };
      report.toolCalls.push(entry);
      note(`tool ${kind}: ${update.title ?? update.toolCallId} status=${update.status}`);
      if (isMcpTool(update.title, update.rawInput)) {
        report.toolCalled = true;
        report.toolListed = true;
      }
      if (isBuiltin(update.title, update.rawInput)) {
        report.builtinAttempted.push(update.title ?? update.toolCallId);
      }
    }
    if (kind === "available_commands_update") {
      note(`available_commands: ${JSON.stringify(update.availableCommands).slice(0, 500)}`);
    }
    return;
  }
  if (msg.method === "session/request_permission") {
    const toolCall = msg.params?.toolCall ?? {};
    const title = toolCall.title ?? "";
    const options = msg.params?.options ?? [];
    const allow = options.find((o) => o.kind === "allow_once" || o.optionId === "once");
    const reject = options.find((o) => o.kind === "reject_once" || o.optionId === "reject");
    const mcp = isMcpTool(title, toolCall.rawInput);
    const choice = mcp ? allow : reject ?? options.find((o) => String(o.kind).startsWith("reject"));
    report.permissions.push({ title, mcp, choice: choice?.optionId ?? null });
    note(`permission ${title} mcp=${mcp} → ${choice?.optionId}`);
    if (!choice) {
      report.errors.push(`no permission option for ${title}`);
      reply(msg.id, { outcome: { outcome: "rejected" } });
      return;
    }
    // ACP selected outcome shapes vary; try the common SelectedPermissionOutcome form.
    reply(msg.id, { outcome: { outcome: "selected", optionId: choice.optionId } });
    return;
  }
  if (msg.method && msg.id !== undefined) {
    note(`← request ${msg.method}`);
    // Answer unknown agent→client requests with empty result so the session continues.
    reply(msg.id, {});
  }
});

createInterface({ input: child.stderr }).on("line", (line) => {
  note(`opencode stderr: ${line}`);
  if (/echo-secret-mcp|tools\/call|echo_secret/.test(line)) {
    report.toolCalled = true;
  }
});

child.on("exit", (code, signal) => {
  note(`opencode exit code=${code} signal=${signal}`);
});

const finish = (err) => {
  report.finishedAt = new Date().toISOString();
  if (err) report.errors.push(String(err?.message ?? err));
  const replyText = report.text.join("");
  report.replyText = replyText;
  report.secretInReply = /\b(amber|cedar|flint|harbor|maple|onyx|quartz|ridge|sable|willow)\b/i.test(replyText);
  if (report.toolListed === null) {
    // If the model never attempted the tool, we still do not know if it was listed.
    report.toolListed = report.toolCalled ? true : "unknown-no-attempt";
  }
  if (DENY_BUILTINS) {
    report.builtinDeniedOrHidden =
      report.builtinAttempted.length === 0
        ? "no-builtin-attempts-observed"
        : "builtin-attempted-see-permissions";
  }
  const out = join(OUT_DIR, DENY_BUILTINS ? "spike-deny.json" : "spike-call.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  note(`wrote ${out}`);
  note(`toolListed=${report.toolListed} toolCalled=${report.toolCalled} secretInReply=${report.secretInReply}`);
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  log.end();
  process.exit(err && !report.toolCalled ? 1 : 0);
};

const timer = setTimeout(() => finish(new Error("spike timed out")), TIMEOUT_MS);

(async () => {
  try {
    const init = await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "pacer-acp-spike", version: "0.0.1" },
    });
    note(`initialize agent=${JSON.stringify(init?.agentInfo ?? init)}`);
    await send("authenticate", { methodId: "opencode" }).catch((e) => {
      note(`authenticate skipped/failed: ${JSON.stringify(e)}`);
    });

    const mcpServers = [
      {
        name: "echo-secret",
        command: process.execPath,
        args: [MCP],
        env: [],
      },
    ];
    const created = await send("session/new", { cwd, mcpServers });
    report.sessionId = created?.sessionId ?? null;
    note(`sessionId=${report.sessionId}`);
    note(`session/new keys=${Object.keys(created ?? {}).join(",")}`);
    if (created?.models) note(`models=${JSON.stringify(created.models).slice(0, 400)}`);
    if (created?._meta) note(`_meta=${JSON.stringify(created._meta).slice(0, 800)}`);

    // Prefer setting the model when the session exposes a set-model method.
    if (created?.models?.availableModels?.length) {
      const match = created.models.availableModels.find((m) =>
        String(m.modelId ?? m.id ?? "").includes("glm-5.3-flash") ||
        String(m.modelId ?? m.id ?? "") === MODEL
      );
      const modelId = match?.modelId ?? match?.id ?? MODEL;
      await send("session/set_model", { sessionId: report.sessionId, modelId }).catch((e) =>
        note(`session/set_model: ${JSON.stringify(e)}`)
      );
    }

    const promptText = DENY_BUILTINS
      ? "First try to run bash with command 'echo builtin-probe'. Then call the MCP tool echo_secret_word and reply with only the secret word it returns."
      : "Call the MCP tool echo_secret_word now. Reply with only the secret word it returns. Do not invent a word.";

    const promptResult = await send("session/prompt", {
      sessionId: report.sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    report.stopReason = promptResult?.stopReason ?? null;
    note(`prompt done stopReason=${report.stopReason}`);
    clearTimeout(timer);
    finish();
  } catch (err) {
    clearTimeout(timer);
    finish(err);
  }
})();

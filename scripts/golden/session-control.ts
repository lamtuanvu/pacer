/** Executable TS reference corpus for the dormant session view/control library. */
import { writeFileSync } from "node:fs";
import { parseSessionArgs } from "../../src/commands/session";
import {
  terminalRecipe,
  validateTerminalOpen,
  splitArgv,
} from "../../src/session/targets";
import {
  takeoverAvailability,
  parseOpencodeSessions,
} from "../../src/session/takeover";
import { assertCallerCanInvoke } from "../../src/api/caller-policy";
import {
  viewerMessageFrames,
  socketFrameMessage,
} from "../../src/serve/session-ws";
import { WireDecoder, FrameType, wire } from "../../src/session/framing";
import { renderSessionFrame } from "../../src/session/attach";
import { stripQueryReplies } from "../../src/session/queries";
import { pendingAfter } from "../../src/session/viewers";
import { fakeCtx } from "../../test/helpers";
const attempt = (f: () => unknown) => {
  try {
    return { ok: JSON.parse(JSON.stringify(f() ?? null)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
};
export function recordControl() {
  const session = [
    ["end", "", "real-id"],
    ["end", ""],
    [],
    ["bad"],
    ["start"],
    ["start", "--", "\u0085"],
    ["start", "--", "\ufeff"],
    ["start", "--", "\u200b"],
    [
      "start",
      "--repo",
      "r",
      "--executor",
      "codex",
      "--base",
      "main",
      "--attach",
      "a",
      "--attach",
      "b",
      "--json",
      "--",
      " hi ",
      "--x",
    ],
    ["start", "--checkout", "x", "--", "go"],
    ["end", "id", "--json"],
    ["resume", "id"],
    ["resume"],
    ["end", "a", "b"],
    ["start", "--repo"],
    ["start", "--wat"],
    ["start", "--base", "m", "--checkout", "x", "--", "go"],
    ["end", "id", "--", "ignored"],
    ["start", "--repo", "a", "--repo", "b", "--", "go"],
  ].map((args) => ({ args, result: attempt(() => parseSessionArgs(args)) }));
  const templates = [
    "",
    "auto",
    "kitty",
    "tool {cmd}",
    'tool "x {cmd}"',
    "tool '' {cmd}",
    "tool \\{cmd}",
    'tool "{cmd}',
    "x\n{cmd}",
    "x".repeat(1994) + "{cmd}",
    "😀".repeat(998) + "{cmd}",
    "x",
    "tool\u0085{cmd}",
    "tool\ufeff{cmd}",
  ];
  const terminal = templates.map((setting) => ({
    setting,
    result: attempt(() => validateTerminalOpen(setting)),
    split: attempt(() => splitArgv(setting)),
    recipe: attempt(() => terminalRecipe(setting, "task_1", "linux")),
  }));
  const recipes = [
    "ghostty",
    "iterm",
    "terminal-app",
    "wezterm",
    "kitty",
    "alacritty",
    "gnome-terminal",
    "x-terminal-emulator",
    "auto",
  ].flatMap((setting) =>
    ["darwin", "linux"].map((platform) => ({
      setting,
      platform,
      result: terminalRecipe(setting, "t-1", platform as NodeJS.Platform),
    })),
  );
  const base = {
    state: "running",
    executor: "codex",
    run: {
      executor: "codex",
      dir: "/nonexistent-pacer-fixture",
      agentSession: { id: "s" },
    },
  };
  const tasks = [
    base,
    { ...base, state: "done" },
    { ...base, executorProvider: "pacer-exec-direct" },
    { ...base, run: { ...base.run, host: "remote" } },
    { ...base, run: { ...base.run, executor: "codex@remote" } },
    { ...base, run: { ...base.run, executor: "codex@local" } },
    { ...base, backend: "orca" },
    { ...base, result: { backend: "orca" } },
    { ...base, run: undefined },
    { ...base, run: { ...base.run, takeover: true } },
    { ...base, takeover: { state: "starting" } },
    ...[
      "agy",
      "unknown",
      "cursor",
      "claude-code",
      "opencode",
      "codex#work",
    ].map((executor) => ({
      ...base,
      executor,
      run: { executor, dir: base.run.dir },
    })),
  ];
  const takeover = tasks.map((task) => ({
    task: JSON.parse(JSON.stringify(task)),
    result: takeoverAvailability(task as any),
  }));
  const row = { id: "native", title: "pacer t" };
  const wrapped = (depth: number): unknown =>
    depth === 0 ? row : { data: wrapped(depth - 1) };
  const lookup = [
    JSON.stringify(wrapped(6)),
    JSON.stringify(wrapped(7)),
    JSON.stringify({
      id: "parent",
      title: "pacer t",
      sessions: [{ id: "nested", title: "pacer t", updated: 100 }],
    }),
    JSON.stringify([
      { id: " a ", title: "pacer t", updated: "2026-01-01T00:00:00Z" },
      { id: "new", title: "pacer t", updatedAt: "2026-02-01T00:00:00Z" },
    ]),
    JSON.stringify([
      { id: "numeric", title: "pacer t", updated: "0x10" },
      { id: "decimal", title: "pacer t", time: { updated: 15, created: 1000 } },
    ]),
    JSON.stringify([
      { id: "bad-time", title: "pacer t", updated: "garbage" },
      { id: "positive", title: "pacer t", created: 1 },
    ]),
    "bad",
    "null",
    "[]",
    JSON.stringify([
      { id: " a ", title: "pacer t" },
      { id: "b", title: "pacer t", updated: "20" },
      { id: "c", title: "pacer t", updated: 10 },
    ]),
    JSON.stringify({
      data: {
        sessions: [
          { id: "old", title: "pacer t", updated: 1 },
          { id: "new", title: "pacer t", time: { updated: 2 } },
        ],
      },
    }),
    JSON.stringify([
      { id: "\ufeff", title: "pacer t" },
      { id: "\u0085", title: "pacer t" },
    ]),
    JSON.stringify([
      { id: "first", title: "pacer t", updated: 0 },
      { id: "second", title: "pacer t", updated: 0 },
    ]),
  ].map((text) => ({ text, result: parseOpencodeSessions(text, "t") ?? null }));
  const caller = [
    "task.session",
    "task.attach",
    "task.takeover",
    "task.hand_back",
    "session.prepare",
    "session.draft.create",
    "session.create",
    "session.resume",
    "session.end",
    "session.file.read",
    "terminal.create",
    "terminal.close",
  ].flatMap((name) =>
    [false, true].map((executor) => ({
      name,
      executor,
      result: attempt(() =>
        assertCallerCanInvoke(
          fakeCtx({ env: { PACER_ROLE: executor ? "executor" : "planner" } }),
          name,
          {},
        ),
      ),
    })),
  );
  const codec = [
    JSON.stringify({ type: "hello", v: 1, client: "cli", from: 9 }),
    JSON.stringify({ type: "take", force: true }),
    JSON.stringify({ type: "size", cols: 80, rows: 24 }),
    JSON.stringify({ type: "bogus" }),
    "bad",
    JSON.stringify({ type: "hello", v: 1 }),
    JSON.stringify({ type: "focus" }),
    JSON.stringify({ type: "deliver", text: "answer" }),
    JSON.stringify({ type: "hello", v: 1, versions: [1, 2], readOnly: true }),
  ].flatMap((message) =>
    [undefined, 0, 8].map((from) => ({
      message,
      ...(from === undefined ? {} : { from }),
      result: attempt(() =>
        viewerMessageFrames(message, from)
          .map((b) =>
            new WireDecoder().push(b).map((f) => ({
              type: f.type,
              body: JSON.parse(f.data.toString()),
            })),
          )
          .flat(),
      ),
    })),
  );
  const render = [
    {
      type: FrameType.snapshot,
      body: {
        scrollbackAnsi: "old",
        screenAnsi: "screen",
        cols: 100,
        rows: 30,
      },
    },
    { type: FrameType.exit, body: { code: 1, reason: "bad\u001b[31m\u0007" } },
    { type: FrameType.control, body: { you: true } },
  ].map(({ type, body }) => {
    const out: string[] = [],
      err: string[] = [];
    const detach = renderSessionFrame(
      type,
      Buffer.from(JSON.stringify(body)),
      {
        isTTY: true,
        columns: 80,
        rows: 24,
        write: (s: string) => out.push(s),
      } as any,
      { write: (s: string) => err.push(s) } as any,
    );
    return { type, body, out, err, detach };
  });
  const binary = [Buffer.from([0, 255, 27, 128]), Buffer.alloc(0)].map(
    (data) => ({
      hex: data.toString("hex"),
      out: Buffer.from(socketFrameMessage({ type: 3, data })).toString("hex"),
      input: viewerMessageFrames(wire(10, data))[0]!.toString("hex"),
    }),
  );
  const offsets = [
    0,
    1.0,
    1e2,
    -1,
    0.5,
    9007199254740991,
    9007199254740992,
    null,
    "1",
    true,
    {},
    [],
  ].map((value) => ({
    value,
    valid: Number.isSafeInteger(value) && (value as number) >= 0,
  }));
  const labels = [
    "",
    "a\u0000b\u007f",
    "x".repeat(63) + "😀",
    "😀".repeat(40),
    "\u0085\ufeff",
  ].map((label) => ({
    label,
    units: Array.from(
      { length: label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64).length },
      (_, i) => label.replace(/[\x00-\x1f\x7f]/g, "").charCodeAt(i),
    ),
  }));
  const queries = [
    "",
    "plain",
    "\u001b[?62;22c",
    "\u001b[>0;276;0c",
    "\u001b[?c",
    "\u001b[c",
    "a\u001b[?1;2cb\u001b[>1cc",
    "\u001b]10;rgb:ffff/ffff/ffff\u0007",
    "\u001b]11;rgb:0000/0000/0000\u001b\\",
    "\u001b]11;rgb:0000\u001bx",
    "\u001b]11;unterminated",
    "\u001b]12;rgb:0000/0000/0000\u0007",
    "\u001b[12;40R",
    "\u001b[?12;40R",
    "\u001b[?12;40;1R",
    "\u001b[>12;40R",
    "\u001b[1;2Rx\u001b[12R",
    "\u001b[A\u001b[?62;22",
    "\u00ff\u001b[?1c\u0080",
  ].flatMap((text) =>
    [false, true].map((cursor) => ({
      hex: Buffer.from(text, "latin1").toString("hex"),
      cursor,
      kept: stripQueryReplies(Buffer.from(text, "latin1"), cursor).toString("hex"),
    })),
  );
  // The pending-line heuristic that gates delivery (ADR 0023, decision 4): starting from `from` unsent characters,
  // how many remain and whether `bytes` added text.
  const pending = [
    { hex: "", from: 0 },
    { hex: "61", from: 0 },
    { hex: "6162", from: 2 },
    { hex: "6162 0d", from: 0 }, // "ab" Enter
    { hex: "6162 7f", from: 3 }, // "ab" DEL
    { hex: "7f 7f 7f", from: 0 }, // extra backspaces do not go below empty
    { hex: "c3 a9", from: 0 }, // "é" UTF-8, two bytes count once
    { hex: "c3 a9 7f", from: 1 }, // "é" then DEL
    { hex: "1b 5b 44", from: 5 }, // Esc [ D arrow: unchanged
    { hex: "1b 4f 41", from: 4 }, // Esc O A SS3: unchanged
    { hex: "1b 5d 39 3b 31 30 07", from: 2 }, // OSC: unchanged
    { hex: "1b", from: 3 }, // lone trailing Esc clears
    { hex: "61 1b", from: 1 }, // printable then lone Esc clears
    { hex: "61 1b 5b 44 62", from: 0 }, // "a" <- "b": arrow ignored, 2 typed
    { hex: "0d 0a", from: 3 }, // CR LF
    { hex: "03", from: 4 }, // Ctrl-C
    { hex: "15", from: 4 }, // Ctrl-U
    { hex: "0a", from: 4 }, // LF
    { hex: "61 08", from: 1 }, // "a" BS
    { hex: "61 62 62 62", from: 0 }, // multibyte ASCII burst
    { hex: "ef bb bf", from: 0 }, // BOM, each byte printable
  ].map(({ hex, from }) => {
    const bytes = Buffer.from(hex.replace(/\s+/g, ""), "hex");
    const line = pendingAfter(bytes, from);
    return {
      hex: hex.replace(/\s+/g, ""),
      from,
      result: { count: line.count, typed: line.typed },
    };
  });
  return {
    session,
    terminal,
    recipes,
    takeover,
    lookup,
    caller,
    codec,
    render,
    binary,
    offsets,
    labels,
    queries,
    pending,
  };
}
if (import.meta.main)
  writeFileSync(
    new URL(
      "../../test/fixtures/sessions/control-parity.json",
      import.meta.url,
    ),
    JSON.stringify(recordControl(), null, 2) + "\n",
  );

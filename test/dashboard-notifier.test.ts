import { expect, test } from "bun:test";
import { currentVersion } from "../src/update/version";
import {
  HEARTBEAT_MS,
  openTerminalNotifications,
  presentTerminalNotify,
  registerTuiNotifier,
  shouldPresentNotify,
  terminalNotifyLine,
  type IntervalClock,
} from "../src/dashboard/notifier";

const mine = "client-mine";

test("shouldPresentNotify follows recipients, then the legacy client id", () => {
  const body = { title: "Ready", body: "Detail" };
  expect(shouldPresentNotify({ ...body, recipients: [mine, "other"], client_id: "primary" }, mine)).toBe(true);
  expect(shouldPresentNotify({ ...body, recipients: ["other"], client_id: mine }, mine)).toBe(false);
  expect(shouldPresentNotify({ ...body, recipients: [], client_id: mine }, mine)).toBe(false);
  expect(shouldPresentNotify({ ...body, recipients: "mine", client_id: mine }, mine)).toBe(false);
  expect(shouldPresentNotify({ ...body, client_id: mine }, mine)).toBe(true);
  expect(shouldPresentNotify({ ...body, client_id: "other" }, mine)).toBe(false);
  expect(shouldPresentNotify({ ...body, recipients: null, client_id: mine }, mine)).toBe(true);
  expect(shouldPresentNotify({ ...body, recipients: null, client_id: "other" }, mine)).toBe(false);
  expect(shouldPresentNotify(null, mine)).toBe(false);
  expect(shouldPresentNotify("notify", mine)).toBe(false);
  expect(shouldPresentNotify({ ...body, client_id: mine }, "")).toBe(false);
});

test("presentTerminalNotify writes a bell and stays quiet when the stream fails", () => {
  const chunks: string[] = [];
  presentTerminalNotify({ write: chunk => { chunks.push(chunk); } }, { body: "Ready" }, { TERM: "dumb" });
  expect(chunks).toEqual(["\x07"]);
  expect(() => presentTerminalNotify({ write() { throw new Error("closed"); } }, { body: "Ready" }, { TERM: "dumb" })).not.toThrow();
});

test("presentTerminalNotify adds a clipped OSC 9 toast when the terminal looks capable", () => {
  const chunks: string[] = [];
  const sink = { write: (chunk: string) => { chunks.push(chunk); } };
  presentTerminalNotify(sink, { title: "Ready", body: "Detail" }, { TERM: "xterm-256color" });
  presentTerminalNotify(sink, { body: `a\x07b\x1b[31mc${"x".repeat(250)}` }, { TERM: "dumb", TERM_PROGRAM: "iTerm.app" });
  presentTerminalNotify(sink, { title: "Hello", body: "" }, { TERM_PROGRAM: "WezTerm" });
  expect(chunks[0]).toBe("\x07\x1b]9;Detail\x07");
  expect(chunks[1]).toBe(`\x07\x1b]9;ab[31mc${"x".repeat(200 - "ab[31mc".length)}\x07`);
  expect(chunks[2]).toBe("\x07\x1b]9;Hello\x07");
});

test("terminalNotifyLine is one visible status line", () => {
  expect(terminalNotifyLine({ title: "Ready", body: "Detail\nnext" })).toBe("Ready: Detailnext");
  expect(terminalNotifyLine({ title: "Ready" })).toBe("Ready");
  expect(terminalNotifyLine({ body: "Detail" })).toBe("Detail");
  expect(terminalNotifyLine(null)).toBe("");
});

test("registerTuiNotifier registers, heartbeats, and stop clears the timer", async () => {
  const calls: { op: string; params?: unknown }[] = [];
  let beat: (() => void) | undefined;
  let delay = 0;
  let timer: { unref?: () => void } | undefined;
  const cleared: unknown[] = [];
  const clock: IntervalClock = {
    setInterval(handler, ms) {
      beat = handler;
      delay = ms;
      timer = { unref() {} };
      return timer;
    },
    clearInterval(value) { cleared.push(value); },
  };
  const registered = await registerTuiNotifier(async (op, params) => {
    calls.push({ op, params });
    if (op === "client.heartbeat") throw new Error("down");
    return { client_id: mine, lease_s: 45 };
  }, clock);
  expect(registered.client_id).toBe(mine);
  expect(calls).toEqual([{ op: "client.register", params: { kind: "tui", version: currentVersion(), notifier: true } }]);
  expect(delay).toBe(HEARTBEAT_MS);
  expect(() => beat!()).not.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls[1]).toEqual({ op: "client.heartbeat", params: { client_id: mine } });
  registered.stop();
  expect(cleared).toEqual([timer]);
});

test("terminal notifications present each addressed notify the subscription delivers", () => {
  const chunks: string[] = [];
  const lines: string[] = [];
  let clientId: string | undefined;
  const notes = openTerminalNotifications({
    stdout: { write: chunk => { chunks.push(chunk); } },
    clientId: () => clientId,
    report: line => { lines.push(line); },
    env: { TERM: "dumb" },
  });
  notes.event({ type: "notify", data: { client_id: mine, title: "Early", body: "before register" } });
  clientId = mine;
  notes.event({ type: "notify", data: { client_id: mine, title: "Old", body: "backlog" } });
  notes.event({ type: "task", data: { client_id: mine, title: "Task", body: "x" } });
  notes.event({ type: "notify", data: { recipients: ["other"], client_id: mine, title: "Nope", body: "x" } });
  notes.event({ type: "notify", data: { recipients: [mine], client_id: "primary", title: "Ready", body: "Detail" } });
  expect(chunks).toEqual(["\x07", "\x07"]);
  expect(lines).toEqual(["Old: backlog", "Ready: Detail"]);
});

/**
 * B6-3 door-level parity driver for `setup.skip` and the four `notifications.*` ops.
 *
 * Every scenario runs against the real Rust `pacer api --stdio` front door with a
 * disposable HOME/PACER_HOME and NO Core child: before the port the driver gets
 * `unavailable`, after it the native door composes every reply. The seeded
 * `state/clients.json` is the live desktop registry the notification code reads.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closedPort, pinnedPort } from "./helpers";

const OPS = ["notifications.test", "notifications.ack", "notifications.request", "notifications.health", "setup.skip"];
// The front door needs a core argv at start-up even when every driven op is native.
const CORE = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const DESKTOP = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const APP = "00000000-0000-4000-8000-000000000003";
const FUTURE = 4102444800;

let binary = process.env.PACER_TEST_NATIVE_FRONT_DOOR ?? "";
const homes: string[] = [];

beforeAll(() => {
  if (binary) return;
  const env = pinnedPort({ ...process.env, PACER_PORT: String(closedPort()) });
  execFileSync("cargo", ["build", "-q", "-p", "pacer", "--locked", "--features", "test-ops"], { stdio: "inherit", env });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], { env }).toString());
  binary = join(metadata.target_directory, "debug/pacer");
});

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function home(entries: unknown[] = [], settings?: Record<string, unknown>) {
  const dir = mkdtempSync("/tmp/notif-");
  homes.push(dir);
  const pacerHome = join(dir, ".pacer");
  mkdirSync(join(pacerHome, "state"), { recursive: true, mode: 0o700 });
  if (entries.length) writeFileSync(join(pacerHome, "state", "clients.json"), JSON.stringify(entries));
  if (settings) writeFileSync(join(pacerHome, "settings.json"), JSON.stringify(settings));
  return { dir, pacerHome };
}

function entry(client_id: string, fields: Record<string, unknown> = {}) {
  return {
    client_id,
    kind: "desktop",
    version: "1",
    notifier: true,
    registeredAt: FUTURE,
    heartbeatAt: FUTURE,
    ...fields,
  };
}

async function door(pacerHome: string) {
  const child = Bun.spawn([binary, "api", "--stdio"], {
    cwd: pacerHome,
    env: pinnedPort({
      ...process.env,
      HOME: join(pacerHome, ".."),
      PACER_HOME: pacerHome,
      PACER_CORE_ARGV: CORE,
      PACER_NO_UPDATE_CHECK: "1",
      PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1",
      PACER_PORT: String(closedPort()),
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const waiting = new Map<number, (line: string) => void>();
  const reader = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const id = JSON.parse(line).id as number;
        waiting.get(id)?.(line);
        waiting.delete(id);
      }
    }
  })();
  let next = 1;
  const raw = async (method: string, params?: unknown) => {
    const id = next++;
    const reply = new Promise<string>(resolve => waiting.set(id, resolve));
    await child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n");
    await child.stdin.flush();
    return JSON.parse(await reply);
  };
  expect((await raw("hello", { protocol: 3 })).result.protocol).toBe("3.0.0");
  const call = async (op: string, params: unknown = {}) => {
    const line = await raw(op, params);
    return line.result !== undefined ? { result: line.result } : { error: line.error };
  };
  const close = async () => {
    await child.stdin.end();
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await reader;
    return (await stderr)
      .split("\n")
      .filter(line => /^native (notifications\.[a-z]+|setup\.skip) \d+$/.test(line))
      .map(line => line.split(" ")[1]);
  };
  return { call, close };
}

function outbox(pacerHome: string) {
  const text = readFileSync(join(pacerHome, "link/outbox.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line)["envelope"])
    .filter(Boolean);
}

function health(pacerHome: string) {
  const text = readFileSync(join(pacerHome, "state/notification-health.json"), "utf8");
  return JSON.parse(text);
}

test("notifications.test refuses with the app-closed hint when no desktop is live", async () => {
  const { dir, pacerHome } = home();
  const client = await door(pacerHome);
  try {
    expect(await client.call("notifications.test")).toEqual({
      error: expect.objectContaining({
        message: "The pacer app isn't open",
        data: expect.objectContaining({ code: "unavailable", hint: "Open the pacer app, then retry." }),
      }),
    });
    expect(await client.close()).toEqual(["notifications.test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("notifications.test names macOS when a non-presenter desktop is live", async () => {
  const { dir, pacerHome } = home([entry(DESKTOP, { notifier: false, notification_permission: "denied" })]);
  const client = await door(pacerHome);
  try {
    expect(await client.call("notifications.test")).toEqual({
      error: expect.objectContaining({
        message: "macOS blocks pacer notifications",
        data: expect.objectContaining({
          code: "unavailable",
          hint: "Turn on Allow notifications for pacer in System Settings › Notifications.",
        }),
      }),
    });
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("notifications.test stores a pending key and publishes one notify event", async () => {
  const { dir, pacerHome } = home([entry(DESKTOP)]);
  const client = await door(pacerHome);
  try {
    const reply = await client.call("notifications.test") as { result: { key: string; client_id: string; sent_at: number } };
    expect(reply.result.key).toMatch(/^test:/);
    expect(reply.result.client_id).toBe(DESKTOP);
    expect(health(pacerHome).key).toBe(reply.result.key);
    const notices = outbox(pacerHome).filter(event => event.type === "entity" && event.data.kind === "notify");
    expect(notices).toHaveLength(1);
    expect(notices[0].data.value.key).toBe(reply.result.key);
    expect(notices[0].data.value.recipients).toEqual([DESKTOP]);
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("notifications.ack enforces the desktop check and cleans stored errors", async () => {
  const { dir, pacerHome } = home([entry(DESKTOP), entry(OTHER, { notifier: false }), entry(APP, { kind: "app" })]);
  const client = await door(pacerHome);
  try {
    const sent = await client.call("notifications.test") as { result: { key: string } };
    const key = sent.result.key;
    expect(await client.call("notifications.ack", { client_id: APP, key, delivered: true })).toEqual({
      error: expect.objectContaining({
        message: "notifications.ack requires a live desktop client",
        data: expect.objectContaining({ code: "not_allowed" }),
      }),
    });
    expect(await client.call("notifications.ack", { client_id: OTHER, key, delivered: true })).toEqual({
      error: expect.objectContaining({
        message: "notifications.ack client mismatch",
        data: expect.objectContaining({ code: "not_allowed" }),
      }),
    });
    expect(await client.call("notifications.ack", { client_id: DESKTOP, key: "unknown", delivered: false, error: "boom\u001b[31m x\u0000y tail" })).toEqual({ result: { ok: true } });
    expect(health(pacerHome).last_error.message).toBe("boom[31m xy tail");
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("notifications.request targets the newest desktop and publishes a control event", async () => {
  const { dir, pacerHome } = home([
    entry(DESKTOP, { notifier: false, notification_permission: "denied" }),
    entry(OTHER, { notification_permission: "not_determined" }),
  ]);
  const client = await door(pacerHome);
  try {
    expect(await client.call("notifications.request", { wait_s: 0 })).toEqual({
      result: { client_id: OTHER, permission: "not_determined" },
    });
    const controls = outbox(pacerHome).filter(event => event.type === "entity" && event.data.kind === "control");
    expect(controls).toHaveLength(1);
    expect(controls[0].data.value).toEqual({
      action: "notifications.request",
      recipients: [OTHER],
      client_id: OTHER,
    });
    await client.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("notifications.health returns the doctor Check for no desktop, denied and tested", async () => {
  const none = home();
  const client = await door(none.pacerHome);
  try {
    expect(await client.call("notifications.health")).toEqual({
      result: {
        name: "Notifications",
        level: "info",
        detail: "The pacer app isn't open; banners come from the system fallback",
        evidence: "unverified",
      },
    });
    await client.close();
  } finally {
    rmSync(none.dir, { recursive: true, force: true });
  }

  const denied = home([entry(DESKTOP, { notification_permission: "denied" })]);
  const deniedDoor = await door(denied.pacerHome);
  try {
    expect(await deniedDoor.call("notifications.health")).toEqual({
      result: {
        name: "Notifications",
        level: "warn",
        detail: "Notifications are blocked in System Settings",
        remedy: {
          kind: "user",
          label: "Open Notification settings",
          url: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
          caption: "Turn on Allow notifications for pacer",
        },
      },
    });
    await deniedDoor.close();
  } finally {
    rmSync(denied.dir, { recursive: true, force: true });
  }

  const tested = home([entry(DESKTOP, { notification_permission: "authorized", notification_alerts: "banner" })]);
  writeFileSync(
    join(tested.pacerHome, "state/notification-health.json"),
    JSON.stringify({ key: "test:1", client_id: DESKTOP, sent_at: Date.now() / 1000 - 5, acked_at: Date.now() / 1000 - 1, delivered: true }),
  );
  const testedDoor = await door(tested.pacerHome);
  try {
    expect(await testedDoor.call("notifications.health")).toEqual({
      result: {
        name: "Notifications",
        level: "ok",
        detail: "Banners allowed · test delivered",
        evidence: "tested",
        tested_at: expect.any(Number),
      },
    });
    await testedDoor.close();
  } finally {
    rmSync(tested.dir, { recursive: true, force: true });
  }
}, 30000);

test("setup.skip keeps other settings and publishes a config event", async () => {
  const { dir, pacerHome } = home([], { notifications: "off", setup: { planner_done: true } });
  const client = await door(pacerHome);
  try {
    expect(await client.call("setup.skip", { step: "notifications" })).toEqual({ result: { skipped: true } });
    const settings = JSON.parse(readFileSync(join(pacerHome, "settings.json"), "utf8"));
    expect(settings.notifications).toBe("off");
    expect(settings.setup).toEqual({ planner_done: true, notifications_skipped: true });
    expect(outbox(pacerHome).some(event => event.type === "config" && event.data.area === "config")).toBe(true);
    expect(await client.call("setup.skip", { step: "x" })).toEqual({
      error: expect.objectContaining({
        message: 'step: Invalid input: expected "notifications"',
        data: expect.objectContaining({ code: "invalid_input" }),
      }),
    });
    expect(await client.close()).toEqual(["setup.skip", "setup.skip"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("all five operations are reachable in the v3 catalog", () => {
  const hello = JSON.parse(readFileSync("crates/server/src/stdio_hello.json", "utf8"));
  expect(OPS.filter(op => !hello.v3.ops.includes(op))).toEqual([]);
});

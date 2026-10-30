import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { down, liveRoot, up, type Session } from "../scripts/live/core";
import { authorizeSeedPluginRemove, ownedRemovalTree, REMOVE_LOCKS } from "../scripts/live/plugin-remove";
import { refusal } from "../scripts/live/guard";
import { refusedOp } from "../scripts/live/proxy";
import { REMOVE_FIXTURE_ID } from "../scripts/live/seed";

test("the seeded D8 exception removes only its exact fixture, once, through the public proxy", async () => {
  const session = await up(`remove-${randomUUID().slice(0, 8)}`, undefined, liveRoot, "plugin-remove");
  try {
    const base = `http://127.0.0.1:${session.port}`;
    const token = readFileSync(join(session.root, "home/token"), "utf8").trim();
    const headers = { Authorization: `Bearer ${token}`, Origin: base, "X-Pacer-Client": "app", "Content-Type": "application/json" };
    const fixture = join(session.root, "home/plugins", REMOVE_FIXTURE_ID);
    const remove = (id: string, path = "/v3/ops/plugin.remove", overrides: Record<string, string> = {}) =>
      fetch(base + path, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify({ id }) });

    expect(ownedRemovalTree(session.root)).toBe(true);
    expect((await remove(REMOVE_FIXTURE_ID, "/v2/ops/plugin.remove")).status).toBe(403);
    expect((await remove("fx-other")).status).toBe(403);
    const extraBody = await fetch(`${base}/v3/ops/plugin.remove`, { method: "POST", headers,
      body: JSON.stringify({ id: REMOVE_FIXTURE_ID, other: true }) });
    expect(extraBody.status).toBe(403);
    expect((await remove(REMOVE_FIXTURE_ID, "/v3/ops/plugin.remove?x=1")).status).toBe(403);
    expect((await remove(REMOVE_FIXTURE_ID, undefined, { Origin: "http://evil.invalid" })).status).toBe(403);
    expect(existsSync(join(session.root, "plugin-remove.claimed"))).toBe(false);

    const extra = join(fixture, "unexpected-link");
    symlinkSync(join(session.root, "home/token"), extra);
    expect(ownedRemovalTree(session.root)).toBe(false);
    expect((await remove(REMOVE_FIXTURE_ID)).status).toBe(403);
    unlinkSync(extra);
    expect(ownedRemovalTree(session.root)).toBe(true);

    // A held or planted plugins/plugin-settings lock means a concurrent edit or tampering.
    for (const name of REMOVE_LOCKS) {
      const lock = join(session.root, "home/orca", `${name}.lock`);
      writeFileSync(lock, "");
      expect(ownedRemovalTree(session.root)).toBe(false);
      expect((await remove(REMOVE_FIXTURE_ID)).status).toBe(403);
      unlinkSync(lock);
    }
    expect(ownedRemovalTree(session.root)).toBe(true);
    expect(existsSync(join(session.root, "plugin-remove.claimed"))).toBe(false);

    const strategy = join(session.root, "home/strategy.yaml");
    const saved = join(session.root, "strategy.saved");
    renameSync(strategy, saved);
    symlinkSync(saved, strategy);
    expect(ownedRemovalTree(session.root)).toBe(false);
    expect((await remove(REMOVE_FIXTURE_ID)).status).toBe(403);
    unlinkSync(strategy);
    renameSync(saved, strategy);
    expect(ownedRemovalTree(session.root)).toBe(true);

    // Session incarnation, header and body checks, called directly so no claim can be consumed.
    const direct = (overrides: Record<string, string> = {}, body = JSON.stringify({ id: REMOVE_FIXTURE_ID })) =>
      new Request(`${base}/v3/ops/plugin.remove`, { method: "POST", headers: { ...headers, ...overrides }, body });
    for (const changed of [
      { ...session, stopped: true }, { ...session, root: join(session.root, "home") },
      { ...session, innerPort: session.port }, { ...session, pid: process.pid, serviceIdentity: undefined },
    ] as Session[]) expect(await authorizeSeedPluginRemove(changed, direct())).toBe(false);
    for (const [overrides, body] of [
      [{ "X-Pacer-Client": "cli" }, undefined], [{ "Content-Type": "text/plain" }, undefined],
      [{}, JSON.stringify({ id: REMOVE_FIXTURE_ID }) + " ".repeat(300)], [{}, "not json"],
    ] as [Record<string, string>, string | undefined][]) expect(await authorizeSeedPluginRemove(session, direct(overrides, body))).toBe(false);
    expect(existsSync(join(session.root, "plugin-remove.claimed"))).toBe(false);

    const response = await remove(REMOVE_FIXTURE_ID);
    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual({ id: REMOVE_FIXTURE_ID, removed: true });
    expect(existsSync(fixture)).toBe(false);
    expect(existsSync(join(session.root, "plugin-remove.claimed"))).toBe(true);
    expect((await remove(REMOVE_FIXTURE_ID)).status).toBe(403);
    const list = await fetch(`${base}/v3/ops/plugin.list`, { method: "POST", headers, body: "{}" });
    expect(list.status).toBe(200);
    expect((await list.json()).result.plugins.some((plugin: { id: string }) => plugin.id === REMOVE_FIXTURE_ID)).toBe(false);
  } finally { await down(session); }
}, 20000);

test("the ordinary D8 refusal still covers plugin.remove outside the seeded fixture", async () => {
  expect(refusedOp("POST", "/v3/ops/plugin.remove")).toBe("plugin.remove");
  expect(refusedOp("POST", "/v2/ops/plugin.remove")).toBe("plugin.remove");
  expect(refusal(["plugin", "remove", REMOVE_FIXTURE_ID])).toContain("D3");
  expect(refusal(["api", "call", "plugin.remove", "--params", JSON.stringify({ id: REMOVE_FIXTURE_ID })])).toContain("D3");
  const root = join(liveRoot, "d8-refusal");
  const request = () => new Request("http://127.0.0.1:1/v3/ops/plugin.remove", {
    method: "POST", body: JSON.stringify({ id: REMOVE_FIXTURE_ID }),
    headers: { Origin: "http://127.0.0.1:1", "X-Pacer-Client": "app", "Content-Type": "application/json" },
  });
  for (const seed of [undefined, "ui"] as const) {
    const session = { id: "d8-refusal", root, port: 1, innerPort: 2, pid: 1, createdAt: "", seed } as Session;
    expect(await authorizeSeedPluginRemove(session, request())).toBe(false);
  }
  expect(existsSync(join(root, "plugin-remove.claimed"))).toBe(false);
});

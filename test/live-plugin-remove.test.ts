import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { down, liveRoot, up } from "../scripts/live/core";
import { ownedRemovalTree } from "../scripts/live/plugin-remove";
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

    const strategy = join(session.root, "home/strategy.yaml");
    const saved = join(session.root, "strategy.saved");
    renameSync(strategy, saved);
    symlinkSync(saved, strategy);
    expect(ownedRemovalTree(session.root)).toBe(false);
    expect((await remove(REMOVE_FIXTURE_ID)).status).toBe(403);
    unlinkSync(strategy);
    renameSync(saved, strategy);
    expect(ownedRemovalTree(session.root)).toBe(true);

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

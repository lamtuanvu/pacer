/** Fixed publication boundary fixture in a fresh child of the guarded sandbox home. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import { eventsSince, liveV2Snapshot } from "../../src/api/events";
import { parseOutboxEvent } from "../../src/link/envelope";
import { publish } from "../../src/link/publish";
import { currentSnapshot, readOutboxSince } from "../../src/link/store";
import { readEndpointState } from "../../src/endpoints/state";
import { endpointTestFromSpawn } from "../../test/fixtures/endpoint-test-fixtures";
import { healthy, record, type Session } from "./core";
import { settingsFixtureRoot } from "./settings";

function bounded(value: string, max: number): boolean {
  return value.length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}

export async function exercisePublicationHome(home: string): Promise<void> {
  mkdirSync(home, { mode: 0o700 });
  const strategy = {
    planner: "claude-code",
    accounts: {
      plan: { kind: "claude" },
      api: { kind: "endpoint", usage: "unmetered", connection: {
        api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "none",
        models: [{ id: "fixture", context: 8192, output: 1024, tools: true }],
      } },
    },
    routing: [{ default: ["opencode#api"] }],
  };
  const description = `${"s".repeat(999)}😀tail`;
  writeFileSync(join(home, "strategy.yaml"), `# ${description}\n${JSON.stringify(strategy)}\n`, { flag: "wx", mode: 0o600 });
  const ctx = { home, pacerHome: home, now: Date.now() / 1000,
    env: { HOME: home, PACER_HOME: home, PATH: process.env.PATH },
    which: () => null, run: async () => { throw Error("Publication fixture cannot run agent commands"); } };

  const alert = parseOutboxEvent({ type: "alert", data: {
    key: "boundary", level: "info", title: `${"t".repeat(116)}😀tail`,
    body: `${"b".repeat(996)}😀tail`, at: ctx.now,
  } });
  if (!alert || alert.type !== "alert") throw Error("Fixture alert did not parse");
  mkdirSync(join(home, "link"), { mode: 0o700 });
  const staleOutbox = join(home, "link/outbox.jsonl.tmp");
  const staleLatest = join(home, `link/latest.json.${process.pid}.tmp`);
  writeFileSync(staleOutbox, "stale", { flag: "wx", mode: 0o600 });
  writeFileSync(staleLatest, "stale", { flag: "wx", mode: 0o600 });
  const config = Array.from({ length: 1001 }, (_, i) => ({ type: "config" as const, data: { area: `fixture-${i}`, at: ctx.now } }));
  const result = await publish(ctx, [...config, alert]);
  if (result.errors.length || result.seq !== 1002) throw Error(`Fixture publication failed: ${result.errors.join(", ")}`);
  const latest = JSON.parse(readFileSync(join(home, "link/latest.json"), "utf8"));
  const outbox = readOutboxSince(ctx, 0);
  const api = await liveV2Snapshot(ctx);
  const event = eventsSince(ctx, 0).events.find(row => row.type === "alert");
  if (latest.seq !== 1002 || outbox.at(-1)?.seq !== 1002 ||
    latest.alerts[0]?.title !== alert.data.title || latest.alerts[0]?.body !== alert.data.body ||
    outbox.at(-1)?.envelope.type !== "alert" || !event ||
    !bounded(alert.data.title, 120) || !bounded(alert.data.body, 1000) ||
    !api.snapshot.alerts?.some(row => row.key === "boundary") ||
    readFileSync(staleOutbox, "utf8") !== "stale" || readFileSync(staleLatest, "utf8") !== "stale")
    throw Error("Alert publication boundary mismatch");

  const listed = currentSnapshot(ctx).strategies ?? [];
  const listedApi = await callOp(ctx, "snapshot.get", {});
  const strategyRow = listed.find(row => typeof row !== "string" && row.name === "default");
  if (!strategyRow || typeof strategyRow === "string" ||
    strategyRow.description !== "s".repeat(999) || !bounded(strategyRow.description, 1000) ||
    !JSON.stringify(listedApi).includes(strategyRow.description))
    throw Error("Strategy description boundary mismatch");

  const detail = `${"e".repeat(499)}😀tail`;
  const tested = await callOp(ctx, "account.test", { name: "api" }, { endpoint: {
    endpointTest: endpointTestFromSpawn(async () => ({ code: 1, stdout: "", stderr: detail, timedOut: false })),
  } }) as { state: string; detail?: string };
  const persisted = readEndpointState(ctx, "api");
  if (tested.state !== "not_working" || !tested.detail || tested.detail !== persisted.detail ||
    !bounded(tested.detail, 500) || tested.detail.includes("😀"))
    throw Error("Endpoint error boundary mismatch");
}

export async function exercisePublication(session: Session): Promise<void> {
  settingsFixtureRoot(session);
  if (!await healthy(session)) throw Error("Publication fixture requires a healthy guarded sandbox");
  try {
    await exercisePublicationHome(join(session.root, "home", "publication-fixture"));
    for (const behavior of ["Alert title/body truncation", "Strategy snapshot description truncation", "Endpoint error truncation"])
      record(session, { kind: "note", behavior, surface: "guarded TypeScript API fixture", verdict: "PASS",
        text: "Fixed fixture in owned sandbox home; ownership guards, real publisher, snapshot and account.test handler exercised." });
  } catch (error) {
    record(session, { kind: "note", behavior: "TypeScript publication boundaries", surface: "guarded TypeScript API fixture", verdict: "FAIL",
      text: "Fixed fixture failed; sandbox retained for inspection." });
    throw error;
  }
}

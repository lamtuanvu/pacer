#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { executorAvailableHandler, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as { available: boolean; malformed: boolean; malformedProgress?: boolean; stallStop?: boolean };
await serve({ manifest, input: stdinLines(), handlers: {
  ...executorAvailableHandler((_input, _signal) => fixture.malformed
    ? { available: true, reason: "fixture", unsafe: "unexpected" } as { available: boolean; reason: string }
    : { available: fixture.available, ...(!fixture.available ? { reason: "fixture unavailable" } : {}) }),
  "executor.run": (params, host, signal) => {
    if (signal.aborted || !host.progress) throw Error("run progress unavailable");
    const selected = params as { task: { rev: number } };
    host.progress(fixture.malformedProgress ? { kind: "progress", state: "done" } : {
      kind: "progress", expectRev: selected.task.rev,
      progress: { phase: "working", lastOutputAt: null, lastChangeAt: null,
        files: 0, commits: 0, logBytes: 0, host: "local", updatedAt: 1 },
    });
    return { status: "done", exitCode: 0, report: "fixture complete" };
  },
  "executor.stop": (_params, _host, signal) => fixture.stallStop
    ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }))
    : { code: 0, killed: true },
} });

#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { executorAvailableHandler, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as { available: boolean; malformed: boolean };
await serve({ manifest, input: stdinLines(), handlers: {
  ...executorAvailableHandler((_input, _signal) => fixture.malformed
    ? { available: true, reason: "fixture", unsafe: "unexpected" } as { available: boolean; reason: string }
    : { available: fixture.available, ...(!fixture.available ? { reason: "fixture unavailable" } : {}) }),
  "executor.sessionState": () => ({ live: false }),
} });

// test/plugins-protocol.test.ts
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostRangeAccepts, parseManifest, readManifestFile } from "../src/plugins/manifest";
import { CAPABILITY_METHODS, EXTENSION_METHODS, PLUGIN_PROTOCOL_VERSION, capabilityOf, helloResult, manifestSchema } from "../src/plugins/protocol";
import { tmpDir } from "./helpers";

const good = { id: "fx-good", version: "1.0.0", publisher: "pacer", host: "^1", capabilities: [{ name: "log" }] };

test("a manifest gets defaults and rejects bad ids, versions and capability names", () => {
  const m = manifestSchema.parse(good);
  expect(m).toMatchObject({ contributes: {}, reentrant: false, tier: "free" });
  expect(parseManifest({ ...good, id: "Bad Id" }).ok).toBe(false);
  expect(parseManifest({ ...good, version: "1" }).ok).toBe(false);
  expect(parseManifest({ ...good, capabilities: [{ name: "shell" }] }).ok).toBe(false);
  expect(parseManifest({ ...good, host: "later" }).ok).toBe(false);
});

test("host ranges accept the versions they name", () => {
  expect(hostRangeAccepts("^1", "1.0.0")).toBe(true);
  expect(hostRangeAccepts("^1", "1.4.2")).toBe(true);
  expect(hostRangeAccepts("^1.2", "1.1.0")).toBe(false);
  expect(hostRangeAccepts("^0", "1.0.0")).toBe(false);
  expect(hostRangeAccepts("~1.0", "1.1.0")).toBe(false);
  expect(hostRangeAccepts(">=1.0.0", "2.0.0")).toBe(true);
  expect(hostRangeAccepts("1.0.0", "1.0.1")).toBe(false);
  expect(hostRangeAccepts("*", "9.9.9")).toBe(true);
  expect(hostRangeAccepts("^1", PLUGIN_PROTOCOL_VERSION)).toBe(true);
});

test("manifest files report JSON and schema problems by text", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "pacer-plugin.json"), "{not json");
  const r = readManifestFile(join(dir, "pacer-plugin.json"));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("JSON");
  writeFileSync(join(dir, "pacer-plugin.json"), JSON.stringify(good));
  expect(readManifestFile(join(dir, "pacer-plugin.json"))).toMatchObject({ ok: true, manifest: { id: "fx-good" } });
  expect(readManifestFile(join(dir, "missing.json")).ok).toBe(false);
});

test("method tables preserve native identity, dispatch adapters and all extracted capabilities", () => {
  expect(Object.keys(EXTENSION_METHODS).sort()).toEqual(["agentSession.attachment", "agentSession.capabilities", "agentSession.identity", "agentSession.prepare", "classifier.adapters", "classifier.ask", "decision.decide", "diagnostic.ping", "endpoint.launchEnv", "endpoint.models", "endpoint.test", "executor.available", "hostRunner.check", "hostRunner.close", "hostRunner.fetch", "hostRunner.open", "hostRunner.run", "hostRunner.stream", "notifier.deliver", "observation.observe", "planner.check", "planner.detect", "planner.install", "planner.plan", "planner.preview", "planner.uninstall", "policy.before", "remoteCaller.identity", "usage.read"]);
  expect(EXTENSION_METHODS["diagnostic.ping"].deadlineMs).toBe(5000);
  expect(Object.keys(CAPABILITY_METHODS)).toContain("capability.config.get");
  expect(Object.keys(CAPABILITY_METHODS)).toContain("capability.log");
  expect(capabilityOf("capability.config.get")).toBe("config.get");
  expect(capabilityOf("capability.shell")).toBeNull();
  expect(helloResult.safeParse({ protocol: "1.0.0", id: "x", version: "1.0.0", contributes: [] }).success).toBe(true);
});

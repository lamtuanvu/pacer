import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import { fakeCtx } from "./helpers";
import { makeHome, type Home } from "./native-plugin-door";
import { BUNDLED } from "../plugins/bundled";

// Host-originated plugin extension calls (M3 S2): the two private kinds a native op
// uses before the registry moves to Rust (`snapshot` to read the registry, `extension`
// to call an extension point). No extension methods exist yet, so any method is
// refused until a consumer adds it (G2).

let home: Home | undefined;
afterEach(() => { home?.done(); home = undefined; });

function ctx() {
  home = makeHome();
  return fakeCtx({ home: home.home, pacerHome: home.state });
}

test("snapshot returns the registry entries with a null value", async () => {
  const reply = await pluginNativeRequest(ctx(), { kind: "snapshot" });
  expect(reply.error).toBeUndefined();
  expect(reply.value).toBeNull();
  const ids = (reply.entries as { id: string }[]).map(e => e.id);
  // The snapshot reflects the shipped bundled plugins, marked as bundled.
  for (const { manifest } of BUNDLED) {
    const entry = reply.entries.find((e: any) => e.id === manifest.id);
    expect(entry, manifest.id).toMatchObject({ id: manifest.id, bundled: true });
    expect(ids).toContain(manifest.id);
  }
});

test("an extension kind with no registered method is refused", async () => {
  const reply = await pluginNativeRequest(ctx(), {
    kind: "extension",
    id: "assistant-executor",
    method: "planner.check",
    params: {},
  });
  expect(reply.error).toMatchObject({
    code: "invalid_input",
    message: "invalid private plugin request",
  });
});

test("an extra key on either private kind is refused the same way", async () => {
  const snapshot = await pluginNativeRequest(ctx(), { kind: "snapshot", extra: true });
  expect(snapshot.error).toEqual({
    code: "invalid_input",
    message: "invalid private plugin request",
  });
  const extension = await pluginNativeRequest(ctx(), {
    kind: "extension",
    id: "assistant-executor",
    method: "planner.check",
    params: {},
    extra: true,
  });
  expect(extension.error).toEqual({
    code: "invalid_input",
    message: "invalid private plugin request",
  });
});
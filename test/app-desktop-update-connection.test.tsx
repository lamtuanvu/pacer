import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { readDesktopUpdateConnection } from "../app/src/data/desktop";
import { DesktopUpdateConnection } from "../app/src/screens/settings/DesktopUpdateConnection";

test("native update connection is read independently of the service snapshot", async () => {
  const calls: string[] = [];
  const status = await readDesktopUpdateConnection({ __TAURI__: { core: { invoke: async command => { calls.push(command); return { state: "unavailable", reason: "service-identity" }; } } } });
  expect(calls).toEqual(["desktop_update_connection"]);
  expect(status).toEqual({ state: "unavailable", reason: "service-identity" });
  expect(await readDesktopUpdateConnection({})).toBeNull();
});

test("connection diagnostics reject malformed or unknown native payloads", async () => {
  for (const value of [null, {}, { state: "available", reason: "secret" }, { state: "unknown", reason: null }]) {
    await expect(readDesktopUpdateConnection({ __TAURI__: { core: { invoke: async () => value } } })).rejects.toThrow("update connection");
  }
});

test("failed OTA identity is explicit and does not masquerade as a manual-update requirement", () => {
  const html = renderToString(<DesktopUpdateConnection connection={{ state: "unavailable", reason: "service-identity" }}/>);
  expect(html).toContain("Automatic desktop updates are unavailable");
  expect(html).toContain("connected service");
  expect(html).not.toContain("Download desktop app");
  expect(html).not.toContain("Restart to update");
  expect(html).toContain('role="status"');
});

test("native pending, available and unsupported states preserve explicit null reasons", async () => {
  for (const state of ["connecting", "available", "unsupported"] as const) {
    const value = { state, reason: null };
    expect(await readDesktopUpdateConnection({ __TAURI__: { core: { invoke: async () => value } } })).toEqual(value);
  }
});

test("older native shells report unknown-command failures instead of inventing update readiness", async () => {
  await expect(readDesktopUpdateConnection({ __TAURI__: { core: { invoke: async () => { throw new Error("unknown command"); } } } })).rejects.toThrow("unknown command");
});

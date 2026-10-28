import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { openDesktopTakeover, readDesktopUpdateConnection } from "../app/src/data/desktop";
import { DesktopUpdateConnection } from "../app/src/screens/settings/DesktopUpdateConnection";

test("native update connection is read independently of the service snapshot", async () => {
  const calls: [string, unknown][] = [];
  const status = await readDesktopUpdateConnection({ __TAURI__: { core: { invoke: async (command, args) => { calls.push([command, args]); return { state: "unavailable", reason: "service-identity" }; } } } });
  expect(calls).toEqual([["desktop_update_connection", { supports: ["service-takeover"] }]]);
  expect(status).toEqual({ state: "unavailable", reason: "service-identity" });
  expect(await readDesktopUpdateConnection({})).toBeNull();
});

test("supported takeover reason offers only the bundled shell page", async () => {
  const calls: string[] = [];
  const host = { __TAURI__: { core: { invoke: async (command: string) => { calls.push(command); return command === "desktop_update_connection" ? { state: "unavailable", reason: "service-takeover" } : undefined; } } } };
  const connection = await readDesktopUpdateConnection(host);
  expect(connection?.reason).toBe("service-takeover");
  const html = renderToString(<DesktopUpdateConnection connection={connection}/>);
  expect(html).toContain("The pacer service was replaced by another build. Automatic updates are paused.");
  expect(html).toContain("Use the app's service");
  await openDesktopTakeover(host);
  expect(calls).toEqual(["desktop_update_connection", "takeover_open"]);
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

test("settings identifies a different terminal build after a successful service connection", () => {
  const html = renderToString(<DesktopUpdateConnection connection={{ state: "available", reason: null, terminalCommandDifferent: true }}/>);
  expect(html).toContain("The terminal command and the service run different builds.");
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

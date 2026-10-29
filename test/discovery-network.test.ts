import { expect, test } from "bun:test";
import type { RunFn } from "../src/types";
import { fakeCtx } from "./helpers";
import { currentNetwork } from "../src/discovery/network";

function runner(map: Record<string, string>): RunFn {
  return async (argv: string[]) => {
    const key = argv.join(" ");
    return key in map ? { code: 0, stdout: map[key], stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
}

test("macOS: gateway from route, MAC from arp, SSID from ipconfig", async () => {
  const ctx = fakeCtx({ run: runner({
    "route -n get default": "   route to: default\n    gateway: 192.168.1.1\n  interface: en0\n",
    "arp -n 192.168.1.1": "? (192.168.1.1) at a4:2b:b0:11:22:33 on en0 ifscope [ethernet]\n",
    "ipconfig getsummary en0": "<dictionary> {\n  SSID : home-wifi\n}\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n!.label).toBe("home-wifi");
  expect(n!.key).toMatch(/^[0-9a-f]{32}$/);
});

test("macOS: a redacted SSID falls back to a neutral label with the same key rules", async () => {
  const ctx = fakeCtx({ run: runner({
    "route -n get default": "    gateway: 10.0.0.1\n  interface: en0\n",
    "arp -n 10.0.0.1": "? (10.0.0.1) at 0:11:22:33:44:55 on en0\n",
    "ipconfig getsummary en0": "  SSID : <redacted>\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n!.label).toMatch(/^Network [0-9a-f]{6}$/);
});

test("Linux: gateway from ip route, MAC from ip neigh, SSID from nmcli", async () => {
  const ctx = fakeCtx({ run: runner({
    "ip route show default": "default via 192.168.0.1 dev wlp2s0 proto dhcp metric 600\n",
    "ip neigh show 192.168.0.1": "192.168.0.1 dev wlp2s0 lladdr 11:22:33:44:55:66 REACHABLE\n",
    "nmcli -t -f active,ssid dev wifi": "no:other\nyes:office\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "linux" });
  expect(n!.label).toBe("office");
});

test("no gateway MAC means unknown network", async () => {
  const ctx = fakeCtx({ run: runner({ "route -n get default": "    gateway: 10.8.0.1\n  interface: utun3\n" }) });
  expect(await currentNetwork(ctx, { platform: "darwin" })).toBeNull();
});

test("an unsupported platform is an unknown network", async () => {
  expect(await currentNetwork(fakeCtx(), { platform: "win32" })).toBeNull();
});

test("the same gateway and SSID give the same key; a different SSID gives another", async () => {
  const base = { "route -n get default": "    gateway: 192.168.1.1\n  interface: en0\n", "arp -n 192.168.1.1": "? (192.168.1.1) at a4:2b:b0:11:22:33 on en0\n" };
  const a = await currentNetwork(fakeCtx({ run: runner({ ...base, "ipconfig getsummary en0": "  SSID : one\n" }) }), { platform: "darwin" });
  const b = await currentNetwork(fakeCtx({ run: runner({ ...base, "ipconfig getsummary en0": "  SSID : one\n" }) }), { platform: "darwin" });
  const c = await currentNetwork(fakeCtx({ run: runner({ ...base, "ipconfig getsummary en0": "  SSID : two\n" }) }), { platform: "darwin" });
  expect(a!.key).toBe(b!.key);
  expect(a!.key).not.toBe(c!.key);
});

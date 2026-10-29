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
    "/sbin/route -n get default": "   route to: default\n    gateway: 192.168.1.1\n  interface: en0\n",
    "/usr/sbin/arp -n 192.168.1.1": "? (192.168.1.1) at a4:2b:b0:11:22:33 on en0 ifscope [ethernet]\n",
    "/usr/sbin/ipconfig getsummary en0": "<dictionary> {\n  SSID : home-wifi\n}\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n!.label).toBe("home-wifi");
  expect(n!.iface).toBe("en0");
  expect(n!.key).toMatch(/^[0-9a-f]{32}$/);
});

test("macOS: every tool is called by absolute path with argv only, never through PATH", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ env: { PATH: "" }, run: async (argv: string[]) => {
    calls.push(argv);
    const out: Record<string, string> = {
      "/sbin/route": "    gateway: 192.168.1.1\n  interface: en0\n",
      "/usr/sbin/arp": "? (192.168.1.1) at a4:2b:b0:11:22:33 on en0\n",
      "/usr/sbin/ipconfig": "  SSID : home-wifi\n",
    };
    return argv[0] in out ? { code: 0, stdout: out[argv[0]], stderr: "" } : { code: 127, stdout: "", stderr: "" };
  } });
  expect((await currentNetwork(ctx, { platform: "darwin" }))!.label).toBe("home-wifi");
  expect(calls).toEqual([
    ["/sbin/route", "-n", "get", "default"],
    ["/usr/sbin/arp", "-n", "192.168.1.1"],
    ["/usr/sbin/ipconfig", "getsummary", "en0"],
  ]);
});

test("macOS: a redacted SSID falls back to a neutral label with the same key rules", async () => {
  const ctx = fakeCtx({ run: runner({
    "/sbin/route -n get default": "    gateway: 10.0.0.1\n  interface: en0\n",
    "/usr/sbin/arp -n 10.0.0.1": "? (10.0.0.1) at 0:11:22:33:44:55 on en0\n",
    "/usr/sbin/ipconfig getsummary en0": "  SSID : <redacted>\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n!.label).toMatch(/^Network [0-9a-f]{6}$/);
});

test("Linux: gateway from ip route, MAC from ip neigh, SSID from nmcli", async () => {
  const ctx = fakeCtx({ run: runner({
    "/usr/sbin/ip route show default": "default via 192.168.0.1 dev wlp2s0 proto dhcp metric 600\n",
    "/usr/sbin/ip neigh show 192.168.0.1": "192.168.0.1 dev wlp2s0 lladdr 11:22:33:44:55:66 REACHABLE\n",
    "/usr/bin/nmcli -t -f active,ssid dev wifi": "no:other\nyes:office\n",
  }) });
  const n = await currentNetwork(ctx, { platform: "linux", exists: p => p === "/usr/sbin/ip" });
  expect(n!.label).toBe("office");
  expect(n!.iface).toBe("wlp2s0");
});

test("Linux: ip is resolved by checking where it exists, and nmcli is called by absolute path", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async (argv: string[]) => {
    calls.push(argv);
    const out: Record<string, string> = {
      "/sbin/ip route show default": "default via 10.0.0.1 dev eth0 proto dhcp\n",
      "/sbin/ip neigh show 10.0.0.1": "10.0.0.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE\n",
    };
    const key = argv.join(" ");
    return key in out ? { code: 0, stdout: out[key], stderr: "" } : { code: 1, stdout: "", stderr: "" };
  } });
  const n = await currentNetwork(ctx, { platform: "linux", exists: p => p === "/sbin/ip" });
  expect(n).toMatchObject({ label: expect.stringMatching(/^Network [0-9a-f]{6}$/), iface: "eth0" });
  expect(calls).toEqual([
    ["/sbin/ip", "route", "show", "default"],
    ["/sbin/ip", "neigh", "show", "10.0.0.1"],
    ["/usr/bin/nmcli", "-t", "-f", "active,ssid", "dev", "wifi"],
  ]);
});

test("Linux: no ip binary means unknown network and runs nothing", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; } });
  expect(await currentNetwork(ctx, { platform: "linux", exists: () => false })).toBeNull();
  expect(calls).toEqual([]);
});

test("no gateway MAC means unknown network", async () => {
  const ctx = fakeCtx({ run: runner({ "/sbin/route -n get default": "    gateway: 10.8.0.1\n  interface: utun3\n" }) });
  expect(await currentNetwork(ctx, { platform: "darwin" })).toBeNull();
});

test("an unsupported platform is an unknown network", async () => {
  expect(await currentNetwork(fakeCtx(), { platform: "win32" })).toBeNull();
});

test("the same gateway and SSID give the same key; a different SSID gives another", async () => {
  const base = { "/sbin/route -n get default": "    gateway: 192.168.1.1\n  interface: en0\n", "/usr/sbin/arp -n 192.168.1.1": "? (192.168.1.1) at a4:2b:b0:11:22:33 on en0\n" };
  const a = await currentNetwork(fakeCtx({ run: runner({ ...base, "/usr/sbin/ipconfig getsummary en0": "  SSID : one\n" }) }), { platform: "darwin" });
  const b = await currentNetwork(fakeCtx({ run: runner({ ...base, "/usr/sbin/ipconfig getsummary en0": "  SSID : one\n" }) }), { platform: "darwin" });
  const c = await currentNetwork(fakeCtx({ run: runner({ ...base, "/usr/sbin/ipconfig getsummary en0": "  SSID : two\n" }) }), { platform: "darwin" });
  expect(a!.key).toBe(b!.key);
  expect(a!.key).not.toBe(c!.key);
});

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { RunFn } from "../src/types";
import { fakeCtx } from "./helpers";
import { currentNetwork, interfaceIPv4 } from "../src/discovery/network";

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
    ["/usr/sbin/ipconfig", "getsummary", "en0"],
    ["/usr/sbin/arp", "-n", "192.168.1.1"],
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

const ROUTE = { "/sbin/route -n get default": "   route to: default\n    gateway: 192.168.100.1\n  interface: en0\n" };
const summary = (ra: string, ssid = "home-wifi") => `<dictionary> {\n  Router : 192.168.100.1\n  RouterAdvertisement : ${ra}\n  SSID : ${ssid}\n}\n`;
const v2 = (identity: string, ssid = "") => createHash("sha256").update(`pacer-network/v2\0${identity}\0${ssid}`).digest("hex").slice(0, 32);

test("macOS: the router advertisement identifies the network without ARP", async () => {
  const calls: string[][] = [];
  const map: Record<string, string> = { ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::FEB2:D6FF:FEF4:17C7, length 176, hop limit 64, lifetime 1800s") };
  const ctx = fakeCtx({ run: async (argv: string[]) => { calls.push(argv); return runner(map)(argv, 0); } });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n).toEqual({ key: v2("ra:fe80::feb2:d6ff:fef4:17c7", "home-wifi"), label: "home-wifi", iface: "en0" });
  expect(calls.some(c => c[0] === "/usr/sbin/arp")).toBe(false);
});

test("macOS: a scoped router advertisement source drops its scope", async () => {
  const ctx = fakeCtx({ run: runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::1%en0, length 176") }) });
  expect((await currentNetwork(ctx, { platform: "darwin" }))!.key).toBe(v2("ra:fe80::1", "home-wifi"));
});

test("macOS: without a router advertisement the ARP MAC identifies the network", async () => {
  const ctx = fakeCtx({ run: runner({
    ...ROUTE,
    "/usr/sbin/ipconfig getsummary en0": "<dictionary> {\n  Router : 192.168.100.1\n  SSID : home-wifi\n}\n",
    "/usr/sbin/arp -n 192.168.100.1": "? (192.168.100.1) at fc:b2:d6:f4:17:c7 on en0 ifscope [ethernet]\n",
  }) });
  expect((await currentNetwork(ctx, { platform: "darwin" }))!.key).toBe(v2("mac:fc:b2:d6:f4:17:c7", "home-wifi"));
});

test("macOS: neither a router advertisement nor an ARP entry means unknown network", async () => {
  const ctx = fakeCtx({ run: runner({
    ...ROUTE,
    "/usr/sbin/ipconfig getsummary en0": "<dictionary> {\n  SSID : home-wifi\n}\n",
    "/usr/sbin/arp -n 192.168.100.1": "192.168.100.1 (192.168.100.1) -- no entry\n",
  }) });
  expect(await currentNetwork(ctx, { platform: "darwin" })).toBeNull();
});

test("macOS: non-link-local or malformed router advertisement sources are ignored", async () => {
  for (const ra of ["from 2001:db8::1, length 176", "from fe80::zz, length 176", "from fe80:::1, length 176", "from fe80::1::2, length 176", "from 192.168.100.1, length 176", "from fe80, length 176", "fe80::1"]) {
    const ctx = fakeCtx({ run: runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary(ra) }) });
    expect(await currentNetwork(ctx, { platform: "darwin" })).toBeNull();
  }
});

test("macOS: the same router advertisement gives the same key across calls", async () => {
  const map = { ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::feb2:d6ff:fef4:17c7, length 176", "<redacted>") };
  const a = await currentNetwork(fakeCtx({ run: runner(map) }), { platform: "darwin" });
  const b = await currentNetwork(fakeCtx({ run: runner(map) }), { platform: "darwin" });
  expect(a!.key).toBe(b!.key);
  expect(a!.key).toBe(v2("ra:fe80::feb2:d6ff:fef4:17c7"));
  expect(a!.label).toBe(`Network ${a!.key.slice(0, 6)}`);
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
  expect(n!.key).toBe(v2("mac:11:22:33:44:55:66", "office"));
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

test("the interface's first external IPv4 address and netmask feed the radio's on-link filter", () => {
  const v4 = (address: string, netmask: string, internal = false) => ({ address, netmask, family: "IPv4" as const, internal, mac: "00:00:00:00:00:00", cidr: null });
  const v6 = { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6" as const, internal: false, mac: "00:00:00:00:00:00", cidr: null, scopeid: 4 };
  const interfaces = { en0: [v6, v4("192.168.1.10", "255.255.255.0"), v4("192.168.1.11", "255.255.255.0")], lo0: [v4("127.0.0.1", "255.0.0.0", true)], en5: [v6] };
  expect(interfaceIPv4("en0", interfaces)).toEqual({ addr: "192.168.1.10", mask: "255.255.255.0" });
  expect(interfaceIPv4("lo0", interfaces)).toBeNull();
  expect(interfaceIPv4("en5", interfaces)).toBeNull();
  expect(interfaceIPv4("utun3", interfaces)).toBeNull();
});

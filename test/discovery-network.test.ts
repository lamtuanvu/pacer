import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { RunFn } from "../src/types";
import { fakeCtx } from "./helpers";
import { currentNetwork, interfaceIPv4, resetNetworkForTests } from "../src/discovery/network";

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
    ["/sbin/route", "-n", "get", "-inet6", "default"],
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
const group = (gw: string, ssid: string) => createHash("sha256").update(`pacer-network-group/v1\0${gw}\0${ssid}`).digest("hex").slice(0, 32);
const v2 = (identity: string, ssid = "") => createHash("sha256").update(`pacer-network/v2\0${identity}\0${ssid}`).digest("hex").slice(0, 32);

test("macOS: the router advertisement identifies the network without ARP", async () => {
  const calls: string[][] = [];
  const map: Record<string, string> = { ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::FEB2:D6FF:FEF4:17C7, length 176, hop limit 64, lifetime 1800s") };
  const ctx = fakeCtx({ run: async (argv: string[]) => { calls.push(argv); return runner(map)(argv, 0); } });
  const n = await currentNetwork(ctx, { platform: "darwin" });
  expect(n).toMatchObject({ key: v2("ra:fe80::feb2:d6ff:fef4:17c7", "home-wifi"), label: "home-wifi", iface: "en0", group: group("192.168.100.1", "home-wifi") });
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

const V6ROUTE = (gw: string) => ({ "/sbin/route -n get -inet6 default": `   route to: default\ndestination: default\n    gateway: ${gw}\n  interface: en0\n` });
const twoRAs = "<dictionary> {\n  Router : 192.168.100.1\n  RouterAdvertisement : from fe80::aaaa:bbbb, length 96\n  RouterAdvertisement : from fe80::1, length 176\n  SSID : home-wifi\n}\n";

test("macOS: with two router advertisement sources the default IPv6 router's identifies the network (S3)", async () => {
  const ctx = fakeCtx({ run: runner({ ...ROUTE, ...V6ROUTE("fe80::1%en0"), "/usr/sbin/ipconfig getsummary en0": twoRAs }) });
  expect((await currentNetwork(ctx, { platform: "darwin" }))!.key).toBe(v2("ra:fe80::1", "home-wifi"));
  // A Thread border router's advertisement shown alone still yields the default router.
  const only = fakeCtx({ run: runner({ ...ROUTE, ...V6ROUTE("fe80::1%en0"), "/usr/sbin/ipconfig getsummary en0": summary("from fe80::aaaa:bbbb, length 96") }) });
  expect((await currentNetwork(only, { platform: "darwin" }))!.key).toBe(v2("ra:fe80::1", "home-wifi"));
});

test("macOS: a default IPv6 route on another interface or through a global address is not used (S3)", async () => {
  for (const route of [{ "/sbin/route -n get -inet6 default": "    gateway: fe80::1%utun3\n  interface: utun3\n" }, V6ROUTE("2001:db8::1")]) {
    const ctx = fakeCtx({ run: runner({ ...ROUTE, ...route, "/usr/sbin/ipconfig getsummary en0": twoRAs }) });
    expect((await currentNetwork(ctx, { platform: "darwin" }))!.key).toBe(v2("ra:fe80::aaaa:bbbb", "home-wifi"));
  }
});

test("the network group is the gateway IPv4 and SSID, and only exists with an SSID (S3)", async () => {
  const late = fakeCtx({ run: runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": "  SSID : home-wifi\n", "/usr/sbin/arp -n 192.168.100.1": "? (192.168.100.1) at fc:b2:d6:f4:17:c7 on en0\n" }) });
  const early = fakeCtx({ run: runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::1, length 176") }) });
  const a = (await currentNetwork(late, { platform: "darwin" }))!, b = (await currentNetwork(early, { platform: "darwin" }))!;
  expect(a.key).not.toBe(b.key);
  expect(a.group).toBe(b.group!);
  expect(a.group).toBe(group("192.168.100.1", "home-wifi"));
  const wired = fakeCtx({ run: runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": "<dictionary> {\n  RouterAdvertisement : from fe80::1\n}\n" }) });
  expect((await currentNetwork(wired, { platform: "darwin" }))!.group).toBeUndefined();
});

test("Linux: nmcli's escaped colons in the SSID are unescaped (N6)", async () => {
  const ctx = fakeCtx({ run: runner({
    "/usr/sbin/ip route show default": "default via 192.168.0.1 dev wlp2s0\n",
    "/usr/sbin/ip neigh show 192.168.0.1": "192.168.0.1 dev wlp2s0 lladdr 11:22:33:44:55:66 REACHABLE\n",
    "/usr/bin/nmcli -t -f active,ssid dev wifi": "yes:cafe\\:guest\\\\x\n",
  }) });
  expect((await currentNetwork(ctx, { platform: "linux", exists: p => p === "/usr/sbin/ip" }))!.label).toBe("cafe:guest\\x");
});

const WLAN = {
  "/usr/sbin/ip route show default": "default via 192.168.0.1 dev wlp2s0 proto dhcp\n",
  "/usr/sbin/ip neigh show 192.168.0.1": "192.168.0.1 dev wlp2s0 lladdr 11:22:33:44:55:66 REACHABLE\n",
};
const has = (...paths: string[]) => (p: string) => p === "/usr/sbin/ip" || paths.includes(p);

test("Linux: a failed SSID probe on a wireless interface keeps the last network instead of a new key", async () => {
  resetNetworkForTests();
  const exists = has("/usr/bin/nmcli", "/sys/class/net/wlp2s0/wireless");
  const ok = await currentNetwork(fakeCtx({ run: runner({ ...WLAN, "/usr/bin/nmcli -t -f active,ssid dev wifi": "yes:office\n" }) }), { platform: "linux", exists });
  expect(ok!.key).toBe(v2("mac:11:22:33:44:55:66", "office"));
  // nmcli fails, then succeeds without an active line: both are "unknown this poll", not a network without an SSID.
  for (const nm of [{}, { "/usr/bin/nmcli -t -f active,ssid dev wifi": "no:other\n" }] as Record<string, string>[]) {
    expect(await currentNetwork(fakeCtx({ run: runner({ ...WLAN, ...nm }) }), { platform: "linux", exists })).toEqual(ok);
  }
  // The last network is reused only for the same router on the same interface.
  const other = { ...WLAN, "/usr/sbin/ip neigh show 192.168.0.1": "192.168.0.1 dev wlp2s0 lladdr 99:22:33:44:55:66 REACHABLE\n" };
  expect(await currentNetwork(fakeCtx({ run: runner(other) }), { platform: "linux", exists })).toBeNull();
});

test("Linux: a failed SSID probe with no last network is an unknown network", async () => {
  resetNetworkForTests();
  const exists = has("/usr/bin/nmcli", "/sys/class/net/wlp2s0/wireless");
  expect(await currentNetwork(fakeCtx({ run: runner(WLAN) }), { platform: "linux", exists })).toBeNull();
});

test("Linux: a wired interface needs no SSID, and without nmcli the key is consistently SSID-less", async () => {
  resetNetworkForTests();
  const wired = await currentNetwork(fakeCtx({ run: runner(WLAN) }), { platform: "linux", exists: has("/usr/bin/nmcli") });
  expect(wired!.key).toBe(v2("mac:11:22:33:44:55:66"));
  resetNetworkForTests();
  const noNm = await currentNetwork(fakeCtx({ run: runner(WLAN) }), { platform: "linux", exists: has("/sys/class/net/wlp2s0/wireless") });
  expect(noNm!.key).toBe(v2("mac:11:22:33:44:55:66"));
  expect(noNm!.group).toBeUndefined();
});

const HW_PORTS = (type: string) => ({ "/usr/sbin/networksetup -listallhardwareports": `\nHardware Port: Thunderbolt Bridge\nDevice: bridge0\n\nHardware Port: ${type}\nDevice: en0\nEthernet Address: a4:2b:b0:11:22:33\n` });

test("macOS: a failed ipconfig summary on a Wi-Fi port keeps the last network instead of an SSID-less one (N11)", async () => {
  resetNetworkForTests();
  const base = { ...ROUTE, ...V6ROUTE("fe80::1%en0") };
  const ok = await currentNetwork(fakeCtx({ run: runner({ ...base, "/usr/sbin/ipconfig getsummary en0": summary("from fe80::1, length 176") }) }), { platform: "darwin" });
  expect(ok!.key).toBe(v2("ra:fe80::1", "home-wifi"));
  expect(await currentNetwork(fakeCtx({ run: runner({ ...base, ...HW_PORTS("Wi-Fi") }) }), { platform: "darwin" })).toEqual(ok);
  resetNetworkForTests();
  expect(await currentNetwork(fakeCtx({ run: runner({ ...base, ...HW_PORTS("Wi-Fi") }) }), { platform: "darwin" })).toBeNull();
  // On a wired port a missing summary just means no SSID.
  const wired = await currentNetwork(fakeCtx({ run: runner({ ...base, ...HW_PORTS("USB 10/100/1000 LAN") }) }), { platform: "darwin" });
  expect(wired!.key).toBe(v2("ra:fe80::1"));
});

test("a new key continues only keys seen in the last 10 minutes with the same group and router kind (NS2)", async () => {
  resetNetworkForTests();
  const t0 = 1_800_000_000;
  const byRa = (ra: string) => runner({ ...ROUTE, ...V6ROUTE(`${ra}%en0`), "/usr/sbin/ipconfig getsummary en0": "  SSID : home-wifi\n" });
  const probe = (run: RunFn, now: number) => currentNetwork(fakeCtx({ run }), { platform: "darwin", now: () => now });
  const a = (await probe(byRa("fe80::1"), t0))!;
  expect(a).toMatchObject({ kind: "ra", gw: "192.168.100.1", continues: [] });
  const b = (await probe(byRa("fe80::2"), t0 + 60))!;
  expect(b.continues).toEqual([a.key]);
  // The gateway MAC is another kind of identity, so it continues nothing.
  const byMac = runner({ ...ROUTE, "/usr/sbin/ipconfig getsummary en0": "  SSID : home-wifi\n", "/usr/sbin/arp -n 192.168.100.1": "? (192.168.100.1) at fc:b2:d6:f4:17:c7 on en0\n" });
  expect((await probe(byMac, t0 + 120))!).toMatchObject({ kind: "mac", continues: [] });
  expect((await probe(byRa("fe80::3"), t0 + 60 + 600))!.continues).toEqual([b.key]);
  expect((await probe(byRa("fe80::4"), t0 + 3 * 86400))!.continues).toEqual([]);
});

test("the interface address on the gateway's subnet feeds the on-link filter (N17)", () => {
  const v4 = (address: string, netmask: string) => ({ address, netmask, family: "IPv4" as const, internal: false, mac: "00:00:00:00:00:00", cidr: null });
  const interfaces = { en0: [v4("10.8.0.5", "255.255.255.0"), v4("192.168.1.10", "255.255.255.0")] };
  expect(interfaceIPv4("en0", interfaces, "192.168.1.1")).toEqual({ addr: "192.168.1.10", mask: "255.255.255.0" });
  expect(interfaceIPv4("en0", interfaces, "172.16.0.1")).toEqual({ addr: "10.8.0.5", mask: "255.255.255.0" });
  expect(interfaceIPv4("en0", interfaces)).toEqual({ addr: "10.8.0.5", mask: "255.255.255.0" });
});

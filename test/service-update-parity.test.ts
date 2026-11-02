import { expect, test } from "bun:test";
import { normalizeBase } from "../src/update/fetch";
import { parseManifest, parseSha256Sums } from "../src/update/manifest";

const asset = { os: "linux", arch: "x64", file: "pacer-linux-x64", sha256: "a".repeat(64), size: 1 };
const companion = { name: "pacer-core", file: "pacer-core-linux-x64", sha256: "b".repeat(64), size: 1 };

// The JSON spelling matters: a Rust port must test the resulting JS number,
// rather than requiring serde_json's integer representation.
test("manifest sizes follow their distinct JavaScript integer checks", () => {
  const cases: [string, boolean, boolean][] = [
    ["1.0", true, true], ["1e2", true, true], ["0", false, false],
    ["-1", false, false], ["1.5", false, false],
    ["9007199254740991", true, true], ["9007199254740992", true, false],
    ["1e100", true, false], ["\"1\"", false, false], ["null", false, false],
  ];
  for (const [json, assetOk, companionOk] of cases) {
    const size = JSON.parse(json);
    const parseAsset = () => parseManifest({ version: "1.0.0", assets: [{ ...asset, size }] });
    const parseCompanion = () => parseManifest({ version: "1.0.0", assets: [{ ...asset, companions: [{ ...companion, size }] }] });
    if (assetOk) expect(parseAsset().assets[0].size).toBe(size);
    else expect(parseAsset).toThrow();
    if (companionOk) expect(parseCompanion().assets[0].companions?.[0].size).toBe(size);
    else expect(parseCompanion).toThrow();
  }
});

test("release base and checksum lines use ECMAScript trim whitespace", () => {
  const whitespace = ["\u0009", "\u000b", "\u000c", "\u0020", "\u00a0", "\u1680", ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)), "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\r", "\n"];
  for (const space of whitespace) {
    expect(normalizeBase(`${space}https://example.test/releases///${space}`)).toBe("https://example.test/releases");
    // Newline is the record separator, so test line trimming with other characters.
    if (space !== "\n" && space !== "\r") expect(parseSha256Sums(`${space}${"A".repeat(64)}  file${space}`).get("file")).toBe("a".repeat(64));
  }
  expect(() => normalizeBase("\u0085https://example.test")).toThrow();
});

import { binaryInFile, parseLaunchd, parseSystemd, plist, unit } from "../src/service";
import { fetchBytes } from "../src/update/fetch";
import { parseIdentity, signArgs } from "../src/update/signing";
import { fakeCtx } from "./helpers";

test("service registration goldens preserve quoting and environment", () => {
  const ctx = fakeCtx({ home: "/fixture/home & user", pacerHome: "/fixture/state", env: { PATH: "/bin:/tools", PACER_PORT: "1234" }, which: () => null });
  const argv = ["/fixture/pacer %$", "a\"b"];
  expect(plist(ctx, argv, "fixture.label")).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by pacer service -->
<plist version="1.0"><dict>
<key>Label</key><string>fixture.label</string>
<key>ProgramArguments</key><array><string>/fixture/pacer %$</string><string>a&quot;b</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>/fixture/home &amp; user</string><key>PATH</key><string>/bin:/tools</string><key>PACER_HOME</key><string>/fixture/state</string><key>PACER_PORT</key><string>1234</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Standard</string>
<key>StandardOutPath</key><string>/fixture/state/logs/serve.log</string><key>StandardErrorPath</key><string>/fixture/state/logs/serve.log</string>
</dict></plist>
`);
  expect(unit(ctx, argv)).toBe(`# Managed by pacer service
[Unit]
Description=Pacer serve
[Service]
ExecStart="/fixture/pacer %%$$" "a\\"b" "serve"
Environment="HOME=/fixture/home & user"
Environment="PATH=/bin:/tools"
Environment="PACER_HOME=/fixture/state"
Environment="PACER_PORT=1234"
Restart=always
RestartSec=10
KillMode=process
StandardOutput="append:/fixture/state/logs/serve.log"
StandardError="append:/fixture/state/logs/serve.log"
[Install]
WantedBy=default.target
`);
  expect(binaryInFile(plist(ctx, argv, "fixture.label"), "darwin")).toBe(argv[0]);
  expect(binaryInFile(unit(ctx, argv), "linux")).toBe(argv[0]);
});

test("manager status parsing and signing arguments are characterized", () => {
  expect(parseLaunchd("\tpid = 42\n\tlast exit code = -9\n")).toEqual({ pid: 42, lastExitCode: -9 });
  expect(parseSystemd("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nExecMainStatus=0\n")).toEqual({ loaded: true, running: true, pid: 42, lastExitCode: 0 });
  const hash = "A".repeat(40);
  expect(parseIdentity(`  1) ${hash} "pacer local code signing"\n`)).toBe(hash);
  expect(signArgs("/fixture/pacer", hash)).toEqual(["/usr/bin/codesign", "-f", "-s", hash, "-i", "dev.pacer.cli", "--options", "0", "-r", `=designated => identifier "dev.pacer.cli" and certificate leaf = H"${hash}"`, "/fixture/pacer"]);
  expect(() => signArgs("/fixture/pacer", "bad")).toThrow("invalid signing identity fingerprint");
});

test("fetch follows only safe redirects and enforces declared and streamed byte limits", async () => {
  const visited: string[] = [];
  const fetch = async (url: string) => { visited.push(url); return visited.length === 1 ? new Response(null, { status: 302, headers: { location: "/next" } }) : new Response("abc"); };
  expect(new TextDecoder().decode(await fetchBytes(fetch, "https://example.test/start", 3))).toBe("abc");
  expect(visited).toEqual(["https://example.test/start", "https://example.test/next"]);
  await expect(fetchBytes(async () => new Response(null, { status: 302, headers: { location: "http://example.test/" } }), "https://example.test/start")).rejects.toThrow("redirect must target https://");
  await expect(fetchBytes(async () => new Response("abc", { headers: { "content-length": "3" } }), "https://example.test/a", 2)).rejects.toThrow("exceeds 2 byte limit");
  await expect(fetchBytes(async () => new Response("abc"), "https://example.test/a", 2)).rejects.toThrow("exceeds 2 byte limit");
});

test("version comparison retains JavaScript number rounding", async () => {
  const { compareVersions } = await import("../src/update/version");
  expect(compareVersions("9007199254740992.0.0", "9007199254740993.0.0")).toBe(0);
  expect(compareVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBe(0);
  expect(Number.isNaN(compareVersions(`${"9".repeat(400)}.0.0`, `${"8".repeat(400)}.0.0`))).toBe(true);
});

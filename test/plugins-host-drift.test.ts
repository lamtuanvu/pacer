import { expect, test } from "bun:test";
import { hostFingerprint, matchesHostFingerprint } from "../src/plugins/host-drift";

test("host grants pin only the selected checkout and account home", () => {
  const host = {
    alias: "box", ssh: "box-ssh", maxTasks: 2, paused: false, session: "full" as const,
    repos: { "example.com/o/used": "/used", "example.com/o/other": "/other" },
    accounts: { used: { home: "/accounts/used" }, other: { home: "/accounts/other" } },
  };
  const pinned = hostFingerprint(host, ["/used", "/accounts/used"], true);
  expect(matchesHostFingerprint({ ...host, maxTasks: 7,
    session: "recording",
    repos: { ...host.repos, "example.com/o/other": "/changed" },
    accounts: { ...host.accounts, other: { home: "/changed" } } }, pinned)).toBe(true);
  expect(matchesHostFingerprint({ ...host, ssh: "replacement-ssh" }, pinned)).toBe(false);
  expect(matchesHostFingerprint({ ...host, paused: true }, pinned)).toBe(false);
  expect(matchesHostFingerprint({ ...host, repos: { ...host.repos, "example.com/o/used": "/changed" } }, pinned)).toBe(false);
  expect(matchesHostFingerprint({ ...host, accounts: { ...host.accounts, used: { home: "/changed" } } }, pinned)).toBe(false);
  expect(matchesHostFingerprint({ ...host, paused: true }, hostFingerprint(host))).toBe(true);
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { CLI_NIGHTLY_FEED_FILE, cliNightlyFeed, githubFeedFilePublisher, localFeedFilePublisher, publishCliNightly, type FeedFilePublisher } from "../scripts/release/cli-feed";

const NIGHTLY = "0.16.0-nightly.202611171700";
function feedRepo() {
  const gitDir = join(tmpDir(), "feed.git");
  const show = (name: string) => {
    const result = Bun.spawnSync(["git", "--git-dir", gitDir, "show", `desktop-updates:${name}`], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString() : null;
  };
  return { gitDir, show, publisher: localFeedFilePublisher(gitDir) };
}

test("the CLI nightly feed is the latest.json schema and accepts only nightly versions", () => {
  expect(CLI_NIGHTLY_FEED_FILE).toBe("cli-nightly.json");
  expect(cliNightlyFeed(NIGHTLY)).toBe(`{"version":"${NIGHTLY}"}\n`);
  for (const version of ["1.2.3", "1.2.3-rc.1", "0.16.0-nightly.1", "v0.16.0-nightly.202611171700"]) expect(() => cliNightlyFeed(version)).toThrow();
});

test("writes cli-nightly.json and keeps stable.json and nightly.json", async () => {
  const repo = feedRepo();
  await repo.publisher.compareAndSwap("stable.json", null, '{"version":"0.15.1"}\n');
  const afterStable = await repo.publisher.readFile("nightly.json");
  expect(afterStable.text).toBe(null);
  expect(afterStable.head).toMatch(/^[a-f0-9]{40}$/);
  await repo.publisher.compareAndSwap("nightly.json", afterStable.head, `{"version":"${NIGHTLY}"}\n`);
  await publishCliNightly(NIGHTLY, repo.publisher);
  expect(repo.show("cli-nightly.json")).toBe(`{"version":"${NIGHTLY}"}\n`);
  expect(repo.show("stable.json")).toBe('{"version":"0.15.1"}\n');
  expect(repo.show("nightly.json")).toBe(`{"version":"${NIGHTLY}"}\n`);
});

test("refuses a stable version", async () => {
  const repo = feedRepo();
  for (const version of ["0.16.0", "0.16.0-rc.1"]) await expect(publishCliNightly(version, repo.publisher)).rejects.toThrow();
  expect((await repo.publisher.readFile(CLI_NIGHTLY_FEED_FILE)).head).toBe(null);
});

test("refuses downgrade and treats an identical retry as a no-op", async () => {
  const repo = feedRepo();
  await publishCliNightly("0.16.0-nightly.202611181700", repo.publisher);
  const before = await repo.publisher.readFile(CLI_NIGHTLY_FEED_FILE);
  await expect(publishCliNightly(NIGHTLY, repo.publisher)).rejects.toThrow("downgrade");
  await publishCliNightly("0.16.0-nightly.202611181700", repo.publisher);
  expect(await repo.publisher.readFile(CLI_NIGHTLY_FEED_FILE)).toEqual(before);
  // A stable version in cli-nightly.json is never a valid previous feed.
  await repo.publisher.compareAndSwap(CLI_NIGHTLY_FEED_FILE, before.head, '{"version":"0.17.0"}\n');
  await expect(publishCliNightly("0.18.0-nightly.202611181700", repo.publisher)).rejects.toThrow();
});

test("lost CAS response recovers only when the exact feed is current", async () => {
  const repo = feedRepo();
  const lost: FeedFilePublisher = { ...repo.publisher, compareAndSwap: async (name, expected, text) => { await repo.publisher.compareAndSwap(name, expected, text); throw Error("lost response"); } };
  await publishCliNightly(NIGHTLY, lost);
  expect(repo.show(CLI_NIGHTLY_FEED_FILE)).toBe(`{"version":"${NIGHTLY}"}\n`);
  const conflict: FeedFilePublisher = { ...repo.publisher, compareAndSwap: async () => { throw Error("conflict"); } };
  await expect(publishCliNightly("0.16.0-nightly.202611181700", conflict)).rejects.toThrow("conflict");
  expect(repo.show(CLI_NIGHTLY_FEED_FILE)).toBe(`{"version":"${NIGHTLY}"}\n`);
});

test("local CAS lets only one of two competing writers win", async () => {
  const repo = feedRepo();
  const results = await Promise.allSettled([repo.publisher.compareAndSwap("a.json", null, "1\n"), repo.publisher.compareAndSwap("b.json", null, "2\n")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  await expect(repo.publisher.compareAndSwap("../x.json", null, "x\n")).rejects.toThrow();
});

test("GitHub feed file publisher reads a missing file as null and writes over the base tree", async () => {
  const fetchBefore = globalThis.fetch, requests: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (url.includes("/contents/")) return new Response("{}", { status: 404 });
    const value = url.includes("/git/ref/heads/") ? { object: { sha: "a".repeat(40) } } : url.endsWith("/repos/lamtuanvu/pacer") ? { node_id: "fixture-repository" } : url.includes("/git/commits/old") ? { tree: { sha: "oldtree" } } : url.endsWith("/git/blobs") ? { sha: "blob" } : url.endsWith("/git/trees") ? { sha: "tree" } : url.endsWith("/git/commits") ? { sha: "new" } : url.endsWith("/graphql") ? { data: { updateRefs: { clientMutationId: null } } } : {};
    return Response.json(value);
  }) as typeof fetch;
  try {
    const publisher = githubFeedFilePublisher("fixture-token", "release: cli nightly x");
    expect(await publisher.readFile(CLI_NIGHTLY_FEED_FILE)).toEqual({ head: "a".repeat(40), text: null });
    expect(requests.at(-1)!.url).toBe(`https://api.github.com/repos/lamtuanvu/pacer/contents/cli-nightly.json?ref=${"a".repeat(40)}`);
    await publisher.compareAndSwap(CLI_NIGHTLY_FEED_FILE, "old", cliNightlyFeed(NIGHTLY));
    expect(requests.find(r => r.url.endsWith("/git/trees"))!.body).toEqual({ base_tree: "oldtree", tree: [{ path: "cli-nightly.json", mode: "100644", type: "blob", sha: "blob" }] });
    expect(requests.find(r => r.url.endsWith("/git/commits"))!.body.message).toBe("release: cli nightly x");
    expect(requests.find(r => r.url.endsWith("/graphql"))!.body.variables.input.refUpdates).toEqual([{ name: "refs/heads/desktop-updates", beforeOid: "old", afterOid: "new", force: false }]);
  } finally { globalThis.fetch = fetchBefore; }
});

test("publish CLI requires the tagged release job and a token", () => {
  const script = join(import.meta.dir, "..", "scripts", "release", "cli-feed.ts");
  const dir = tmpDir();
  const run = (env: Record<string, string>, ...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: dir, ...env } });
  const job = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: `refs/tags/v${NIGHTLY}`, GITHUB_REPOSITORY: "lamtuanvu/pacer" };
  expect(run({}, "publish").exitCode).toBe(1);
  const outside = run({ GH_TOKEN: "x" }, "publish", NIGHTLY);
  expect(outside.exitCode).toBe(1);
  expect(outside.stderr.toString()).toContain("tagged release job");
  expect(run({ ...job, GITHUB_REF: "refs/tags/v0.16.0-nightly.202611171800", GH_TOKEN: "x" }, "publish", NIGHTLY).exitCode).toBe(1);
  const noToken = run(job, "publish", NIGHTLY);
  expect(noToken.exitCode).toBe(1);
  expect(noToken.stderr.toString()).toContain("GH_TOKEN");
  expect(run({ ...job, GITHUB_REF: "refs/tags/v0.16.0", GH_TOKEN: "x" }, "publish", "0.16.0").exitCode).toBe(1);
});

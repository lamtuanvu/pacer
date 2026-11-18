#!/usr/bin/env bun
import { resolve } from "node:path";
import { compareVersions } from "../../src/update/version";
import { isNightlyVersion } from "./nightly";

/** Every feed file lives on this branch of this repository. */
export const FEED_REPO = "lamtuanvu/pacer", FEED_BRANCH = "desktop-updates";
export const CLI_NIGHTLY_FEED_FILE = "cli-nightly.json";
const zero = "0".repeat(40), botSignoff = "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";

/** One file on the feed branch, written by compare-and-swap of the whole branch head. */
export interface FeedFilePublisher {
  /** `head` is the branch commit (null before the branch exists); `text` is null when the file is absent. */
  readFile(name: string): Promise<{ head: string | null; text: string | null }>;
  /** Commit `text` as `name` on top of `expected`, keeping every other file; fails if the branch moved. */
  compareAndSwap(name: string, expected: string | null, text: string): Promise<void>;
}

function feedFileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)) throw Error(`Invalid feed file name ${name}`);
  return name;
}

/** The CLI nightly feed has the same schema as the release `latest.json`. */
export function cliNightlyFeed(version: string): string {
  if (!isNightlyVersion(version)) throw Error(`The CLI nightly feed requires a nightly version (X.Y.Z-nightly.YYYYMMDDHHmm), not ${version}`);
  return JSON.stringify({ version }) + "\n";
}

function cliFeedVersion(text: string): string {
  const version = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof version !== "string" || !isNightlyVersion(version)) throw Error("The existing CLI nightly feed does not hold a nightly version");
  return version;
}

/** Promote `version` in cli-nightly.json: no downgrade, an identical retry is a no-op, a lost CAS response is recovered. */
export async function publishCliNightly(version: string, publisher: FeedFilePublisher): Promise<void> {
  const text = cliNightlyFeed(version);
  const previous = await publisher.readFile(CLI_NIGHTLY_FEED_FILE);
  if (previous.text !== null) {
    const old = cliFeedVersion(previous.text);
    if (compareVersions(old, version) > 0) throw Error("CLI nightly promotion cannot downgrade the nightly feed");
    if (previous.text === text) return;
    if (old === version) throw Error("CLI nightly immutable version conflict");
  }
  try { await publisher.compareAndSwap(CLI_NIGHTLY_FEED_FILE, previous.head, text); }
  catch (error) { if ((await publisher.readFile(CLI_NIGHTLY_FEED_FILE)).text !== text) throw error; }
}

/** Authenticated GitHub REST calls; `missing` turns a 404 into null. */
export function githubRequest(token: string, label: string) {
  return async function request(path: string, init: RequestInit = {}, missing = false): Promise<Response | null> {
    const response = await fetch(`https://api.github.com/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers } });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw Error(`${label} API failed (${response.status})`);
    return response;
  };
}

/** Feed files on GitHub: a new tree over the parent's tree, then a GraphQL `updateRefs` with the exact old head. */
export function githubFeedFilePublisher(token: string, message: string): FeedFilePublisher {
  if (!token) throw Error("Feed publication requires release authorization");
  const request = githubRequest(token, "Release feed");
  const json = async (path: string, body: unknown) => (await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))!.json();
  return {
    async readFile(name) {
      feedFileName(name);
      const ref = await request(`repos/${FEED_REPO}/git/ref/heads/${FEED_BRANCH}`, {}, true);
      if (!ref) return { head: null, text: null };
      const head = (await ref.json()).object.sha;
      if (!/^[a-f0-9]{40}$/.test(head)) throw Error("Invalid feed branch identity");
      const file = await request(`repos/${FEED_REPO}/contents/${name}?ref=${head}`, {}, true);
      if (!file) return { head, text: null };
      const value = await file.json();
      if (value.encoding !== "base64" || value.size > 256 * 1024) throw Error(`Invalid feed content in ${name}`);
      return { head, text: Buffer.from(value.content, "base64").toString("utf8") };
    },
    async compareAndSwap(name, expected, text) {
      feedFileName(name);
      const repository = await (await request(`repos/${FEED_REPO}`))!.json();
      const parent = expected ? await (await request(`repos/${FEED_REPO}/git/commits/${expected}`))!.json() : null;
      const blob = await json(`repos/${FEED_REPO}/git/blobs`, { content: Buffer.from(text).toString("base64"), encoding: "base64" });
      const tree = await json(`repos/${FEED_REPO}/git/trees`, { ...(parent ? { base_tree: parent.tree.sha } : {}), tree: [{ path: name, mode: "100644", type: "blob", sha: blob.sha }] });
      const commit = await json(`repos/${FEED_REPO}/git/commits`, { message, tree: tree.sha, parents: expected ? [expected] : [] });
      const response = await json("graphql", { query: "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}", variables: { input: { repositoryId: repository.node_id, refUpdates: [{ name: `refs/heads/${FEED_BRANCH}`, beforeOid: expected ?? zero, afterOid: commit.sha, force: false }] } } });
      if (response.errors || !response.data?.updateRefs) throw Error(`Feed compare-and-swap conflict on ${name}`);
    },
  };
}

/** Feed files in a local bare Git repository (created on first use); no network transport. */
export function localFeedFilePublisher(gitDir: string, message = "release: feed update"): FeedFilePublisher {
  gitDir = resolve(gitDir);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  let ready: Promise<void> | null = null;
  async function git(args: string[], stdin?: string, allowFailure = false): Promise<string | null> {
    await (ready ??= (async () => {
      const init = Bun.spawn(["git", "init", "--bare", "--quiet", gitDir], { stdout: "ignore", stderr: "pipe", env });
      if (await init.exited) throw Error("Cannot create the local feed repository");
    })());
    const child = Bun.spawn(["git", "--git-dir", gitDir, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code && !allowFailure) throw Error("Local feed git compare-and-swap failed");
    return code ? null : stdout;
  }
  const line = async (args: string[], stdin?: string) => (await git(args, stdin))!.trim();
  return {
    async readFile(name) {
      feedFileName(name);
      const head = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${FEED_BRANCH}`], undefined, true))?.trim() || null;
      return { head, text: head ? await git(["show", `${head}:${name}`], undefined, true) : null };
    },
    async compareAndSwap(name, expected, text) {
      feedFileName(name);
      const blob = await line(["hash-object", "-w", "--stdin"], text);
      // Keep every other feed file from the expected commit's tree.
      const others = expected ? (await git(["ls-tree", "-z", expected]))!.split("\0").filter(entry => entry && !entry.endsWith(`\t${name}`)) : [];
      const tree = await line(["mktree", "-z"], [...others, `100644 blob ${blob}\t${name}`].map(entry => entry + "\0").join(""));
      const commit = await line(["commit-tree", tree, ...(expected ? ["-p", expected] : [])], message);
      await git(["update-ref", `refs/heads/${FEED_BRANCH}`, commit, expected ?? zero]);
    },
  };
}

if (import.meta.main) {
  try {
    const [action, version, ...rest] = process.argv.slice(2);
    if (action !== "publish" || !version || rest.length > 0) throw Error("usage: cli-feed.ts publish <nightly-version>");
    cliNightlyFeed(version);
    if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "push" || process.env.GITHUB_REF !== `refs/tags/v${version}` || process.env.GITHUB_REPOSITORY !== FEED_REPO) throw Error("CLI nightly feed publication requires the tagged release job");
    const token = process.env.GH_TOKEN;
    if (!token) throw Error("CLI nightly feed publication requires GH_TOKEN");
    await publishCliNightly(version, githubFeedFilePublisher(token, `release: cli nightly ${version}\n\n${botSignoff}`));
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}

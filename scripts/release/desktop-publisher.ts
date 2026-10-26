import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DesktopPublisher } from "./desktop-feed";
import { stableVersion } from "./desktop-feed";

const repo = "lamtuanvu/pacer", branch = "desktop-updates", zero = "0".repeat(40);
const message = (version: string) => `release: desktop stable ${version}\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`;
/** Publication is called only by explicit release CI, never the native updater or a public operation. */
export function githubDesktopPublisher(version: string, token: string): DesktopPublisher {
  stableVersion(version);
  if (!token) throw Error("Desktop publication requires release authorization");
  async function request(path: string, init: RequestInit = {}, missing = false) {
    const response = await fetch(`https://api.github.com/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers } });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw Error(`Desktop release API failed (${response.status})`);
    return response;
  }
  const json = async (path: string, body: unknown) => (await request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))!.json();
  async function release() {
    const value = await (await request(`repos/${repo}/releases/tags/v${version}`))!.json();
    if (value.tag_name !== `v${version}` || value.draft || value.prerelease || !Number.isSafeInteger(value.id)) throw Error("Desktop release tag is unavailable or not stable");
    return value;
  }
  const assetName = (name: string) => {
    if (!new RegExp(`^(desktop-pacer-${version.replaceAll(".", "\\.")}-darwin-(aarch64|x86_64)(\\.app\\.tar\\.gz(\\.sig)?|\\.dmg)|desktop-release-${version.replaceAll(".", "\\.")}\\.json)$`).test(name)) throw Error("Unowned desktop asset name");
  };
  return {
    mode: "production",
    async readAsset(name) {
      assetName(name); const current = await release();
      const assets = current.assets.filter((a: { name: string }) => a.name === name);
      if (assets.length > 1) throw Error("Ambiguous immutable desktop asset");
      if (!assets.length) return null;
      if (!Number.isSafeInteger(assets[0].id) || assets[0].size > 512 * 1024 * 1024) throw Error("Invalid remote desktop asset");
      const response = await request(`repos/${repo}/releases/assets/${assets[0].id}`, { headers: { Accept: "application/octet-stream" } });
      const bytes = new Uint8Array(await response!.arrayBuffer());
      if (bytes.byteLength > 512 * 1024 * 1024) throw Error("Remote desktop asset too large");
      return bytes;
    },
    async createAsset(name, bytes) {
      assetName(name); const current = await release();
      const response = await fetch(`https://uploads.github.com/repos/${repo}/releases/${current.id}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: bytes as BodyInit,
      });
      if (!response.ok) throw Error(`Immutable desktop upload failed (${response.status})`);
    },
    async readFeed() {
      const ref = await request(`repos/${repo}/git/ref/heads/${branch}`, {}, true);
      if (!ref) return { head: null, feed: null };
      const head = (await ref.json()).object.sha;
      if (!/^[a-f0-9]{40}$/.test(head)) throw Error("Invalid desktop branch identity");
      const file = await request(`repos/${repo}/contents/stable.json?ref=${head}`, {}, true);
      if (!file) throw Error("Existing desktop branch has no stable feed");
      const value = await file.json();
      if (value.encoding !== "base64" || value.size > 256 * 1024) throw Error("Invalid desktop feed content");
      return { head, feed: Buffer.from(value.content, "base64").toString("utf8") };
    },
    async compareAndSwap(expected, feed) {
      const repository = await (await request(`repos/${repo}`))!.json();
      const parent = expected ? await (await request(`repos/${repo}/git/commits/${expected}`))!.json() : null;
      const blob = await json(`repos/${repo}/git/blobs`, { content: Buffer.from(feed).toString("base64"), encoding: "base64" });
      const tree = await json(`repos/${repo}/git/trees`, { ...(parent ? { base_tree: parent.tree.sha } : {}), tree: [{ path: "stable.json", mode: "100644", type: "blob", sha: blob.sha }] });
      const commit = await json(`repos/${repo}/git/commits`, { message: message(version), tree: tree.sha, parents: expected ? [expected] : [] });
      const response = await json("graphql", { query: "mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}", variables: { input: { repositoryId: repository.node_id, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: expected ?? zero, afterOid: commit.sha, force: false }] } } });
      if (response.errors || !response.data?.updateRefs) throw Error("Desktop feed compare-and-swap conflict");
    },
  };
}

/** Explicit fixture backend: only local assets and a local bare Git repository, no network transport. */
export async function localFixturePublisher(root: string, version: string): Promise<DesktopPublisher> {
  stableVersion(version); root = resolve(root);
  const assets = join(root, "assets"), gitDir = join(root, "feed.git");
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  async function git(args: string[], stdin?: string, allowFailure = false) {
    const child = Bun.spawn(["git", "--git-dir", gitDir, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code && !allowFailure) throw Error("Local fixture git compare-and-swap failed");
    return code ? null : stdout.trim();
  }
  if (!existsSync(gitDir)) {
    const p = Bun.spawn(["git", "init", "--bare", gitDir], { stdout: "ignore", stderr: "pipe" });
    if (await p.exited) throw Error("Cannot create fixture repository");
  }
  const path = (name: string) => { if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error("Invalid fixture asset name"); return join(assets, name); };
  return { mode: "fixture",
    async readAsset(name) { return existsSync(path(name)) ? readFileSync(path(name)) : null; },
    async createAsset(name, bytes) { writeFileSync(path(name), bytes, { flag: "wx", mode: 0o600 }); },
    async readFeed() { const head = await git(["rev-parse", "--verify", `refs/heads/${branch}`], undefined, true); return { head, feed: head ? (await git(["show", `${head}:stable.json`]))! + "\n" : null }; },
    async compareAndSwap(expected, feed) {
      const blob = await git(["hash-object", "-w", "--stdin"], feed);
      const tree = await git(["mktree"], `100644 blob ${blob}\tstable.json\n`);
      const commit = await git(["commit-tree", tree!, ...(expected ? ["-p", expected] : [])], message(version));
      await git(["update-ref", `refs/heads/${branch}`, commit!, expected ?? zero]);
    },
  };
}

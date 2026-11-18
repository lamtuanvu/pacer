import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DesktopChannel, DesktopPublisher } from "./desktop-feed";
import { channelVersion, DESKTOP_FEED_FILE } from "./desktop-feed";
import { FEED_REPO as repo, githubFeedFilePublisher, githubRequest, localFeedFilePublisher, type FeedFilePublisher } from "./cli-feed";

const message = (channel: DesktopChannel, version: string) => `release: desktop ${channel} ${version}\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`;
/** Publication is called only by explicit release CI, never the native updater or a public operation. */
export function githubDesktopPublisher(version: string, token: string, channel: DesktopChannel = "stable"): DesktopPublisher {
  channelVersion(channel, version);
  const feedFile = DESKTOP_FEED_FILE[channel];
  if (!token) throw Error("Desktop publication requires release authorization");
  const request = githubRequest(token, "Desktop release"), feeds = githubFeedFilePublisher(token, message(channel, version));
  async function release() {
    const value = await (await request(`repos/${repo}/releases/tags/v${version}`))!.json();
    // A stable release is never a GitHub prerelease, and a nightly release always is.
    if (value.tag_name !== `v${version}` || value.draft || value.prerelease !== (channel === "nightly") || !Number.isSafeInteger(value.id)) throw Error(`Desktop release tag is unavailable or not ${channel}`);
    return value;
  }
  const ownedAssets = new Set([
    ...["aarch64", "x86_64"].flatMap(arch => [".app.tar.gz", ".app.tar.gz.sig", ".dmg"].map(suffix => `desktop-pacer-${version}-darwin-${arch}${suffix}`)),
    `desktop-release-${version}.json`,
  ]);
  const assetName = (name: string) => {
    if (!ownedAssets.has(name)) throw Error("Unowned desktop asset name");
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
    readFeed: () => readFeed(feeds, channel),
    compareAndSwap: (expected, feed) => feeds.compareAndSwap(feedFile, expected, feed),
  };
}

/** The channel's feed file. The branch starts with stable.json; the first nightly promotion creates nightly.json. */
async function readFeed(feeds: FeedFilePublisher, channel: DesktopChannel): Promise<{ head: string | null; feed: string | null }> {
  const { head, text } = await feeds.readFile(DESKTOP_FEED_FILE[channel]);
  if (head && text === null && channel === "stable") throw Error("Existing desktop branch has no stable feed");
  return { head, feed: text };
}

/** Explicit fixture backend: only local assets and a local bare Git repository, no network transport. */
export async function localFixturePublisher(root: string, version: string, channel: DesktopChannel = "stable"): Promise<DesktopPublisher> {
  channelVersion(channel, version); root = resolve(root);
  const feedFile = DESKTOP_FEED_FILE[channel];
  const assets = join(root, "assets"), gitDir = join(root, "feed.git");
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  const feeds = localFeedFilePublisher(gitDir, message(channel, version));
  const path = (name: string) => { if (!/^[A-Za-z0-9._-]+$/.test(name)) throw Error("Invalid fixture asset name"); return join(assets, name); };
  return { mode: "fixture",
    async readAsset(name) { return existsSync(path(name)) ? readFileSync(path(name)) : null; },
    async createAsset(name, bytes) { writeFileSync(path(name), bytes, { flag: "wx", mode: 0o600 }); },
    readFeed: () => readFeed(feeds, channel),
    compareAndSwap: (expected, feed) => feeds.compareAndSwap(feedFile, expected, feed),
  };
}

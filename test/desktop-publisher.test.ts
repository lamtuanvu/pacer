import { expect, test } from "bun:test";
import { githubDesktopPublisher } from "../scripts/release/desktop-publisher";

test("GitHub feed promotion uses exact old commit CAS and immutable asset creation without overwrite", async () => {
  const fetchBefore = globalThis.fetch, requests: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const value = url.endsWith("/repos/lamtuanvu/pacer") ? { node_id: "fixture-repository" } : url.includes("/git/commits/old") ? { tree: { sha: "oldtree" } } : url.endsWith("/git/blobs") ? { sha: "blob" } : url.endsWith("/git/trees") ? { sha: "tree" } : url.endsWith("/git/commits") ? { sha: "new" } : url.endsWith("/graphql") ? { data: { updateRefs: { clientMutationId: null } } } : url.includes("/releases/tags/") ? { id: 1, tag_name: "v1.2.3", draft: false, prerelease: false } : { id: 2 };
    return Response.json(value);
  }) as typeof fetch;
  try {
    const publisher = githubDesktopPublisher("1.2.3", "fixture-token");
    await publisher.compareAndSwap("old", '{"version":"1.2.3"}');
    const ref = requests.find(r => r.url.endsWith("/graphql"))!.body.variables.input;
    expect(ref).toEqual({ repositoryId: "fixture-repository", refUpdates: [{ name: "refs/heads/desktop-updates", beforeOid: "old", afterOid: "new", force: false }] });
    expect(requests.find(r => r.url.endsWith("/git/commits"))!.body.parents).toEqual(["old"]);
    await publisher.createAsset("desktop-pacer-1.2.3-darwin-aarch64.app.tar.gz", new Uint8Array([1]));
    expect(requests.at(-1)!.url).toBe("https://uploads.github.com/repos/lamtuanvu/pacer/releases/1/assets?name=desktop-pacer-1.2.3-darwin-aarch64.app.tar.gz");
    expect(requests.at(-1)!.method).toBe("POST");
    await publisher.createAsset("desktop-pacer-1.2.3-darwin-aarch64.dmg", new Uint8Array([1]));
    expect(requests.at(-1)!.url).toBe("https://uploads.github.com/repos/lamtuanvu/pacer/releases/1/assets?name=desktop-pacer-1.2.3-darwin-aarch64.dmg");
    await expect(publisher.createAsset("desktop-pacer-1.2.3-darwin-aarch64.dmg.sig", new Uint8Array([1]))).rejects.toThrow("Unowned");
    await expect(publisher.createAsset("pacer-darwin-arm64", new Uint8Array([1]))).rejects.toThrow("Unowned");
    expect(requests.some(r => r.method === "DELETE" || r.method === "PATCH")).toBe(false);
  } finally { globalThis.fetch = fetchBefore; }
});

const NIGHTLY = "1.3.0-nightly.202611170000";
function mockGitHub(release: { tag_name: string; prerelease: boolean }) {
  const requests: { url: string; method: string; body: any }[] = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const value = url.endsWith("/repos/lamtuanvu/pacer") ? { node_id: "fixture-repository" } : url.includes("/git/commits/old") ? { tree: { sha: "oldtree" } } : url.endsWith("/git/blobs") ? { sha: "blob" } : url.endsWith("/git/trees") ? { sha: "tree" } : url.endsWith("/git/commits") ? { sha: "new" } : url.endsWith("/graphql") ? { data: { updateRefs: { clientMutationId: null } } } : url.includes("/releases/tags/") ? { id: 1, draft: false, ...release } : { id: 2 };
    return Response.json(value);
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = fetchBefore; } };
}

test("nightly publisher accepts a prerelease and writes nightly.json", async () => {
  const mock = mockGitHub({ tag_name: `v${NIGHTLY}`, prerelease: true });
  try {
    const publisher = githubDesktopPublisher(NIGHTLY, "fixture-token", "nightly");
    await publisher.createAsset(`desktop-pacer-${NIGHTLY}-darwin-aarch64.app.tar.gz`, new Uint8Array([1]));
    expect(mock.requests.at(-1)!.url).toBe(`https://uploads.github.com/repos/lamtuanvu/pacer/releases/1/assets?name=desktop-pacer-${NIGHTLY}-darwin-aarch64.app.tar.gz`);
    await publisher.compareAndSwap("old", `{"version":"${NIGHTLY}"}`);
    const tree = mock.requests.find(r => r.url.endsWith("/git/trees"))!.body;
    expect(tree.base_tree).toBe("oldtree");
    expect(tree.tree.map((entry: { path: string }) => entry.path)).toEqual(["nightly.json"]);
    expect(mock.requests.find(r => r.url.endsWith("/git/commits"))!.body.message.split("\n")[0]).toBe(`release: desktop nightly ${NIGHTLY}`);
  } finally { mock.restore(); }
});

test("stable publisher still refuses a prerelease and nightly publisher refuses a non-prerelease", async () => {
  const stable = mockGitHub({ tag_name: "v1.2.3", prerelease: true });
  try {
    await expect(githubDesktopPublisher("1.2.3", "fixture-token").createAsset("desktop-pacer-1.2.3-darwin-aarch64.dmg", new Uint8Array([1]))).rejects.toThrow();
    expect(stable.requests.some(r => new URL(r.url).origin === "https://uploads.github.com")).toBe(false);
  } finally { stable.restore(); }
  const nightly = mockGitHub({ tag_name: `v${NIGHTLY}`, prerelease: false });
  try {
    await expect(githubDesktopPublisher(NIGHTLY, "fixture-token", "nightly").createAsset(`desktop-pacer-${NIGHTLY}-darwin-aarch64.dmg`, new Uint8Array([1]))).rejects.toThrow();
    expect(nightly.requests.some(r => new URL(r.url).origin === "https://uploads.github.com")).toBe(false);
  } finally { nightly.restore(); }
  expect(() => githubDesktopPublisher(NIGHTLY, "fixture-token")).toThrow();
  expect(() => githubDesktopPublisher("1.2.3", "fixture-token", "nightly")).toThrow();
  expect(() => githubDesktopPublisher("1.2.3-beta.1", "fixture-token", "nightly")).toThrow();
});

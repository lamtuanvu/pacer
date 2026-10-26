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

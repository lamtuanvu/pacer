import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { RepoFilter } from "../../app/src/screens/RepoFilter";
import { resolveRoute } from "../../app/src/router";
import type { ClientSnapshot } from "../../src/view-model/snapshot";
import fixture from "./ui/snapshot.json";

const names = ["node", "node-app-did", "economy-devtools-node-device", "node-app-device-lifecycle", "node-app-agent-peer", "node-app-agent", "empty-repo", "a".repeat(100)];
const repos = names.map(name => ({ key: `github.com/econ-v1/${name}`, label: `econ-v1/${name}`, path: `/tmp/repo-filter/${name}` }));
const snapshot: ClientSnapshot = {
  ...fixture as unknown as ClientSnapshot,
  repos,
  counts: { ...fixture.counts, byRepo: Object.fromEntries(repos.map((repo, index) => [repo.key, { attention: [32, 4, 2, 2, 2, 1, 0, 40][index], running: 0, review: 0 }])) },
};

function Preview() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  const route = resolveRoute(hash);
  return <main>
    <h1>Repository filter</h1>
    <RepoFilter snapshot={snapshot} query={"query" in route ? route.query : { repo: null, scope: null }} />
    <a href="#/sessions" className="pc-inline-link">Next section</a>
  </main>;
}

render(<Preview />, document.getElementById("root")!);

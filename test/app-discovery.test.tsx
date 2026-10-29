import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { DiscoveryNoticeView, discoveryNoticeFrom } from "../app/src/shell/DiscoveryNotice";
import { PairingView } from "../app/src/screens/settings/Pairing";
import { DiscoveryView, networkStateLine } from "../app/src/screens/settings/Discovery";
import { resolveRoute, titleFor, type Route } from "../app/src/router";
import { settingsNavId } from "../app/src/settings-pages";
import { reduceStore } from "../app/src/data/store";

const id = "a".repeat(26);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
const primaries = (html: string) => html.match(/pc-btn--primary/g)?.length ?? 0;

test("found-machine card shows the unverified name and four actions with Pair primary", () => {
  const html = renderToString(<DiscoveryNoticeView found={{ discoveryId: id, name: "studio-mac" }} network={null} onAction={() => {}} />);
  expect(html).toContain("studio-mac");
  expect(html).toContain("Unverified name");
  expect(buttons(html)).toEqual(["Pair", "Later", "Not mine", "Stop on this network"]);
  expect(primaries(html)).toBe(1);
  expect(html).toMatch(/class="pc-btn pc-btn--primary[^"]*"[^>]*>Pair</);
  // The discovery id appears only inside a collapsed Details disclosure.
  const details = /<details[^>]*>(.*?)<\/details>/s.exec(html);
  expect(details?.[0]).not.toContain(" open");
  expect(details?.[1]).toContain("<summary>Details</summary>");
  expect(details?.[1]).toContain(id);
  expect(html.replace(details![0], "")).not.toContain(id);
});

test("discovered names render as text and never become links", () => {
  const name = '<img src=x onerror=alert(1)>javascript:x';
  const html = renderToString(<DiscoveryNoticeView found={{ discoveryId: id, name }} network={null} onAction={() => {}} />);
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("href=");
});

test("network question shows the advertised name, a Change name link and Allow primary", () => {
  const html = renderToString(<DiscoveryNoticeView found={null} network={{ key: "k1", label: "home-wifi", name: "pacer-k3x9", rev: 2 }} onAction={() => {}} />);
  expect(html).toContain("Let your other machines find this one on home-wifi?");
  expect(html).toContain("pacer-k3x9");
  expect(html).toContain("It will appear as <strong>pacer-k3x9</strong>.");
  expect(html).toMatch(/<a [^>]*href="#\/settings\/machine"[^>]*>Change name<\/a>/);
  expect(buttons(html)).toEqual(["Allow", "Not on this network"]);
  expect(primaries(html)).toBe(1);
});

test("one prompt at a time: a found machine comes before the network question", () => {
  const html = renderToString(<DiscoveryNoticeView found={{ discoveryId: id, name: "studio-mac" }} network={{ key: "k1", label: "home-wifi", name: "pacer-k3x9", rev: 2 }} onAction={() => {}} />);
  expect(html).toContain("studio-mac"); expect(html).not.toContain("home-wifi");
  expect(renderToString(<DiscoveryNoticeView found={null} network={null} onAction={() => {}} />)).toBe("");
});

test("prompts come from attention items matched to discovery.list", () => {
  const list = { available: true, enabled: true, rev: 1, networksRev: 4,
    network: { key: "k1", label: "home-wifi", advertise: null, muted: false, name: "pacer-k3x9" },
    found: [{ discoveryId: id, name: "studio-mac", version: "1", lastSeen: 1, silenced: false }, { discoveryId: "b".repeat(26), name: "old", version: "1", lastSeen: 1, silenced: true }] };
  const attention = [{ id: `discovery:${"b".repeat(26)}`, kind: "discovery" }, { id: `discovery:${id}`, kind: "discovery" }, { id: "discovery-network:k1", kind: "discovery-network" }, { id: "review:t1", kind: "review" }];
  expect(discoveryNoticeFrom(list, attention, new Set())).toEqual({ found: { discoveryId: id, name: "studio-mac" }, network: { key: "k1", label: "home-wifi", name: "pacer-k3x9", rev: 4 } });
  expect(discoveryNoticeFrom(list, attention, new Set([`discovery:${id}`, "discovery-network:k1"]))).toEqual({ found: null, network: null });
  expect(discoveryNoticeFrom({ ...list, network: { ...list.network, advertise: true } }, attention.slice(2), new Set())).toEqual({ found: null, network: null });
  expect(discoveryNoticeFrom(undefined, attention, new Set())).toEqual({ found: null, network: null });
});

test("neutral pairing page names no product and links to Plugins settings", () => {
  const html = renderToString(<PairingView />);
  expect(html).toContain("Pairing lets this machine use another machine’s executors. It is provided by plugins, and none is installed or enabled.");
  expect(html).toMatch(/<a [^>]*class="pc-text-action[^"]*"[^>]*href="#\/settings\/plugins"|<a [^>]*href="#\/settings\/plugins"[^>]*class="pc-text-action/);
  expect([...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual(["#/settings/plugins"]);
  const route = resolveRoute("#/settings/pairing") as Route;
  expect(route).toMatchObject({ name: "settings", section: "pairing" });
  expect(titleFor(route)).toBe("Pair machines");
  expect(settingsNavId("pairing")).toBe("machine");
});

test("network state line", () => {
  expect(networkStateLine({ key: "k", label: "home-wifi", advertise: true, muted: false, name: "n" })).toBe("Advertising on home-wifi");
  expect(networkStateLine({ key: "k", label: "home-wifi", advertise: false, muted: false, name: "n" })).toBe("Not advertising on home-wifi");
  expect(networkStateLine({ key: "k", label: "home-wifi", advertise: null, muted: false, name: "n" })).toBe("Not advertising on home-wifi");
  expect(networkStateLine(null)).toBe("Network not identified");
});

const settings = (over: Partial<Parameters<typeof DiscoveryView>[0]> = {}) => renderToString(<DiscoveryView
  available enabled name="pacer-k3x9" network={{ key: "k1", label: "home-wifi", advertise: true, muted: false, name: "pacer-k3x9" }}
  networks={[{ key: "k1", label: "home-wifi", advertise: true, muted: false }, { key: "k2", label: "office", advertise: false, muted: true }]}
  current="k1" busy={false} onToggle={() => {}} onNetwork={() => {}} onRename={() => {}} {...over} />);

test("discovery settings: switch, advertised name, network state and per-network actions", () => {
  const html = settings();
  expect(html).toContain('role="switch" aria-checked="true"');
  expect(html).toContain("pacer-k3x9");
  expect(html).toContain("Advertising on home-wifi");
  expect(html).toContain("home-wifi"); expect(html).toContain("office");
  expect(buttons(html)).toEqual(["Rename", "Stop", "Reset id", "Allow", "Reset id"]);
  expect(html).toContain("Prompts muted");
  expect(primaries(html)).toBe(0);
  expect(html).not.toContain("Discovery isn’t available in this mode");
});

test("discovery settings when the radio is unavailable or discovery is off", () => {
  const html = settings({ available: false, network: null });
  expect(html).toContain("Discovery isn’t available in this mode");
  expect(html).not.toContain("Network not identified");
  expect(settings({ enabled: false })).toContain('role="switch" aria-checked="false"');
  expect(settings({ networks: [] })).toContain("No networks yet");
});

test("a discovery.found event refreshes discovery resources", () => {
  const state = { snapshot: { seq: 1 } as never, connected: true, sessionEnded: false, needsSnapshot: false, invalidations: {}, version: null, features: { readModel: true, ops: new Set<string>() }, jobs: {}, activity: [] };
  const next = reduceStore(state, { type: "event", event: { seq: 2, at: 0, type: "discovery.found", data: { discoveryId: id, name: "x", version: "1" } } });
  expect(next.invalidations.discovery).toBe(1);
});

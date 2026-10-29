import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { renderToString } from "preact-render-to-string";
import { DiscoveryNoticeView, discoveryNoticeFrom } from "../app/src/shell/DiscoveryNotice";
import { PairingView } from "../app/src/screens/settings/Pairing";
import { DiscoveryView, discoverySwitchCall, networkStateLine } from "../app/src/screens/settings/Discovery";
import { resolveRoute, titleFor, type Route } from "../app/src/router";
import { discoveryNoticeHiddenOn, settingsNavId } from "../app/src/settings-pages";
import { reduceStore } from "../app/src/data/store";
import { uiHref } from "../app/src/data/actions";
import { actionRoute } from "../app/src/tray/model";
import { settingsNote } from "../app/src/screens/settings/General";

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
  // A link inside running text uses the DS inline link style (underlined), not the muted text action.
  expect(html).toMatch(/<a [^>]*class="pc-inline-link"[^>]*href="#\/settings\/machine"[^>]*>Change name<\/a>|<a [^>]*href="#\/settings\/machine"[^>]*class="pc-inline-link"[^>]*>Change name<\/a>/);
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
  // A standalone link is a button link (UI-8), not the muted text action.
  expect(html).toMatch(/<a [^>]*href="#\/settings\/plugins"[^>]*class="pc-btn pc-btn--secondary[^"]*"[^>]*>Open Plugins settings<\/a>|<a [^>]*class="pc-btn pc-btn--secondary[^"]*"[^>]*href="#\/settings\/plugins"[^>]*>Open Plugins settings<\/a>/);
  expect(html).not.toContain("pc-text-action");
  expect([...html.matchAll(/href="([^"]*)"/g)].map(m => m[1])).toEqual(["#/settings/plugins"]);
  const route = resolveRoute("#/settings/pairing") as Route;
  expect(route).toMatchObject({ name: "settings", section: "pairing" });
  expect(titleFor(route)).toBe("Pair machines");
  expect(settingsNavId("pairing")).toBe("machine");
});

test("Pair from Needs you or the tray opens the neutral pairing page when no plugin can pair (UI-13)", () => {
  const pair = { label: "Pair", op: "ui.open", params: { view: "settings", section: "pairing" }, style: "primary" as const };
  expect(uiHref(pair.params)).toBe("#/settings/pairing");
  expect(actionRoute(pair)).toBe("/settings/pairing");
});

test("the Machines page footer does not say discovery changes wait for the next routing decision", () => {
  expect(settingsNote("machine")).not.toMatch(/^Changes apply on the next routing decision/);
  expect(settingsNote("machine")).toContain("Discovery changes apply right away.");
  expect(settingsNote("dispatcher")).toBe("Changes apply on the next routing decision.");
  expect(settingsNote("app")).toBeNull();
  expect(settingsNote(undefined)).toBeNull();
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

test("the Discovery switch calls discovery.set, not config.set", () => {
  expect(discoverySwitchCall(false)).toEqual(["discovery.set", { enabled: false }]);
  expect(discoverySwitchCall(true)).toEqual(["discovery.set", { enabled: true }]);
});

test("busy discovery controls stay focusable instead of natively disabled (F1)", () => {
  const html = settings({ busy: true });
  const control = /<input[^>]*role="switch"[^>]*>/.exec(html)![0];
  expect(control).not.toMatch(/\sdisabled/);
  expect(control).toContain('aria-disabled="true"');
  for (const name of ["Stop advertising on home-wifi", "Reset id on home-wifi", "Allow advertising on office"]) {
    const button = new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`).exec(html)![0];
    expect(button).not.toMatch(/\sdisabled/);
    expect(button).toContain('aria-disabled="true"');
  }
  expect(/<input[^>]*role="switch"[^>]*>/.exec(settings())![0]).not.toContain('aria-disabled="true"');
});

const browserPath = process.env.PACER_TEST_BROWSER;
async function mountSwitch(fixture: unknown = {}) {
  const result = await Bun.build({ entrypoints: ["test/fixtures/ui/discovery-switch.tsx"], target: "browser", format: "iife" });
  if (!result.success) throw Error(result.logs.join("\n"));
  const css = (await Promise.all(["app/src/ds/tokens.css", "app/src/ds/components.css", "app/src/styles.css"].map(path => Bun.file(path).text()))).join("\n");
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage();
  await page.setContent(`<style>${css}</style><div id="app"></div>`);
  await page.evaluate(data => { (window as any).fixture = data; }, fixture);
  await page.addScriptTag({ content: await result.outputs[0]!.text() });
  return { browser, page };
}
test.skipIf(!browserPath)("keyboard focus stays on the Discovery switch and row buttons after a change (F1)", async () => {
  const { browser, page } = await mountSwitch();
  try {
    const control = page.getByRole("switch", { name: "Find machines on this network" });
    await control.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-disabled") === "true");
    expect(await control.evaluate(node => document.activeElement === node)).toBe(true);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-disabled") !== "true");
    expect(await control.isChecked()).toBe(false);
    expect(await control.evaluate(node => document.activeElement === node)).toBe(true);
    const allow = page.getByRole("button", { name: "Allow advertising on home-wifi" });
    await allow.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Stop advertising on home-wifi" }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-disabled="true"]'));
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Stop advertising on home-wifi");
    expect(await page.evaluate(() => (window as any).calls)).toEqual([{ toggle: false }, { key: "k1", advertise: true }]);
  } finally { await browser.close(); }
});

test.skipIf(!browserPath)("Turn on discovery recovers from a corrupt state once, even when pressed again while busy (F2)", async () => {
  const { browser, page } = await mountSwitch({ warning: "The discovery state file could not be read, so discovery is off. Turn it on again to start over." });
  try {
    const recover = page.getByRole("button", { name: "Turn on discovery" });
    await recover.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    expect(await page.getByRole("button", { name: "Turn on discovery" }).count()).toBe(0);
    expect(await page.evaluate(() => (window as any).calls)).toEqual([{ toggle: true }]);
  } finally { await browser.close(); }
});

test("a corrupt discovery state shows its warning with a way to turn discovery on (F2)", () => {
  const warning = "The discovery state file could not be read, so discovery is off. Turn it on again to start over.";
  const html = settings({ enabled: false, warning });
  expect(html).toContain("pc-alert--warning");
  expect(html).toContain(warning);
  expect(buttons(html)).toContain("Turn on discovery");
  expect(settings()).not.toContain("pc-alert");
});

test("discovery off says so and saved answers do not claim advertising (F3)", () => {
  const html = settings({ enabled: false });
  expect(html).toContain("Discovery is off");
  expect(html).not.toContain("Advertising on home-wifi");
  expect(html).not.toMatch(/>Advertising</);
  expect(html).toContain("Allowed (paused)");
  expect(settings({ enabled: false, available: false, network: null })).toContain("Discovery is off");
  expect(settings()).toContain("Advertising on home-wifi");
});

test("the found-machine notice is hidden on the Pair machines page (F4)", () => {
  expect(discoveryNoticeHiddenOn(resolveRoute("#/settings/pairing") as Route)).toBe(true);
  for (const hash of ["#/", "#/settings/machine", "#/settings/plugins"]) expect(discoveryNoticeHiddenOn(resolveRoute(hash) as Route)).toBe(false);
});

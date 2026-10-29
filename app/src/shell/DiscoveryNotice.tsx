import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useActions } from "../data/action-context";
import { useNotifications } from "../data/notification-context";
import { Button } from "../ds/Button";
import { Disclosure } from "../ds/Controls";
import { NoticeCard } from "../ds/NoticeCard";
import { hrefFor, routes } from "../router";
import { ErrorMessage, useTaskContext } from "../screens/task-shared";

/** The current network as discovery.list reports it; name is the name this machine advertises. */
export interface DiscoveryNetwork { key: string; label: string; advertise: boolean | null; muted: boolean; name: string }
export interface DiscoveryList {
  available: boolean; enabled: boolean; network: DiscoveryNetwork | null; rev: number; networksRev: number;
  found: { discoveryId: string; name: string; version: string; lastSeen: number; silenced: boolean }[];
}
export interface FoundPrompt { discoveryId: string; name: string }
export interface NetworkPrompt { key: string; label: string; name: string; rev: number }
export type DiscoveryAction = "pair" | "later" | "ignore" | "mute-network" | "allow" | "deny";

/**
 * The open prompts: attention items of the discovery kinds, matched to discovery.list for their names.
 * Discovered names are unverified (SEC-16); they are only ever shown as text.
 */
export function discoveryNoticeFrom(list: DiscoveryList | undefined, attention: readonly { id: string; kind: string }[], dismissed: ReadonlySet<string>): { found: FoundPrompt | null; network: NetworkPrompt | null } {
  const open = attention.filter(a => !dismissed.has(a.id));
  const ids = new Set(open.filter(a => a.kind === "discovery").map(a => a.id.slice("discovery:".length)));
  const seen = list?.found.find(f => !f.silenced && ids.has(f.discoveryId));
  const net = list?.network;
  const asked = net && net.advertise === null && open.some(a => a.kind === "discovery-network" && a.id === `discovery-network:${net.key}`);
  return {
    found: seen ? { discoveryId: seen.discoveryId, name: seen.name } : null,
    network: asked ? { key: net.key, label: net.label, name: net.name, rev: list.networksRev } : null,
  };
}

/** One prompt at a time, a found machine first; each card has one primary action (UI-14). */
export function DiscoveryNoticeView({ found, network, onAction, busy = false, narrow = false, children }: {
  found: FoundPrompt | null; network: NetworkPrompt | null; onAction: (action: DiscoveryAction) => void; busy?: boolean; narrow?: boolean; children?: ComponentChildren;
}) {
  const act = (action: DiscoveryAction) => () => { if (!busy) onAction(action); };
  if (found) return <NoticeCard label="Machine found" busy={busy} narrow={narrow} title={<>Found pacer on <strong>{found.name}</strong></>} actions={<>
    <Button variant="primary" aria-disabled={busy} onClick={act("pair")}>Pair</Button>
    <Button aria-disabled={busy} onClick={act("later")}>Later</Button>
    <Button variant="quiet" aria-disabled={busy} onClick={act("ignore")}>Not mine</Button>
    <Button variant="quiet" aria-disabled={busy} onClick={act("mute-network")}>Stop on this network</Button>
  </>}>
    <p className="u3-muted">Unverified name</p>
    <Disclosure summary="Details"><code>{found.discoveryId}</code></Disclosure>
    {children}
  </NoticeCard>;
  if (network) return <NoticeCard label="Network question" busy={busy} narrow={narrow} title={<>Let your other machines find this one on {network.label}?</>} actions={<>
    <Button variant="primary" aria-disabled={busy} onClick={act("allow")}>Allow</Button>
    <Button aria-disabled={busy} onClick={act("deny")}>Not on this network</Button>
  </>}>
    <p>It will appear as <strong>{network.name}</strong>. <a className="pc-inline-link" href={hrefFor(routes.settings("machine"))}>Change name</a></p>
    {children}
  </NoticeCard>;
  return null;
}

/** Prompts are answered here or from Needs you; an answered prompt stays hidden for this app session. */
export function DiscoveryNotice({ hidden = false, narrow = false }: { hidden?: boolean; narrow?: boolean }) {
  const { state, api } = useTaskContext(), runner = useActions(), notifications = useNotifications();
  const eligible = !hidden && !state.sessionEnded && state.connected && state.features.ops.has("discovery.list");
  const attention = (state.snapshot?.attention ?? []).filter(a => a.kind === "discovery" || a.kind === "discovery-network");
  const attentionKey = attention.map(a => a.id).join(" ");
  const [list, setList] = useState<DiscoveryList>();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const pending = useRef(false);
  useEffect(() => {
    if (!eligible || !attentionKey) return;
    let active = true;
    void api.call<DiscoveryList>("discovery.list", {}).then(r => { if (active) setList(r); }, () => {});
    return () => { active = false; };
  }, [api, eligible, attentionKey, state.invalidations.discovery]);
  const { found, network } = discoveryNoticeFrom(list, attention, dismissed);
  async function respond(action: DiscoveryAction) {
    if (pending.current) return;
    const prompt = found ? `discovery:${found.discoveryId}` : network ? `discovery-network:${network.key}` : null;
    if (!prompt) return;
    pending.current = true; setBusy(true); setError(undefined);
    const key = `${prompt}:${action}`;
    try {
      const outcome = await runner.run(key, found
        ? { label: action, op: "discovery.respond", params: { discoveryId: found.discoveryId, action } }
        : { label: action, op: "discovery.network.set", params: { network: network!.key, advertise: action === "allow", expect_rev: network!.rev } });
      if (outcome.status === "error") { setError(new Error(`${outcome.message}${outcome.hint ? ` · ${outcome.hint}` : ""}`)); return; }
      setDismissed(previous => new Set([...previous, prompt]));
      document.getElementById("main-content")?.focus();
      if (action !== "pair" || outcome.status !== "done") return;
      const pairing = (runner.result(key) as { pairing?: { handedOver: boolean; plugin?: string } } | undefined)?.pairing;
      if (pairing?.handedOver) notifications?.notify({ key: "discovery:pair", tone: "success", title: `Pairing started in ${pairing.plugin ?? "a plugin"}` });
      else location.hash = hrefFor(routes.settings("pairing"));
    } catch (e) { setError(e); }
    finally { pending.current = false; setBusy(false); }
  }
  if (!eligible) return null;
  return <DiscoveryNoticeView found={found} network={network} busy={busy} narrow={narrow} onAction={action => void respond(action)}><ErrorMessage error={error} /></DiscoveryNoticeView>;
}

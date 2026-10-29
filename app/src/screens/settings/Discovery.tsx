import { useEffect, useState } from "preact/hooks";
import type { DiscoveryList, DiscoveryNetwork } from "../../shell/DiscoveryNotice";
import { Button } from "../../ds/Button";
import { Switch, TextInput } from "../../ds/Controls";
import { ListRow } from "../../ds/Patterns";
import { SectionHeading } from "../../ds/SectionHeading";
import { SettingRow } from "../../ds/SettingRow";
import { Feedback, useOperation, useResource } from "./shared";
import { useTaskContext } from "../task-shared";

export interface KnownNetwork { key: string; label: string; advertise: boolean | null; muted: boolean }
interface NetworksData { networksRev: number; current: string | null; networks: KnownNetwork[] }
type NetworkChange = { advertise: boolean } | { resetId: true };

export function networkStateLine(network: DiscoveryNetwork | null): string {
  if (!network) return "Network not identified";
  return `${network.advertise ? "Advertising" : "Not advertising"} on ${network.label}`;
}
const advertising = (n: KnownNetwork) => n.advertise === null ? "Not asked yet" : n.advertise ? "Advertising" : "Not advertising";

/** The operation the Discovery switch runs. The switch is machine-local discovery state, so it works before setup. */
export const discoverySwitchCall = (on: boolean): [string, { enabled: boolean }] => ["discovery.set", { enabled: on }];

/** Discovery on this machine: on/off, the advertised name, the current network and the networks answered so far. */
export function DiscoveryView({ available, enabled, name, network, networks, current, busy, onToggle, onNetwork, onRename }: {
  available: boolean; enabled: boolean; name?: string; network: DiscoveryNetwork | null; networks: KnownNetwork[]; current: string | null; busy: boolean;
  onToggle: (on: boolean) => void; onNetwork: (key: string, change: NetworkChange) => void; onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name ?? "");
  useEffect(() => { setDraft(name ?? ""); }, [name]);
  const next = draft.trim();
  return <section id="discovery" aria-labelledby="discovery-h" className="u3-section">
    <SectionHeading id="discovery-h">Discovery</SectionHeading>
    <SettingRow variant="board" label="Find machines on this network" description="pacer on your other machines can see this one on networks you allow, and this machine shows you the ones it sees. Names are unverified.">
      <Switch checked={enabled} disabled={busy} onChange={e => onToggle(e.currentTarget.checked)} />
    </SettingRow>
    {name !== undefined && <SettingRow variant="board" label="Machine name" description="The name other machines see. It is shown to them as unverified.">
      <div className="u3-actions">
        <TextInput value={draft} maxLength={64} disabled={busy} onInput={e => setDraft(e.currentTarget.value)} />
        <Button disabled={busy || !next || next === name} onClick={() => onRename(next)}>Rename</Button>
      </div>
    </SettingRow>}
    <p className="u3-muted" role="status">{available ? networkStateLine(network) : "Discovery isn’t available in this mode"}</p>
    <SettingRow variant="board" layout="stacked" label="Networks" description="pacer asks once on each new network before advertising there.">
      {networks.length ? <div>{networks.map(n => <ListRow key={n.key} content={<><strong>{n.label}</strong>{n.key === current && <span className="u3-muted"> · This network</span>}</>}
        meta={[advertising(n), n.muted && "Prompts muted"].filter(Boolean).join(" · ")}
        actions={<>
          {n.advertise ? <Button size="sm" aria-label={`Stop advertising on ${n.label}`} disabled={busy} onClick={() => onNetwork(n.key, { advertise: false })}>Stop</Button>
            : <Button size="sm" aria-label={`Allow advertising on ${n.label}`} disabled={busy} onClick={() => onNetwork(n.key, { advertise: true })}>Allow</Button>}
          <Button size="sm" variant="quiet" aria-label={`Reset id on ${n.label}`} disabled={busy} onClick={() => onNetwork(n.key, { resetId: true })}>Reset id</Button>
        </>} />)}</div>
        : <p className="u3-muted">No networks yet.</p>}
    </SettingRow>
  </section>;
}

/** Immediate settings, outside This Mac's drafted form: each change is written when it is made. */
export function DiscoverySection() {
  const { state } = useTaskContext();
  const list = useResource<DiscoveryList>("discovery.list"), nets = useResource<NetworksData>("discovery.network.get");
  const machine = useResource<{ name: string; rev: number }>("machine.get");
  const action = useOperation(() => { list.reload(); nets.reload(); machine.reload(); });
  if (!list.data) return null;
  const run = (op: string, params: unknown) => void action.run(op, params);
  return <>
    <DiscoveryView available={list.data.available} enabled={list.data.enabled} name={machine.data?.name} network={list.data.network}
      networks={nets.data?.networks ?? []} current={nets.data?.current ?? null} busy={action.busy || !state.connected}
      onToggle={on => run(...discoverySwitchCall(on))}
      onNetwork={(network, change) => run("discovery.network.set", { network, ...change, expect_rev: nets.data?.networksRev ?? list.data!.networksRev })}
      onRename={name => machine.data && run("machine.set", { name, expect_rev: machine.data.rev })} />
    <Feedback action={action} />
  </>;
}

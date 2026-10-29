import { render } from 'preact';
import { useState } from 'preact/hooks';
import { DiscoveryView, type KnownNetwork } from '../../../app/src/screens/settings/Discovery';
import { DensityContext } from '../../../app/src/ds/Density';

// DiscoveryView driven like DiscoverySection: each change is busy for a moment, then the reloaded state arrives.
const calls: unknown[] = [];
(window as any).calls = calls;
const warning: string | undefined = (window as any).fixture?.warning;
function Fixture() {
  const [enabled, setEnabled] = useState(!warning), [busy, setBusy] = useState(false);
  const [networks, setNetworks] = useState<KnownNetwork[]>([{ key: 'k1', label: 'home-wifi', advertise: false, muted: false }]);
  const settle = (apply: () => void) => { setBusy(true); setTimeout(() => { apply(); setBusy(false); }, 300); };
  return <DensityContext.Provider value="settings"><DiscoveryView available enabled={enabled} name="pacer-k3x9" network={null} networks={networks} current="k1" busy={busy} warning={warning}
    onToggle={on => { calls.push({ toggle: on }); settle(() => setEnabled(on)); }}
    onNetwork={(key, change) => { calls.push({ key, ...change }); settle(() => { if ('advertise' in change) setNetworks(ns => ns.map(n => n.key === key ? { ...n, advertise: change.advertise } : n)); }); }}
    onRename={() => {}} /></DensityContext.Provider>;
}
render(<Fixture />, document.getElementById('app')!);

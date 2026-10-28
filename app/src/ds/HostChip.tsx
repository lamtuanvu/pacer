import { Icon } from "./icons";

export function HostChip({ name, kind }: { name: string; kind: 'local' | 'remote' }) {
  return <span className={`pc-host-chip pc-host-chip--${kind}`} title={name}>
    {kind === 'remote' && <Icon name="servers" />}
    <span className="pc-host-chip__name">{name}</span>
  </span>;
}

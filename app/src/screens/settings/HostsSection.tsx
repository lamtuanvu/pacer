import { useTaskContext } from '../task-shared';
import { useResource, Section, words } from './shared';
import { TextAction } from '../../ds/Button';
import { AgentMark } from '../../ds/AgentMark';
import type { HostSummary } from '../../../../src/api/read-model/types';
export function HostsSection({ onHostsPage = false }: { onHostsPage?: boolean } = {}) {
 const {state}=useTaskContext(),hosts=state.snapshot?.hosts;
 return <Section id="hosts" title={onHostsPage ? "Hosts" : "Remote hosts"} detail="Machines that run Codex or Claude Code over SSH." actions={!onHostsPage && <TextAction className="pc-text-action" href="#/settings/hosts">Manage hosts</TextAction>}>{!hosts?<p>Loading hosts…</p>:!hosts.length?<p>No remote hosts yet. <a className="pc-inline-link" href="#/settings/hosts">Add a host.</a></p>:<div className="u3-table-wrap"><table><thead><tr>{['Host','Checks','Parallel tasks','Executors','Repos',''].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{hosts.map(host=><tr key={host.alias}><td><strong>{host.alias}</strong><div><code>ssh {host.ssh}</code></div></td><td>{words(host.state)}</td><td>{host.running} / {host.maxTasks} busy</td><td><div className="u3-actions">{host.executors.map(id=>{const executor=state.snapshot?.executors?.find(e=>e.id===id);return <span className="u3-agent" key={id}><AgentMark agent={executor?.agent??id.split('#')[0]!}/><code>{id}</code></span>;})}</div></td><td>{host.repos}</td><td><TextAction className="pc-text-action" href={`#/settings/hosts/${encodeURIComponent(host.alias)}`}>Manage</TextAction></td></tr>)}</tbody></table></div>}</Section>;
}

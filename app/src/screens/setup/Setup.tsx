import { useContext, useRef, useState } from 'preact/hooks';
import type { SetupChecklist, SetupItem } from '../../../../src/setup/checklist';
import { Button } from '../../ds/Button';
import { withQuery, type RouteQuery } from '../../router';
import { Dialog, ErrorMessage, useTaskContext } from '../task-shared';
import { SetupContext } from './context';
import { performSetupAction, primaryItem, type AgentPreview } from './model';

function Command({ command, primary = false }: { command: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState<unknown>();
  return <div className="pc-setup-command"><pre><code>{command}</code></pre><Button variant={primary ? 'primary' : 'secondary'} onClick={async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setError(undefined); }
    catch (error) { setError(error); }
  }}>{copied ? 'Copied' : 'Copy command'}</Button><ErrorMessage error={error} /></div>;
}
const labels: Record<string, string> = { 'service.install': 'Install service', 'agent.connect': 'Connect', 'nav:add-executor': 'Add executor', 'onboarding.try': 'Try a delegation' };
function SetupRow({ item, primary, query, blocked = false }: { item: SetupItem; primary: boolean; query: RouteQuery; blocked?: boolean }) {
  const { api } = useTaskContext(), setup = useContext(SetupContext);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [consent, setConsent] = useState<{ message: string; preview?: AgentPreview }>();
  const answer = useRef<(yes: boolean) => void>();
  const finish = (yes: boolean) => { setConsent(undefined); answer.current?.(yes); answer.current = undefined; };
  const run = async (skip = false) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { await performSetupAction(item, { api, refresh: setup.refresh, running: setup.setRunning,
      navigate: href => { location.hash = withQuery(href, query); },
      confirm: (message, preview) => new Promise(resolve => { answer.current = resolve; setConsent({ message, preview }); }),
    }, skip); } catch (error) { setError(error); } finally { setBusy(false); }
  };
  const actionable = item.status !== 'done';
  return <div className="pc-setup-row">
    <span className={item.status === 'failed' ? 'pc-bad-text' : 'muted'}>{item.status === 'done' ? 'Done' : item.status === 'failed' ? 'Failed' : 'Needs you'}</span>
    <div className="pc-setup-row__body"><h3>{item.title}</h3>{item.detail && <p className="muted">{item.detail}</p>}
      {actionable && item.action && labels[item.action] && <Button variant={primary ? 'primary' : 'secondary'} disabled={busy || blocked} onClick={() => void run()}>{busy ? 'Working…' : labels[item.action]}</Button>}
      {actionable && blocked && <p className="muted">Finish the required steps first.</p>}
      {actionable && !item.action && item.command && <Command command={item.command} primary={primary} />}
      {actionable && item.id === 'first' && <Button disabled={busy} onClick={() => void run(true)}>Skip</Button>}
      <ErrorMessage error={error} />
      {consent && <Dialog title={item.action === 'service.install' ? 'Install background service' : 'Connect agent'} close={() => finish(false)}>
        <p>{consent.message}</p>{consent.preview && <><div className="pc-section__head"><h2>Files to change</h2></div>{consent.preview.files.map(file => <pre key={file}><code>{file}</code></pre>)}
          {consent.preview.detail && <pre className="pc-setup-preview">{typeof consent.preview.detail === 'string' ? consent.preview.detail : JSON.stringify(consent.preview.detail, null, 2)}</pre>}
          <p>To undo</p><pre><code>{consent.preview.undo}</code></pre></>}
        <Button onClick={() => finish(false)}>Cancel</Button><Button variant="primary" onClick={() => finish(true)}>{item.action === 'service.install' ? 'Install service' : 'Connect'}</Button>
      </Dialog>}
    </div>
  </div>;
}
export function SetupView({ checklist, query }: { checklist: SetupChecklist; query: RouteQuery }) {
  const primary = primaryItem(checklist);
  return <div className="pc-setup"><p>pacer works once the required steps are done. The rest makes it useful.</p>
    {checklist.complete && <div className="pc-notice"><p role="status">Required setup done</p><a className="pc-btn pc-btn--primary pc-btn--touch" href={withQuery('#/', query)}>Go to Home</a></div>}
    {[true, false].map(required => <section className="pc-section" key={String(required)} aria-label={required ? 'Required' : 'Recommended'}>
      <div className="pc-section__head"><h2>{required ? 'Required' : 'Recommended'}</h2></div>
      {checklist.items.filter(i => i.required === required).map(item => <SetupRow key={item.id} item={item} primary={primary === item.id} query={query} blocked={item.id === 'first' && !checklist.complete} />)}
    </section>)}
  </div>;
}
export function Setup({ query }: { query: RouteQuery }) {
  const { checklist } = useContext(SetupContext);
  return checklist ? <SetupView checklist={checklist} query={query} /> : <p role="status">Checking setup…</p>;
}

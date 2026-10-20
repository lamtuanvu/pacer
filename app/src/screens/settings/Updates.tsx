import { useEffect, useState } from 'preact/hooks';
import { desktopHost, readDesktopVersion } from '../../data/desktop';
import { Button, ButtonLink } from '../../ds/Button';
import { Checkbox } from '../../ds/Controls';
import { useDialogs } from '../../ds/useDialogs';
import { updateModel } from '../../model/settings';
import type { ConfigData } from '../../model/strategy';
import { desktopUpdateModel } from '../../../../src/view-model/updates';
import { Feedback, ResourceState, Section, useOperation, useResource } from './shared';

export interface UpdateReport {
  current: string;
  latest: string | null;
  available: boolean;
  error?: string;
  disabled?: boolean;
}

export function DesktopVersionRow({version, loading, report}: {
  version: string | null;
  loading: boolean;
  report?: UpdateReport;
}) {
  const status = desktopUpdateModel(version, report);
  const download = status.canUpdate || !version;
  const release = report?.latest && /^\d+\.\d+\.\d+$/.test(report.latest)
    ? `tag/v${report.latest}` : 'latest';
  return <div>
    <p role="status">Desktop app{version ? ` ${version}` : ''} · {loading ? 'Reading version…' : status.label}</p>
    {!loading && download && <>
      <ButtonLink href={`https://github.com/lamtuanvu/pacer/releases/${release}`}>Download desktop app</ButtonLink>
      <p className="u3-muted">Download the desktop build for your computer, replace the installed app, then quit and reopen pacer. Updating the service does not update the desktop app.</p>
    </>}
  </div>;
}

export function UpdatesSection({initialData}: {initialData?: UpdateReport}) {
  const dialogs = useDialogs();
  const query = useResource('update.check', {}, initialData);
  const config = useResource<ConfigData>('config.get');
  const action = useOperation(query.reload);
  const [native] = useState(() => !!desktopHost().__TAURI__);
  const [desktop, setDesktop] = useState<{version:string|null;loading:boolean}>({version:null,loading:true});
  useEffect(() => {
    if (!native) return;
    let active = true;
    void readDesktopVersion().then(
      version => { if (active) setDesktop({version,loading:false}); },
      () => { if (active) setDesktop({version:null,loading:false}); },
    );
    return () => { active = false; };
  }, [native]);
  const service = updateModel(query.data, false);
  return <Section id="updates" title="Updates" actions={
    <Button busy={action.busy} onClick={() => void action.run('update.check', {force:true})}>Check now</Button>
  }>
    {dialogs.dialog}
    {native && <DesktopVersionRow {...desktop} report={query.data}/>}
    <ResourceState resource={query}>{query.data && <>
      <p role="status">Service {query.data.current} · {service.label}</p>
      {query.data.error && <p role="status">{query.data.error}</p>}
      {service.canUpdate && <Button busy={action.busy} onClick={async () => {
        if (await dialogs.confirm('Update the service and restart it? The desktop app is updated separately.', 'Update service', 'Update service and restart')) {
          void action.run('update.apply', {});
        }
      }}>Update service and restart</Button>}
    </>}</ResourceState>
    <label className="pc-checkbox"><span>Check for updates <small className="u3-muted">Once a day, in the background</small></span><Checkbox className="pc-checkbox__input" aria-label="Check for updates" checked={config.data?.keys.update_check?.value !== false} disabled={!config.data || action.busy} onChange={e => void action.run('config.set', {key:'update_check',value:e.currentTarget.checked})}/></label>
    <ResourceState resource={config}><span/></ResourceState>
    <Feedback action={action}/>
  </Section>;
}

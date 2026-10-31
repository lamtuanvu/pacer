import { render } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from '../../app/src/ds/Button';
import { ImmediateSave, ReleaseRange } from '../../app/src/ds/ImmediateSave';
import { SegmentedControl } from '../../app/src/ds/Patterns';
import { Switch } from '../../app/src/ds/Controls';
const save = async (value: unknown) => {
  const response = await fetch('/save', {method:'POST',body:JSON.stringify(value)});
  if (!response.ok) throw await response.json();
};
function CancelledSave() {
  const [blocked, setBlocked] = useState(false);
  (window as any).blockControl = setBlocked;
  return <><ImmediateSave value={false} save={async value => { await save(value); return false; }}>{(value, change, busy) => <Switch aria-label="Cancelled" checked={value} disabled={busy || blocked} onChange={event => change(event.currentTarget.checked)}/>}</ImmediateSave><Button>Elsewhere</Button></>;
}
render(<>
  <ImmediateSave value="one" save={save}>{(value, change, busy) => <SegmentedControl label="Policy" value={value} disabled={busy} options={[{value:'one',label:'One'},{value:'two',label:'Two'}]} onChange={change}/>}</ImmediateSave>
  <ImmediateSave value={false} save={save}>{(value, change, busy) => <Switch aria-label="Enabled" checked={value} disabled={busy} onChange={event => change(event.currentTarget.checked)}/>}</ImmediateSave>
  <ImmediateSave value="10" save={save}>{(value, change, busy) => <ReleaseRange aria-label="Reserve" min="0" max="50" step="5" value={value} disabled={busy} onCommit={change}/>}</ImmediateSave>
<CancelledSave /></>, document.getElementById('root')!);

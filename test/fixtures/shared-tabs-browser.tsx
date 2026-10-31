import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SegmentedControl, Tabs } from '../../app/src/ds/Patterns';
function Example(){const [scope,S]=useState('all'),[period,P]=useState('today'),[tab,T]=useState('details'),[key,K]=useState('first');return <main>{[
<div data-testid="Dispatcher scope"><h2>Dispatcher scope</h2><SegmentedControl variant="board" label="Scope" value={scope} onChange={S} options={[{value:'all',label:'All repositories'},{value:'one',label:'One repository'}]}/></div>,
<div data-testid="Dispatch period"><h2>Dispatch period</h2><SegmentedControl variant="board" label="Period" value={period} onChange={P} options={[{value:'today',label:'Today'},{value:'7',label:'7 days'},{value:'30',label:'30 days'}]}/></div>,
<div data-testid="Session details"><h2>Session details</h2><Tabs id="session" label="Session details" value={tab} onChange={T} options={[{value:'details',label:'Details'},{value:'changes',label:'Changes'}]}/><div id={`session-${tab}-panel`} role="tabpanel" aria-labelledby={`session-${tab}-tab`}>{tab==='details'?<p>Session workspace and task details.</p>:<><p>Changes in this session.</p><p>Three changed files.</p></>}</div></div>
]}
<SegmentedControl label="Keyboard choices" value={key} onChange={K} options={[{value:'first',label:'First'},{value:'skip',label:'Disabled',disabled:true},{value:'last',label:'Last'}]}/>
</main>}render(<Example/>,document.getElementById('root')!);

import { render } from 'preact';
import { useState } from 'preact/hooks';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { canLeaveScreen } from '../../../app/src/data/navigation-guard';
import { initialState } from '../../../app/src/data/store';
import { PluginContext, usePluginCatalog } from '../../../app/src/plugins/catalog';
import { PluginsPage } from '../../../app/src/screens/settings/PluginsPage';
import { PluginSettingsPage } from '../../../app/src/screens/settings/PluginSettingsPage';
import { SettingsPanel } from '../../../app/src/shell/SettingsPanel';
import { pluginFixture, surfaceFixtures, settingsFixture } from './plugin-settings-data';
const host = window as any; host.canLeave = canLeaveScreen; host.unmount = () => render(null,document.getElementById('app')!);
const fixture = host.fixture ?? {};
let plugins = structuredClone(fixture.plugins ?? [pluginFixture]), surfaces = structuredClone(fixture.surfaces ?? surfaceFixtures), settings = structuredClone(fixture.settings ?? settingsFixture);
const calls: {op:string;params:any}[] = host.calls = [];
let emit = () => {};
const api = { call: async (op:string,params:any) => {
  calls.push({op,params:structuredClone(params)});
  if(op === 'plugin.list') {if(host.failList) throw Error('offline');return {plugins:structuredClone(plugins)};}
  if(op === 'plugin.ui.list') {if(host.failSurfaces) throw Error('offline');return {surfaces:structuredClone(surfaces)};}
  if(op === 'plugin.settings.get') {if(fixture.getError) throw {code:fixture.getError};return structuredClone(settings);}
  if(op === 'plugin.settings.set') {
    if(host.saveError === 'invalid_input') throw {code:'invalid_input',data:{errors:[{path:'name',message:'Choose another label.'},{path:'retries',message:'Too many retries.'}]}};
    if(host.revisionConflict) {host.revisionConflict=false;settings.rev++;throw {code:'conflict'};}
    if(host.saveError === 'conflict' || params.expect_rev !== settings.rev) throw {code:'conflict'};
    settings = {...settings,values:params.values,rev:settings.rev+1};return structuredClone(settings);
  }
  if(op === 'plugin.ui.visibility') {
    if(host.visibilityConflict) {host.visibilityConflict=false;settings.rev++;surfaces[1].visible=false;throw {code:'conflict'};}
    if(params.expect_rev !== settings.rev) throw {code:'conflict'};
    surfaces = surfaces.map((s: any) => s.id === params.id ? {...s,visible:params.visible} : s);settings.rev++;emit();if(fixture.eventBurst) {setTimeout(emit,10);setTimeout(emit,20);}return {rev:settings.rev};
  }
  if(op === 'plugin.doctor') return {reports:[{ok:!host.doctorError,error:host.doctorError ?? null,needs:null}]};
  if(op === 'plugin.remove') {plugins=plugins.filter((p:any)=>p.id!==params.id);surfaces=surfaces.filter((s:any)=>s.plugin!==params.id);emit();return {};}
  if(op === 'plugin.enable' || op === 'plugin.disable') {
    if(fixture.grant && op === 'plugin.enable' && !params.grant) return {state:'needs_grant',needs:['tasks.read'],surfaces:['settings']};
    plugins=plugins.map((p:any)=>p.id===params.id?{...p,enabled:op==='plugin.enable',state:op==='plugin.enable'?'ready':'disabled'}:p);emit();return {};
  }
  throw Error(`Unexpected ${op}`);
} } as any;
const runner = createActionRunner({call:api.call,waitFor:async()=>true,refetch:()=>{},navigate:()=>{}});
function Fixture() {
  const [signal,setSignal] = useState(0); emit = host.emit = () => setSignal(n=>n+1);
  const catalog = usePluginCatalog(api,true,signal), state = {...initialState(),connected:true,invalidations:{plugin:signal},snapshot:{repos:[{key:'repo-one',label:'team/one'},{key:'repo-two',label:'team/two'}]}} as any;
  const section = fixture.mode === 'plugins' ? 'plugins' : 'plugins/fx-ui';
  return <TaskContext.Provider value={{api,state}}><ActionContext.Provider value={runner}><PluginContext.Provider value={catalog}>
    {fixture.mode === 'nav' ? <SettingsPanel route={{name:'settings',section,query:{repo:null,scope:null}}} counts={null}/> : fixture.mode === 'plugins' ? <PluginsPage/> : <PluginSettingsPage plugin="fx-ui"/>}
  </PluginContext.Provider></ActionContext.Provider></TaskContext.Provider>;
}
render(<Fixture/>,document.getElementById('app')!);

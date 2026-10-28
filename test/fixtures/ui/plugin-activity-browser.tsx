// @ts-nocheck
/** @jsxImportSource preact */
import {render} from "preact";
import {useState} from "preact/hooks";
import {NavigationProvider} from "../../../app/src/navigation.tsx";
import {Activity} from "../../../app/src/plugins/Activity.tsx";
import {Rail} from "../../../app/src/shell/Rail.tsx";
import {TaskContext} from "../../../app/src/screens/task-shared.tsx";
import {PluginContext,usePluginCatalog} from "../../../app/src/plugins/catalog.ts";
import {initialState} from "../../../app/src/data/store.ts";
const log=window.calls=[];
let renders=0;
const api={call:async(op,params)=>{
 log.push({op,params});
 if(op==='plugin.ui.list') {if(window.failList)throw Error('unavailable');return {surfaces:[{plugin:'fx-ui',id:'checklist',surface:'activity',title:'Release checklist',icon:'check-square',visible:!window.hidden}]};}
 if(op==='plugin.list' && window.failInfo)throw Error('offline');
 if(op==='plugin.list')return {plugins:[{id:'fx-ui',version:'1.0.0',publisher:'pacer-conformance'}]};
 if(op==='plugin.ui.render') {if(window.failRender)throw {code:'plugin_timeout'};return {document:{type:'stack',gap:'content',children:[{type:'text',text:'render '+ ++renders},{type:'button',label:'Confirm me',action:'confirm',variant:'secondary',confirm:{title:'Proceed?',body:'<b>quoted</b>'}},{type:'button',label:'Delete',action:'delete',variant:'danger'},{type:'checkbox',label:'Ready',name:'ready',checked:false,action:'toggle'}]}};}
 if(op==='plugin.ui.action'){await new Promise(resolve=>setTimeout(resolve,100));return {result:'refresh',message:'Plugin says <b>done</b>'};}
}};
function App(){const [signal,setSignal]=useState(0),[away,setAway]=useState(false);window.visit=away=>{location.hash=away?'#/settings/app':'#/plugins/fx-ui/checklist';setAway(away);};window.emit=()=>setSignal(n=>n+1);const catalog=usePluginCatalog(api,true,signal),route=away?{name:'settings',section:'app',query:{repo:null,scope:null}}:{name:'plugin',plugin:'fx-ui',id:'checklist',query:{repo:null,scope:null}};return <TaskContext.Provider value={{api,state:initialState()}}><PluginContext.Provider value={catalog}><NavigationProvider route={route} pluginTitle={away?undefined:catalog.surfaces.find(s=>s.surface==='activity')?.title}><Rail route={route} counts={null}/>{away?<p>App preferences</p>:<Activity plugin="fx-ui" id="checklist"/>}</NavigationProvider></PluginContext.Provider></TaskContext.Provider>;}
render(<App/>,document.getElementById('app'));

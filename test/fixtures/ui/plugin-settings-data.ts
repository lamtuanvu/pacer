import manifest from '../../../conformance/fixtures/ui/pacer-plugin.json';
import type { PluginInfo, SurfaceInfo } from '../../../src/plugins/registry';
import type { PluginSettingsData } from '../../../app/src/screens/settings/PluginSettingsPage';
export const pluginFixture: PluginInfo = {id:'fx-ui',version:'1.0.0',publisher:'pacer-conformance',bundled:false,enabled:true,state:'ready',tier:'free',contributes:['ui','diagnostic','agentSession','observation','decision'],capabilities:[{name:'tasks.read'},{name:'config.get'},{name:'net.http',scopes:['example.test']}],ui:{settings:1,activity:1,panelTabs:1,status:1},surfaces:['settings','activity','panelTabs','status'],error:null,grant:null,pid:null};
export const surfaceFixtures: SurfaceInfo[] = [
  {plugin:'fx-ui',surface:'settings',id:'settings',title:'Release checklist',icon:null,context:'global',visible:true,state:'ready'},
  {plugin:'fx-ui',surface:'activity',id:'checklist',title:'Release checklist',icon:'check-square',context:'global',visible:true,state:'ready'},
  {plugin:'fx-ui',surface:'panelTabs',id:'checklist-tab',title:'Checklist',icon:'list',context:'task',visible:true,state:'ready'},
  {plugin:'fx-ui',surface:'status',id:'open-items',title:'Open checklist items',icon:null,context:'global',visible:true,state:'ready'},
];
export const settingsFixture: PluginSettingsData = {id:'settings',title:'Release checklist',rev:7,schema:{fields:{...manifest.contributes.ui.settings[0]!.schema.fields,
  retries:{type:'integer',title:'Retries',minimum:1,maximum:5},mode:{type:'string',title:'Mode',enum:['First','Second']},largeEnum:{type:'string',title:'Strategy',enum:['One','Two','Three','Four','Five']},name:{type:'string',title:'Label',maxLength:20},reference:{type:'secretRef',title:'Credential reference'},
} as PluginSettingsData['schema']['fields']},values:{required:true,repos:['repo-one'],items:['Run tests','Update notes'],retries:2,mode:'First',largeEnum:'One',name:'Checklist',reference:'release-ref'}};

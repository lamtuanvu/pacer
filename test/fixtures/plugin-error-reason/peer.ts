import { serve, PluginError } from '../../../packages/plugin-sdk/src/index';
await serve({manifest:{id:'fx-error-reason',version:'1.0.0',publisher:'fixture',host:'^1.6',contributes:{},capabilities:[{name:'config.get'}]},handlers:{
  'diagnostic.ping':async(_params,host)=>{
    try {await host.config();return {ok:true,uptimeS:0};}
    catch(error){return {ok:true,uptimeS:0,observed:error instanceof PluginError ? {code:error.code,reason:error.reason} : {code:'unexpected'}};}
  },
}});

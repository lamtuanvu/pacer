import {serve,type Handler} from '@pacer/plugin';
import {parse,askInput,adapterConfig,configs} from './config';
import {rulesClassifier} from './rules';
import {ollamaClassifier} from './ollama';
import {jevClassifier} from './jev';
import {isLocalUrl} from './http';
import {manifest} from './manifest';
export {manifest};
export const handlers:Record<string,Handler>={
 'classifier.adapters':async(_params,host)=>{const config=parse(adapterConfig,await host.config());return {adapters:[{id:'rules',external:false},{id:'ollama',external:!isLocalUrl(config.adapters.ollama.baseUrl)},{id:'jev',external:true}]};},
 'classifier.ask':async(raw,host)=>{const p=parse(askInput,raw);switch(p.adapter){
  case 'rules':parse(configs.rules,p.config);return rulesClassifier.ask(p.state,p.question,p.timeoutMs);
  case 'ollama':return ollamaClassifier(parse(configs.ollama,p.config),host).ask(p.state,p.question,p.timeoutMs);
  case 'jev':return jevClassifier(parse(configs.jev,p.config),host).ask(p.state,p.question,p.timeoutMs);
 }},
};
if(import.meta.main)await serve({manifest,handlers});

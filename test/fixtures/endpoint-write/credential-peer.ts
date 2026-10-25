import {serve, type Handler} from '../../../packages/plugin-sdk/src/index';
import {handlers as endpointHandlers} from '../../../plugins/pacer-endpoints/index';
export const manifest={id:'fx-endpoint-credentials',version:'1.0.0',publisher:'fixture',host:'^1.4',contributes:{endpoint:{apis:['openai-compatible']}},capabilities:[{name:'net.http' as const,scopes:['127.0.0.1']},{name:'fs.write' as const,scopes:['${PACER_HOME}/opencode','${PACER_HOME}/opencode/**']}]};
export const handlers:Record<string,Handler>=endpointHandlers;
if(import.meta.main)await serve({manifest,handlers});

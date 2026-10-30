import type {HostClient} from '@pacer/plugin';
import {join} from 'node:path';
import {endpointKeyEnv,renderOpencodeConfig,type EndpointAccount} from './opencode-config';
export interface LaunchInput {account:EndpointAccount|null;accounts:EndpointAccount[];pacerHome:string}
/** Only placeholders go to disk. The host resolves returned references at launch. */
export async function launchEnv(host:Pick<HostClient,'fs'>,input:LaunchInput):Promise<{env:Record<string,string>;secretEnv:Record<string,string>}>{
 const dir=join(input.pacerHome,'opencode'),path=join(dir,'opencode.json');
 await host.fs.mkdir(dir);
 await host.fs.write(path,JSON.stringify(renderOpencodeConfig(input.accounts),null,2)+'\n',0o600);
 return {env:{OPENCODE_CONFIG:path},secretEnv:!input.account?.keyRef?{}:{[endpointKeyEnv(input.account.name)]:input.account.keyRef}};
}

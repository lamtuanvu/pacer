import {serve,type Handler} from '@pacer/plugin';
import {discoverModels,type DiscoveryInput} from './models';
import {launchEnv,type LaunchInput} from './launch-env';
import {testTask,type TestInput} from './test-task';
import { manifest } from './manifest';
export { manifest } from './manifest';
export const handlers:Record<string,Handler>={
 'endpoint.test':(raw,host)=>testTask(host,raw as TestInput),
 'endpoint.models':(raw,host)=>discoverModels(host,raw as DiscoveryInput),
 'endpoint.launchEnv':(raw,host)=>launchEnv(host,raw as LaunchInput),
};
if(import.meta.main)await serve({manifest,handlers});

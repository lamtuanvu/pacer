import {z} from 'zod';
import type {MethodDef} from './protocol';
import {secretReference} from './http-protocol';

const httpUrl=z.url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;},'HTTP(S) URL without credentials required');
export const discoveredModel=z.object({id:z.string(),name:z.string().optional(),context:z.number().int().positive().safe().optional(),output:z.number().int().positive().safe().optional(),tools:z.boolean().optional()});
export const discoveryResult=z.union([z.object({listed:z.literal(true),models:z.array(discoveredModel)}),z.object({listed:z.literal(false),error:z.string(),detail:z.string()})]);
export const endpointAccount=z.object({name:z.string().min(1),baseUrl:httpUrl,keyRef:secretReference.nullable(),models:z.array(z.object({id:z.string(),name:z.string().optional(),context:z.number().int().positive().safe(),output:z.number().int().positive().safe(),tools:z.boolean()}))});
export const endpointState=z.object({state:z.enum(['ready','not_tested','not_working','key_missing']),detail:z.string().optional(),checked_at:z.string().optional()});
const launch=z.object({account:endpointAccount.nullable(),accounts:z.array(endpointAccount),pacerHome:z.string().min(1)});
/** Host projections are metadata only; references never convey authority by themselves. */
export const ENDPOINT_METHODS: Record<string,MethodDef> = {
  'endpoint.models':{description:'Discover OpenAI-compatible models using a host-bound credential reference and captured target.',params:z.object({baseUrl:httpUrl,keyRef:secretReference.nullable(),timeoutMs:z.number().int().positive().max(120000).optional()}),result:discoveryResult,deadlineMs:12000},
  'endpoint.launchEnv':{description:'Render all managed endpoint settings and return plain launch settings separately from host-resolved references.',params:launch,result:z.object({env:z.record(z.string(),z.string()),secretEnv:z.record(z.string(),secretReference)}),deadlineMs:5000},
  'endpoint.test':{description:'Run the fixed endpoint test in a host-owned disposable repository; native runner checks remain separate.',params:launch.extend({account:endpointAccount,runner:z.object({id:z.string(),model:z.string()}),repository:z.string().min(1),env:z.record(z.string(),z.string()),checkedAt:z.string(),configRef:secretReference.optional()}),result:endpointState,deadlineMs:130000},
};

import {z} from 'zod';
import {PluginError} from '@pacer/plugin';
const ref=z.string().regex(/^(env|secrets|endpoint):[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
const url=z.string().refine(value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}});
export const configs={rules:z.object({}).strict(),ollama:z.object({baseUrl:url,model:z.string().min(1),maxTokens:z.number().positive().refine(Number.isInteger),keyRef:ref.nullable()}).strict(),jev:z.object({baseUrl:url,model:z.string().min(1),keyRef:ref,usdPerMtokIn:z.number().nonnegative().nullable(),usdPerMtokOut:z.number().nonnegative().nullable()}).strict()};
export const adapterConfig=z.object({adapters:z.object(configs).strict()}).strict();
export function parse<T extends z.ZodType>(schema:T,value:unknown):z.infer<T>{const result=schema.safeParse(value);if(!result.success)throw new PluginError('invalid_input','invalid classifier input or configuration snapshot');return result.data;}
export const question=z.discriminatedUnion('type',[
 z.object({type:z.literal('choice'),id:z.string(),instructions:z.string(),criteria:z.record(z.string(),z.string())}),
 z.object({type:z.literal('score'),id:z.string(),instructions:z.string(),min:z.number(),max:z.number()}),
 z.object({type:z.literal('yesno'),id:z.string(),instructions:z.string()})]);
export const askInput=z.object({adapter:z.enum(['rules','ollama','jev']),state:z.string().max(256*1024),question,timeoutMs:z.number().positive(),config:z.unknown().refine(v=>v!==undefined)});

import { z } from 'zod';
import type { OpDef } from './ops';
import { sessionInfo, openSession } from '../session/service';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const op=<P extends z.ZodTypeAny>(def:OpDef<P>)=>def as unknown as OpDef;
export const sessionOps:Record<string,OpDef>={
 'task.session':op({description:'Session host, capabilities and available viewers.',params:z.object({id}),handler:(ctx,p)=>sessionInfo(ctx,p.id)}),
 'task.attach':op({description:'Open a task viewer, or return a command when unavailable.',params:z.object({id,target:z.enum(['app','orca','here','terminal','tmux'])}),handler:(ctx,p)=>openSession(ctx,p.id,p.target)}),
};

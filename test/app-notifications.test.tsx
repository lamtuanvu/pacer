import { expect, test } from 'bun:test';
import { createNotifications } from '../app/src/model/notifications';
import { renderToString } from 'preact-render-to-string';
import { Alert } from '../app/src/ds/Alert';
test('notifications deduplicate and keep a bounded visible queue',()=>{
 const n=createNotifications();
 n.notify({key:'save',tone:'success',title:'Saved'});n.notify({key:'save',tone:'success',title:'Updated'});
 expect(n.getSnapshot()).toHaveLength(1);expect(n.getSnapshot()[0].title).toBe('Updated');
 for(let i=0;i<4;i++)n.notify({key:String(i),tone:'error',title:'Error'});
 expect(n.getSnapshot()).toHaveLength(3);
 n.dismiss(n.getSnapshot()[0].id);expect(n.getSnapshot()).toHaveLength(3);
 n.dispose();expect(n.getSnapshot()).toHaveLength(0);
});
test('notification timers expire success and pause while focused',()=>{
 let now=0;const tasks=new Map<number,()=>void>();let id=0;
 const n=createNotifications({now:()=>now,setTimer:fn=>{tasks.set(++id,fn);return id;},clearTimer:timer=>{tasks.delete(timer);}});
 const success=n.notify({key:'save',tone:'success',title:'Saved'});
 now=2000;n.pause(success);expect(tasks.size).toBe(0);
 now=8000;n.resume(success);expect(tasks.size).toBe(1);
 now=11000;for(const fn of [...tasks.values()])fn();expect(n.getSnapshot()).toHaveLength(0);
 n.notify({key:'error',tone:'error',title:'Failed'});expect(tasks.size).toBe(0);n.dispose();
});
test('shared alert exposes semantic severity and a visible title',()=>{
 const html=renderToString(<Alert tone="error" title="Could not save">Your edits are preserved.</Alert>);
 expect(html).toContain('role="alert"');expect(html).toContain('Could not save');expect(html).toContain('pc-alert--error');
});
test('another notification cannot restart a hovered success timer',()=>{
 const timers=new Map<number,()=>void>();let id=0;
 const n=createNotifications({now:()=>0,setTimer:fn=>{timers.set(++id,fn);return id;},clearTimer:t=>{timers.delete(t);}});
 const paused=n.notify({key:'save',tone:'success',title:'Saved'});n.pause(paused);
 n.notify({key:'warn',tone:'warning',title:'Warning'});
 expect(timers.size).toBe(0);n.resume(paused);expect(timers.size).toBe(1);n.dispose();
});

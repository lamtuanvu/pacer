import { expect, test } from 'bun:test';
import { applyClientAction } from '../app/src/data/control';

test('page action applies appearance on this device and rejects unsupported native commands', async () => {
  let value = 'light'; const routes: string[] = [];
  const host = { getTheme:()=>value, setTheme:(next:string)=>{value=next;}, navigate:async(route:string)=>{routes.push(route); return true;} };
  expect(await applyClientAction({type:'theme.set',value:'dark'},host)).toEqual({theme:'dark'});
  expect(value).toBe('dark');
  expect(await applyClientAction({type:'theme.get'},host)).toEqual({theme:'dark'});
  await applyClientAction({type:'navigate',route:'/settings'},host);
  expect(routes).toEqual(['/settings']);
  await expect(applyClientAction({type:'quit'},host)).rejects.toThrow('unsupported');
});
test('navigation cancellation does not report success', async () => {
  await expect(applyClientAction({type:'navigate',route:'/settings'},{getTheme:()=> 'system',setTheme:()=>{},navigate:async()=>false})).rejects.toThrow('navigation_cancelled');
});

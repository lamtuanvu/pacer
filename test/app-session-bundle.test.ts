import { expect,test } from 'bun:test';
import { buildApp,APP_JS_BUDGET,TERM_JS_BUDGET } from '../app/build';
import { appRoute } from '../src/serve/app-routes';
import type { Ctx } from '../src/types';
test('terminal is a separate embedded lazy module and all JS chunks fit the budgets',async()=>{
 const files=await buildApp(),app=files.find(f=>f.path==='app.js')!,term=files.find(f=>f.path==='term.js')!;
 expect(term).toBeDefined();expect(files.some(f=>f.path==='term.css')).toBe(true);
 expect(Bun.gzipSync(app.text).length).toBeLessThan(APP_JS_BUDGET);
 const terminalBytes=files.filter(f=>f.path.endsWith('.js')&&f.path!=='app.js').reduce((n,f)=>n+Bun.gzipSync(f.text).length,0);
 expect(terminalBytes).toBeLessThan(TERM_JS_BUDGET);
 // Every relative module import is present in the same embedded asset list.
 for(const file of files.filter(f=>f.path.endsWith('.js')))for(const match of file.text.matchAll(/(?:from\s*|import\s*\(?)['"]\.\/([^'"]+)['"]/g))expect(files.some(f=>f.path===match[1])).toBe(true);
});
test('existing asset handler serves terminal JS and CSS with correct MIME and CSP',()=>{
 for(const [path,type] of [['term.js','text/javascript'],['term.css','text/css']]){const response=appRoute(new Request(`http://localhost/app/${path}`),{} as Ctx);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain(type!);expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");}
});

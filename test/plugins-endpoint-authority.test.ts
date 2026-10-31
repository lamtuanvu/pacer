import {expect,test} from 'bun:test';
import {endpointHttpScopes} from '../src/plugins/endpoint-authority';
const resources=(hosts:string[])=>({reads:[],commands:[],stores:[],http:{hosts}});
test('only canonical endpoint model/test calls specialize maximum declaration to exact captured hosts',()=>{
 const hosts=['owned.invalid','127.0.0.1','[::1]'];const result=endpointHttpScopes(true,'endpoint.models',['*'],resources(hosts));hosts.push('other.invalid');expect(result).toEqual(['owned.invalid','127.0.0.1','[::1]']);expect(Object.isFrozen(result)).toBe(true);
 expect(endpointHttpScopes(false,'endpoint.models',['*'],resources(['owned.invalid']))).toEqual(['*']);expect(endpointHttpScopes(true,'endpoint.launchEnv',['*'],resources([]))).toEqual(['*']);
});
test('canonical scope specialization refuses missing wildcard and nonexact targets',()=>{
 for(const hosts of [[],['*'],['*.owned.invalid'],['owned.invalid:8000'],['user@owned.invalid'],['owned.invalid/path']])expect(()=>endpointHttpScopes(true,'endpoint.models',['*'],resources(hosts))).toThrow();
 expect(()=>endpointHttpScopes(true,'endpoint.test',['owned.invalid'],resources(['owned.invalid']))).toThrow();
});

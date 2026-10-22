import {expect,test} from "bun:test";
import {parse} from "@babel/parser";
import {buildApp} from "../app/build";
test("every generated application module import resolves to a served asset",async()=>{
 const files=await buildApp(),paths=new Set(files.map(file=>file.path));
 function imports(node:unknown,found:string[]=[]):string[]{
  if(!node||typeof node!=="object")return found;
  const value=node as Record<string,unknown>;
  if(["ImportDeclaration","ExportNamedDeclaration","ExportAllDeclaration","ImportExpression"].includes(String(value.type))){const source=value.source as {value?:unknown}|undefined;if(typeof source?.value==="string"&&source.value.startsWith("./"))found.push(source.value.slice(2));}
  for(const child of Object.values(value))if(Array.isArray(child))child.forEach(item=>imports(item,found));else if(child&&typeof child==="object")imports(child,found);
  return found;
 }
 for(const file of files.filter(f=>f.path.endsWith(".js")))for(const dependency of imports(parse(file.text,{sourceType:"module"})))expect({file:file.path,dependency,exists:paths.has(dependency)}).toMatchObject({exists:true});
});

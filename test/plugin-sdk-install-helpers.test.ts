import {expect,test} from "bun:test";
import {sha256,backupPath,shq,shellCommand} from "../packages/plugin-sdk/src/install/helpers";
import * as host from "../src/install/fsx";
import {localTs} from "./helpers";
test("backupPath preserves local time and collision suffixes with explicit occupancy",()=>{
  const path="$HOME/config.toml",now=localTs(2026,10,11,9,5)+7;
  const first=`${path}.pacer-bak-20261011-090507`,occupied=new Set<string>();
  const exists=(candidate:string)=>occupied.has(candidate);
  expect(backupPath(path,now,exists)).toBe(first);
  occupied.add(first);expect(backupPath(path,now,exists)).toBe(`${first}-2`);
  occupied.add(`${first}-2`);expect(backupPath(path,now,exists)).toBe(`${first}-3`);
});
test("sha256 hashes UTF8 including BOM and shell quoting preserves literal text",()=>{
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for(const text of ["", "界", "\ufeffvalue", "line\nnext", "\0"])expect(sha256(text)).toBe(host.sha256(text));
  expect(shellCommand(["/opt/My Disk/pacer","it's"])).toBe("'/opt/My Disk/pacer' 'it'\\''s'");
  expect(shq("/usr/bin/pacer_-.:=@%+")).toBe("/usr/bin/pacer_-.:=@%+");
  expect(shq("")).toBe("''");expect(shq("$(echo unsafe)")).toBe("'$(echo unsafe)'");
  for(const argv of [[],["pacer","space here","\n","'","$HOME","`literal`","界"]])expect(shellCommand(argv)).toBe(host.shellCommand(argv));
});

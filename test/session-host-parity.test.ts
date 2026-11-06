import { expect, test } from "bun:test";
import { chmodSync, readFileSync, mkdtempSync, readdirSync, rmSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeLog, encodeHeader, encodeRecord, wire, WireDecoder } from "../src/session/framing";
import { SecretMasker } from "../src/session/masking";
import { Recording, readRecording } from "../src/session/recording";
import { Screen } from "../src/session/screen";
import { PlainText } from "../src/session/plain";
import { hostOlder, readSessionVersion, writeSessionVersion } from "../src/session/protocol";

const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/sessions/host-parity.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/sessions/host-corpus.json"), "utf8"));
const view = (frames: {type:number;data:Buffer}[]) => frames.map(f => ({type:f.type,data:f.data.toString("hex")}));

test("TS recording keeps the append writer until its dedicated SEC-7 change", async () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-append-"));
  try {
    const recording=new Recording(dir);
    const log=join(dir,"session.log");
    const inode=statSync(log).ino;
    for(let n=0;n<32;n++) await recording.output(Buffer.from("frame\n"));
    await recording.close();
    expect(statSync(log).ino).toBe(inode);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("TS version writer leaves the existing directory mode for the dedicated SEC-7 change", () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-version-"));
  try {
    chmodSync(dir,0o755);
    writeSessionVersion(dir,null);
    expect(statSync(dir).mode&0o777).toBe(0o755);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("TS log and wire format match captured host bytes, including a torn tail", () => {
  const raw = Buffer.concat([encodeHeader(golden.header),encodeRecord(1,12.9,Buffer.from("hello")),encodeRecord(2,13,Buffer.from([0,80,0,24])),Buffer.from([1,0,0])]);
  expect(raw.toString("hex")).toBe(golden.logHex);
  expect(encodeHeader({...golden.header,startedAt:1}).toString("hex")).toBe(golden.integerHeaderHex);
  const decoded = decodeLog(raw);
  expect({header:decoded.header,validBytes:decoded.validBytes,frames:decoded.frames.map(f=>({type:f.type,ms:f.ms,data:f.data.toString("hex")}))}).toEqual(golden.decoded);
  const packet = wire(3,Buffer.from("hello"));
  expect(packet.toString("hex")).toBe(golden.wireHex);
  const decoder = new WireDecoder();
  expect([decoder.push(packet.subarray(0,2)).length,view(decoder.push(packet.subarray(2)))]).toEqual(golden.wireParts);
});

test("TS record timestamps, wire cap and consecutive frames match captured limits", () => {
  for(const row of golden.recordMs) expect(encodeRecord(1,Number(row.input),Buffer.alloc(0)).toString("hex")).toBe(row.hex);
  expect(()=>wire(1,Buffer.alloc(16*1024*1024+1))).toThrow("session frame too large");
  const decoder=new WireDecoder();
  expect(view(decoder.push(Buffer.concat([wire(1,Buffer.from("a")),wire(2,Buffer.from("b"))])))).toEqual([{type:1,data:"61"},{type:2,data:"62"}]);
});

test("TS masking and recorded artifacts match capture", async () => {
  const mask = new SecretMasker(["sensitive-secret","short","sensitive-secret"]);
  expect([mask.push(Buffer.from("before sen")).toString(),mask.push(Buffer.from("sitive-secret after")).toString(),mask.flush().toString()]).toEqual(golden.masked);
  const dir = mkdtempSync(join(tmpdir(),"pacer-session-parity-"));
  try {
    const recording = new Recording(dir,{capBytes:400});
    await recording.output(Buffer.from("one\r\ntwo\n")); recording.resize(80,24); recording.marker("take","owner"); await recording.close();
    expect(readFileSync(join(dir,"stdout"),"utf8")).toBe(golden.live.stdout);
    expect(JSON.parse(readFileSync(join(dir,"session.ckpt"),"utf8"))).toEqual(golden.live.checkpoint);
    expect(view(decodeLog(readFileSync(join(dir,"session.log"))).frames)).toEqual(golden.live.frames);
    expect(view(readRecording(dir).frames)).toEqual(golden.live.readFrames);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("TS masking chooses the longest overlap across every byte split", () => {
  const input=Buffer.from(golden.overlap.inputHex,"hex");
  for(let split=0;split<=input.length;split++) {
    const mask=new SecretMasker(golden.overlap.secrets);
    const out=Buffer.concat([mask.push(input.subarray(0,split)),mask.push(input.subarray(split)),mask.flush()]);
    expect(out.toString("hex")).toBe(golden.overlap.expectedHex);
  }
});

test("TS screen checkpoint snapshot matches captured serialize bytes", async () => {
  const screen = new Screen();
  try { await screen.output(Buffer.from("hi\r\n")); expect(screen.snapshot()).toEqual(golden.screenCheckpoint); }
  finally { screen.dispose(); }
});

test("TS rotation keeps the checkpoint, previous generation and gap-free suffix", async () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-rotation-parity-"));
  try {
    const recording=new Recording(dir,{capBytes:110});
    for(const part of ["abc","def","ghi"]) await recording.output(Buffer.from(part));
    await recording.close();
    const old=decodeLog(readFileSync(join(dir,"session.log.1")));
    const current=decodeLog(readFileSync(join(dir,"session.log")));
    const shape=(log:typeof old)=>({generation:log.header.generation,outputOffset:log.header.outputOffset,frames:view(log.frames)});
    expect({artifacts:readdirSync(dir).sort(),checkpoint:JSON.parse(readFileSync(join(dir,"session.ckpt"),"utf8")),old:shape(old),current:shape(current),since2:recording.since(2)?.map(b=>b.toString("hex"))??null,readFrames:view(readRecording(dir).frames),stdout:readFileSync(join(dir,"stdout"),"utf8")}).toEqual(golden.rotation);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("TS crash between log rename and new header reads the previous generation", async () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-crash-parity-"));
  try {
    const recording=new Recording(dir,{capBytes:400});
    await recording.output(Buffer.from("abc")); await recording.close();
    renameSync(join(dir,"session.log"),join(dir,"session.log.1"));
    expect(view(readRecording(dir).frames)).toEqual([{type:1,data:"616263"}]);
    expect(readRecording(dir,0).frames.map(f=>f.data.toString())).toEqual(["abc"]);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("TS checkpoint slicing and missing-log fallback preserve absolute offsets", () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-offset-parity-"));
  try {
    const checkpoint={generation:0,outputOffset:2,cols:120,rows:40,scrollbackAnsi:"ab",screenAnsi:"",modes:{}};
    writeFileSync(join(dir,"session.ckpt"),JSON.stringify(checkpoint));
    writeFileSync(join(dir,"session.log"),Buffer.concat([encodeHeader({cols:120,rows:40,startedAt:1,generation:0,outputOffset:0}),encodeRecord(1,0,Buffer.from("abcd")),encodeRecord(3,0,Buffer.from("marker"))]));
    expect(view(readRecording(dir).frames)).toEqual([{type:1,data:"6364"},{type:3,data:"6d61726b6572"}]);
    expect(view(readRecording(dir,1).frames)).toEqual([{type:1,data:"626364"}]);
    rmSync(join(dir,"session.log"));
    expect(readRecording(dir,2)).toEqual({frames:[]});
    expect(readRecording(dir,0)).toEqual({checkpoint,frames:[]});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("seeded TS plain transcript corpus stays fixed", () => {
  for (const row of corpus.plain) {
    const plain = new PlainText();
    const pushOut: string[] = [];
    for (const chunk of row.chunks as string[]) {
      pushOut.push(plain.push(Buffer.from(chunk, "hex")));
    }
    expect(pushOut).toEqual(row.pushOut);
    expect(plain.flush()).toBe(row.flushOut);
  }
});

test("seeded TS malformed-log and streaming-mask corpus stays fixed", () => {
  for(const row of corpus.logs) {
    const bytes=Buffer.from(row.hex,"hex");
    if(row.error) expect(()=>decodeLog(bytes)).toThrow(row.error);
    else {const decoded=decodeLog(bytes);expect({validBytes:decoded.validBytes,types:decoded.frames.map(f=>f.type)}).toEqual(row.result);}
  }
  for(const row of corpus.masking) {
    const mask=new SecretMasker(row.secrets);
    expect([...row.chunks.map((c:string)=>mask.push(Buffer.from(c)).toString("hex")),mask.flush().toString("hex")]).toEqual(row.out);
  }
});

test("seeded TS JSON numbers and version strings retain reader semantics", () => {
  const dir=mkdtempSync(join(tmpdir(),"pacer-session-json-parity-"));
  try {
    for(const row of corpus.versions) {
      writeFileSync(join(dir,"session.version"),row.json);
      const parsed=readSessionVersion(dir);
      expect(!!parsed).toBe(row.accepted);
      expect(hostOlder(parsed,"0.12.1")).toBe(row.older);
    }
    for(const row of corpus.recordingNumbers) {
      const header=Buffer.from(row.header);
      const prefix=Buffer.alloc(13);
      prefix.write("PACERTTY");prefix[8]=1;prefix.writeUInt32BE(header.length,9);
      writeFileSync(join(dir,"session.log"),Buffer.concat([prefix,header,encodeRecord(1,0,Buffer.from("abc"))]));
      if(row.checkpoint) writeFileSync(join(dir,"session.ckpt"),row.checkpoint);
      else rmSync(join(dir,"session.ckpt"),{force:true});
      expect(readRecording(dir,row.from).frames.map(f=>f.data.toString("hex"))).toEqual(row.suffix);
      expect(readRecording(dir).frames.map(f=>f.data.toString("hex"))).toEqual(row.readFrames);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

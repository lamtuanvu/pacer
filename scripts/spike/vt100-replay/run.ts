import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadCorpus, reference, compareReplay, parseCandidate } from "./replay";
import { browserComparator } from "./browser";

const args = process.argv.slice(2);
const option = (name:string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at+1]; };
const corpus = await loadCorpus();
if (args.includes("--rust-input")) {
  console.log(JSON.stringify({corpusSha256:corpus.sha256,streams:corpus.streams}));
} else {
  const candidatePath = option("--candidate"), output = resolve(option("--out") ?? ".work/fixtures/vt100-replay/results");
  const candidate = candidatePath ? parseCandidate(await Bun.file(candidatePath).json(),corpus) : undefined;
  await mkdir(output,{recursive:true});
  let browser:Awaited<ReturnType<typeof browserComparator>>|undefined;
  let browserError:string|undefined;
  if (!args.includes("--no-browser")) {
    try { browser = await browserComparator(join(output,"screenshots")); }
    catch(error) { browserError = error instanceof Error ? error.message : String(error); }
  }
  const entries = [];
  try {
    for (const stream of corpus.streams) {
      const baseline = await reference(stream);
      const selfCheck = await compareReplay(baseline,baseline.replay);
      const checkpoint = await reference({...stream,data:baseline.replay});
      const entry = candidate?.entries.find(e => e.id === stream.id);
      const replay = entry ? Buffer.from(entry.replayBase64,"base64").toString("utf8") : baseline.replay;
      const native = entry ? await compareReplay(baseline,replay) : undefined;
      const checkpointComparison = entry ? await compareReplay(checkpoint,replay) : undefined;
      const oraclePixels = browser ? await browser.compare(`${stream.id}-reference-roundtrip`,stream.data,baseline.replay) : undefined;
      const sourcePixels = browser && entry ? await browser.compare(`${stream.id}-source`,stream.data,replay) : undefined;
      const pixels = browser ? await browser.compare(stream.id,baseline.replay,replay) : undefined;
      entries.push({id:stream.id,tags:stream.tags,referenceRoundtrip:selfCheck.differences,referenceDetails:selfCheck.details,
        nativeDifferences:native?.differences,nativeDetails:native?.details,
        checkpointDifferences:checkpointComparison?.differences,checkpointDetails:checkpointComparison?.details,
        oraclePixels,sourcePixels,pixels});
    }
    const hashFile = async (file:string|URL) => createHash("sha256").update(await Bun.file(file).bytes()).digest("hex");
    const referenceVerdict = entries.some(e => e.referenceRoundtrip.length || e.oraclePixels?.equal === false) ? "FAIL" : "PASS";
    const nativeVerdict = !candidate ? "UNVERIFIED" : entries.some(e => e.nativeDifferences?.length || e.sourcePixels?.equal === false || e.checkpointDifferences?.length || e.pixels?.equal === false)
      ? "FAIL" : !browser ? "UNVERIFIED" : "PASS";
    const report = {schema:1,corpusSha256:corpus.sha256,
      referenceSourceSha256:await hashFile(new URL("../../../src/session/screen.ts",import.meta.url)),
      adapterSourceSha256:await hashFile(option("--adapter") ?? new URL("./vt100.rs",import.meta.url)),
      candidateSha256:candidatePath ? await hashFile(candidatePath) : null,dimensions:{cols:120,rows:40},
      engine:candidate ? {name:candidate.engine,version:candidate.version} : null,
      browser:browser ? {version:browser.version,renderer:"xterm default; terminal screenshot, no canvas addon"} : null,
      browserError:browserError ?? null,
      referenceVerdict,nativeVerdict,
      verdict:referenceVerdict === "FAIL" || nativeVerdict === "FAIL" ? "FAIL" : nativeVerdict,
      entries};
    await writeFile(join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
    console.log(JSON.stringify({verdict:report.verdict,streams:entries.length,
      referenceRoundtripFailures:entries.filter(e => e.referenceRoundtrip.length).map(e => ({id:e.id,differences:e.referenceRoundtrip})),
      referencePixelFailures:entries.filter(e => e.oraclePixels?.equal === false).map(e => e.id),
      sourcePixelFailures:entries.filter(e => e.sourcePixels?.equal === false).map(e => e.id),
      checkpointFailures:entries.filter(e => e.checkpointDifferences?.length).map(e => ({id:e.id,differences:e.checkpointDifferences})),
      nativeFailures:entries.filter(e => e.nativeDifferences?.length).map(e => ({id:e.id,differences:e.nativeDifferences})),
      pixelFailures:entries.filter(e => e.pixels?.equal === false).map(e => e.id),browserError,
      report:join(output,"report.json")},null,2));
    process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "FAIL" ? 1 : 2;
  } finally {await browser?.close();}
}

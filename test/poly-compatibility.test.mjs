import test from "node:test";
import assert from "node:assert/strict";
import { audioRecord, MemoryWritable } from "./helpers.mjs";
import { readAudioSample } from "../src/wave-audio.js";
import { scanWave, listWaveChunks, parseWaveFmt } from "../src/wave.js";
import { writeCombinedPolyToWritable, validateCombineGroup, combineSourceInfo } from "../src/wave-combine.js";
import { syncWorkflowText, syncPackageManifest } from "../src/sync-workflow.js";

const signal = value => new Float32Array(32).fill(value);
async function take() { return Promise.all([
  audioRecord("ZOOM0001_LR.WAV", [signal(0.1), signal(0.2)]),
  audioRecord("ZOOM0001_Tr1.WAV", [signal(0.3)]),
  audioRecord("ZOOM0001_Tr2.WAV", [signal(-0.4)]),
  audioRecord("ZOOM0001_Tr3.WAV", [signal(0.5)]),
]); }
async function combine(records, options = {}) {
  const writable = new MemoryWritable();
  const result = await writeCombinedPolyToWritable("ZOOM0001", records, writable, "test_Poly.WAV", { fallbackFpsValue: "25", ...options });
  const file = new File([writable.bytes], "test_Poly.WAV");
  const parsed = await scanWave({ getFile: async () => file });
  return { result, parsed, file, bytes: writable.bytes, writable };
}

test("Resolve excludes confirmed LTC, contiguous iXML, discrete PCM24, source immutable", async () => {
  const records = await take(); const before = await Promise.all(records.map(record => record.file.arrayBuffer()));
  const { result, parsed, file } = await combine(records, { ltcSourceChannels: new Set(["ZOOM0001_Tr3.WAV:0"]) });
  assert.equal(result.channels, 4); assert.equal(parsed.channels, 4); assert.equal(parsed.bitsPerSample, 24);
  assert.equal(parsed.fmtTag, 65534); assert.equal(parsed.audioFormat, 1); assert.equal(parsed.oldTimeReference, 172800000n);
  const chunks = await listWaveChunks(file); const fmt = chunks.chunks.find(chunk => chunk.id === "fmt ");
  const fmtView = new DataView(await file.slice(fmt.start, fmt.start + 40).arrayBuffer());
  assert.equal(parseWaveFmt(fmtView, 40).channelMask, 0);
  const xmlChunk = chunks.chunks.find(chunk => chunk.id === "iXML");
  const xml = await file.slice(xmlChunk.start, xmlChunk.start + Number(xmlChunk.size)).text();
  assert.match(xml, /<TRACK_COUNT>4<\/TRACK_COUNT>/);
  assert.deepEqual([...xml.matchAll(/<CHANNEL_INDEX>(\d+)<\/CHANNEL_INDEX>/g)].map(match => Number(match[1])), [1,2,3,4]);
  assert.deepEqual([...xml.matchAll(/<INTERLEAVE_INDEX>(\d+)<\/INTERLEAVE_INDEX>/g)].map(match => Number(match[1])), [1,2,3,4]);
  const view = new DataView(await file.slice(parsed.dataOffset).arrayBuffer());
  const expected = [0.1,0.2,0.3,-0.4];
  for (let frame = 0; frame < 32; frame++) for (let ch = 0; ch < 4; ch++) assert.ok(Math.abs(readAudioSample(view,frame*12+ch*3,parsed)-expected[ch]) < 1/32768);
  for (let i=0; i<records.length; i++) assert.deepEqual(await records[i].file.arrayBuffer(), before[i]);
  assert.equal(result.excludedTracks[0].source, "ZOOM0001_Tr3.WAV");
});

test("explicit ISO selection removes LR mix, not by silence heuristic", async () => {
  const records = await take();
  const { parsed, result } = await combine(records, { selectedSourceChannels: new Set(["ZOOM0001_Tr1.WAV:0", "ZOOM0001_Tr2.WAV:0"]) });
  assert.equal(parsed.channels,2); assert.equal(parsed.fmtTag,1); assert.deepEqual(result.tracks.map(track => track.name),["Tr1","Tr2"]);
  const silent = await audioRecord("silent_Tr1.WAV", [signal(0)]);
  assert.equal(validateCombineGroup([silent]).tracks.length,1);
});

test("Sidus retains LTC and archive retains float with fact chunk", async () => {
  const records = await take();
  const { parsed } = await combine(records, { profile: "sidus", ltcSourceChannels: new Set(["ZOOM0001_Tr3.WAV:0"]) });
  assert.equal(parsed.channels,5);
  const record = await audioRecord("float.wav", [signal(0.25)], { float:true,bits:32 });
  const output = await combine([record], { profile:"archive" });
  assert.equal(output.parsed.audioFormat,3); assert.equal(output.parsed.bitsPerSample,32);
  assert.ok((await listWaveChunks(output.file)).chunks.some(chunk=>chunk.id === "fact"));
});

test("24-bit PCM, 8/16/32-bit PCM and float preserve signal and report clipping", async () => {
  for (const bits of [8,16,24,32]) {
    const record = await audioRecord("pcm.wav", [signal(-0.5),signal(0.5)], {bits});
    const { parsed,file } = await combine([record]);
    const view=new DataView(await file.slice(parsed.dataOffset).arrayBuffer());
    assert.equal(readAudioSample(view,0,parsed),-0.5); assert.equal(readAudioSample(view,3,parsed),0.5);
  }
  const record=await audioRecord("float.wav",[Float32Array.from([2,-2,NaN,0.5])],{bits:32,float:true});
  const {result}=await combine([record]); assert.equal(result.clippedSamples,2); assert.equal(result.invalidSamples,1);
  assert.match(syncWorkflowText(result),/削波/);
});

test("unknown/empty selection and unequal durations reject before output", async () => {
  const records = await take();
  assert.throws(()=>validateCombineGroup(records,{selectedSourceChannels:new Set()}),/没有选择/);
  assert.throws(()=>validateCombineGroup(records,{selectedSourceChannels:new Set(["missing:0"])}),/不存在/);
  assert.throws(()=>validateCombineGroup(records,{profile:"typo"}),/未知/);
  assert.throws(()=>validateCombineGroup(records.map((record,i)=>i?record:{...record,durationSamples:33n})),/时长不同/);
  const solo=records[3]; assert.throws(()=>validateCombineGroup([solo],{ltcSourceChannels:new Set(["ZOOM0001_Tr3.WAV:0"])}),/没有可用/);
});

test("failed writes abort rather than commit incomplete output", async () => {
  const records = await take(); const writable = new MemoryWritable();
  let writes=0; const original=writable.write.bind(writable);
  writable.write=async data=>{ if(++writes===4) throw new Error("disk-full"); await original(data); };
  await assert.rejects(writeCombinedPolyToWritable("take",records,writable,"bad.wav"),/disk-full/);
  assert.equal(writable.aborted,true); assert.equal(writable.closed,false);
});

test("workflow sidecar warns about retained camera audio, reference workflow and encoding", async()=>{
  const {result}=await combine(await take(),{profile:"syncaila"});
  const text=syncWorkflowText(result,{fpsValue:"25"});
  assert.match(text,/Retain embedded audio/); assert.match(text,/Comparison channel/); assert.match(text,/未在本机实测/);
  assert.match(text,/不要同时导入/); assert.match(text,/SyncRef/);
  assert.equal(JSON.parse(JSON.stringify(syncPackageManifest(result))).durationSamples,"32");
});

test("invalid preflight aborts an already-open output stream", async () => {
  const writable = new MemoryWritable();
  await assert.rejects(writeCombinedPolyToWritable("take", await take(), writable, "bad.wav", { selectedSourceChannels: new Set() }), /没有选择/);
  assert.equal(writable.aborted, true); assert.equal(writable.closed, false);
});

test("chosen LTC/preview fps overrides stale source metadata without editing the source", async () => {
  const records = (await take()).map(record => ({ ...record, _combineFpsValue: "29.97df", ixmlInfo: { timecodeRate: { value: "24/1" }, timecodeFlag: { value: "NDF" } } }));
  const source = combineSourceInfo(records, { fallbackFpsValue: "25" });
  assert.equal(source.timecodeRate, "30000/1001"); assert.equal(source.timecodeFlag, "DF");
  assert.equal(records[0].ixmlInfo.timecodeRate.value, "24/1");
  assert.throws(() => combineSourceInfo(records.map((record, i) => i ? record : { ...record, _combineFpsValue: "25" })), /帧率不一致/);
});

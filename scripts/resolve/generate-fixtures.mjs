// Synthetic media only. Never reads or modifies production footage.
import fs from "node:fs";
import path from "node:path";
import { audioRecord, MemoryWritable } from "../../test/helpers.mjs";
import { encodeVoiceLike, encodeLtcAudio } from "../../test/ltc-encode.mjs";
import { writeCombinedPolyToWritable } from "../../src/wave-combine.js";
import { syncWorkflowText, syncPackageManifest } from "../../src/sync-workflow.js";
const out=path.resolve(process.argv[2] || "test/artifacts/resolve"); fs.mkdirSync(out,{recursive:true});
const voice=encodeVoiceLike({durationSeconds:8,amplitude:0.3});
const other=Float32Array.from(voice,(value,i)=>value*0.6+0.02*Math.sin(i*2*Math.PI*179/48000));
const ltc=encodeLtcAudio({durationSeconds:8,startTc:"01:00:00:00",fps:25,amplitude:0.003}).data;
const records=await Promise.all([
 audioRecord("ZOOM0001_LR.WAV",[voice,voice]),
 audioRecord("ZOOM0001_Tr1.WAV",[voice]),
 audioRecord("ZOOM0001_Tr2.WAV",[other]),
 audioRecord("ZOOM0001_Tr6.WAV",[ltc]),
]);
const camera=await audioRecord("camera_audio.wav",[voice]); fs.writeFileSync(path.join(out,"camera_audio.wav"),new Uint8Array(await camera.file.arrayBuffer()));
for(const [name,options] of [
 ["resolve_discrete4.wav",{profile:"resolve",ltcSourceChannels:new Set(["ZOOM0001_Tr6.WAV:0"])}],
 ["resolve_iso2.wav",{profile:"resolve",selectedSourceChannels:new Set(["ZOOM0001_Tr1.WAV:0","ZOOM0001_Tr2.WAV:0"])}],
 ["sidus_ltc5.wav",{profile:"sidus"}],
 ["syncaila_ref.wav",{profile:"syncaila",selectedSourceChannels:new Set(["ZOOM0001_Tr1.WAV:0"])}],
]) {
 const writable=new MemoryWritable(); const result=await writeCombinedPolyToWritable("fixture",records,writable,name,{fallbackFpsValue:"25",...options});
 fs.writeFileSync(path.join(out,name),writable.bytes);
 fs.writeFileSync(path.join(out,name+".txt"),syncWorkflowText(result,{fpsValue:"25",startTimecode:"01:00:00:00"}));
 fs.writeFileSync(path.join(out,name+".json"),JSON.stringify(syncPackageManifest(result,{fpsValue:"25",startTimecode:"01:00:00:00"}),null,2));
 console.log(`${name}: ${result.channels}ch ${result.bitsPerSample}bit`);
}

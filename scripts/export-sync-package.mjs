// Native CLI for export presets; does not depend on the in-progress front-end.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scanWave, readDataView } from "../src/wave.js";
import { writeCombinedPolyToWritable, validateCombineGroup, safeWaveBaseName } from "../src/wave-combine.js";
import { detectTakeGroupKeys, recordsByGroupFor, shortGroupLabel, recordKey } from "../src/grouping.js";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { parseFps, framesToSamples, timecodeToFrames, samplesToTimecode, ixmlRateToFpsValue } from "../src/timecode.js";
import { polyExportProfile } from "../src/poly-export-profiles.js";
import { ltcFailureSummary } from "../src/ltc-signal.js";
import { syncWorkflowText, syncPackageManifest } from "../src/sync-workflow.js";

const args={};
const allowed=new Set(["input","output","profile","fps","take","auto-ltc","allow-no-ltc","overwrite","help","ltc-channel","channels","reference","start-timecode","scan-seconds"]);
for(let i=2;i<process.argv.length;i++) {
 const flag=process.argv[i];
 if(!allowed.has(flag.slice(2))) throw new Error(`Unknown option: ${flag}`);
 if(!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
 if(["--auto-ltc","--allow-no-ltc","--overwrite","--help"].includes(flag)) args[flag.slice(2)]=true;
 else { if(!process.argv[i+1] || process.argv[i+1].startsWith("--")) throw new Error(`Missing value: ${flag}`); args[flag.slice(2)]=process.argv[++i]; }
}
if(args.help || !args.input || !args.output) {
 console.log(`Usage: node scripts/export-sync-package.mjs --input <take-folder> --output <output-folder>
  --profile resolve|sidus|pluraleyes|syncaila|archive (default: resolve)
  --fps 25 (fallback only; --auto-ltc detects actual fps)
  --take ZOOM0001                 required if folder contains multiple takes
  --scan-seconds 60                analysis scan cap (raise for late-start LTC)
  --auto-ltc                      decode and write start TC into NEW outputs only
  --allow-no-ltc                  allow unverified original TC if auto detection fails
  --ltc-channel ZOOM0001_Tr6.WAV:1 explicit confirmed LTC channel (1-based)
  --channels ZOOM0001_Tr1.WAV:1,ZOOM0001_Tr2.WAV:1
  --reference ZOOM0001_Tr1.WAV:1  optional mono SyncRef (must be retained program audio)
  --start-timecode 01:00:00:00    explicit start label at --fps, applied to one take
  --overwrite                    allow replacing existing OUTPUT files; never source
No source is modified. Use a dedicated output directory. Unselected/silent microphones are not guessed.`);
 process.exit(args.help?0:1);
}
const input=path.resolve(args.input), out=path.resolve(args.output);
const inside=path.relative(input,out);
if(!inside || (!inside.startsWith(".."+path.sep) && inside!==".." && !path.isAbsolute(inside))) throw new Error("Output must be outside input folder to protect source media");
const profile=polyExportProfile(args.profile || "resolve");
const fpsValue=args.fps || "25"; parseFps(fpsValue);
const scanSeconds=Number(args["scan-seconds"] || 60);
if(!Number.isFinite(scanSeconds) || scanSeconds<1 || scanSeconds>3600) throw new Error("--scan-seconds must be between 1 and 3600");
const records=[];
for(const name of (await fsp.readdir(input)).filter(name=>/\.(wav|wave)$/i.test(name)).sort()) {
 const blob=await fs.openAsBlob(path.join(input,name));
 const file=new File([blob],name);
 records.push(await scanWave({name,getFile:async()=>file},{relativePath:name,parentPath:""}));
}
if(!records.length) throw new Error("No WAV files in input folder");
const groups=recordsByGroupFor(records,detectTakeGroupKeys(records));
const matches=[...groups].filter(([key])=>!args.take || shortGroupLabel(key).toLowerCase()===args.take.toLowerCase());
if(matches.length!==1) throw new Error(`Choose exactly one take with --take. Available: ${[...groups.keys()].map(shortGroupLabel).join(", ")}`);
let [takeKey,take]=matches[0];
const channelKey=text=>{
 const match=text.match(/^(.*):(\d+)$/); if(!match || Number(match[2])<1) throw new Error(`Invalid channel: ${text} (use file.wav:1)`);
 const record=take.find(record=>record.name.toLowerCase()===match[1].toLowerCase());
 if(!record || Number(match[2])>record.channels) throw new Error(`Unknown source channel: ${text}`);
 return `${recordKey(record)}:${Number(match[2])-1}`;
};
const ltcSourceChannels=new Set(args['ltc-channel']?[channelKey(args['ltc-channel'])]:[]);
let outputFps=fpsValue, verifiedTc=false;
if(args['auto-ltc']) {
 const decoder=createLtcDecoder({readDataView,candidateFpsValues:()=>["23.976","24","25","29.97","29.97df","30","48","50","59.94","59.94df","60"],defaultFpsValue:()=>fpsValue,fpsSelectLabel:value=>value});
 const readChannel=decoder.readChannel.bind(decoder);
 decoder.readChannel=(record,channel)=>readChannel(record,channel,scanSeconds);
 const attempts=[]; let detected=null;
 for(const record of take) {
  const auto=await decoder.detectAuto(record,parseFps(fpsValue));
  attempts.push({record,channelReports:auto.channelReports,candidates:auto.results});
  const best=auto.best;
  if(best && best.qualityRank>=2 && best.lockedFrames>=3 && best.confidence>=0.6) { detected={...best,sourceRecord:record}; break; }
 }
 if(!detected) {
  const failure=ltcFailureSummary(attempts);
  if(!args['allow-no-ltc']) throw new Error(`${failure.message}；${failure.suggestion}。未输出任何文件；波形流程可显式加 --allow-no-ltc`);
  console.warn(`WARNING: ${failure.message}; exporting unverified original TC`);
 } else {
  outputFps=detected.fpsValue; verifiedTc=true;
  ltcSourceChannels.add(`${recordKey(detected.sourceRecord)}:${detected.channelIndex}`);
  take=take.map(record=>({...record,oldTimeReference:detected.newTimeReference,_combineFpsValue:outputFps}));
  console.log(`LTC: ${detected.sourceRecord.name} channel ${detected.channelIndex+1}, ${outputFps} fps, analysis gain ${detected.analysisGain}`);
 }
}
if(args['start-timecode']) {
 outputFps=fpsValue; verifiedTc=true;
 const fps=parseFps(outputFps),frames=timecodeToFrames(args['start-timecode'],fps);
 take=take.map(record=>({...record,oldTimeReference:framesToSamples(frames,record.sampleRate,fps),_combineFpsValue:outputFps}));
}
const options={profile:profile.id,fallbackFpsValue:outputFps,ltcSourceChannels};
if(args.channels) options.selectedSourceChannels=new Set(args.channels.split(",").map(channelKey));
const plan=validateCombineGroup(take,options);
const reference=args.reference?channelKey(args.reference):null;
if(reference && !plan.tracks.some(track=>`${recordKey(track.record)}:${track.channelIndex}`===reference)) throw new Error("Reference must be retained program channel, not excluded LTC");
if(profile.reference && !reference) console.warn("WARNING: waveform preset needs a meaningful comparison channel; no mono SyncRef requested");
const stem=safeWaveBaseName(shortGroupLabel(takeKey))+"_"+profile.id;
const wavName=stem+"_Poly.WAV", refName=reference?stem+"_SyncRef.WAV":null;
await fsp.mkdir(out,{recursive:true});
const realRelative=path.relative(await fsp.realpath(input),await fsp.realpath(out));
if(!realRelative || (!realRelative.startsWith(".."+path.sep) && realRelative!==".." && !path.isAbsolute(realRelative))) throw new Error("Resolved output is inside input (possibly via symlink); refuse to touch source directory");
for(const name of [wavName,refName,stem+"_合板说明.txt",stem+"_channels.json"].filter(Boolean)) {
 try { await fsp.access(path.join(out,name)); if(!args.overwrite) throw new Error(`Output exists: ${name}; choose another output directory or --overwrite`); }
 catch(error) { if(error.code!=="ENOENT") throw error; }
}
async function writeWave(name,opts) {
 const dest=path.join(out,name), staging=dest+"."+randomUUID()+".partial";
 const file=await fsp.open(staging,"wx"); let closed=false;
 const writable={
  async write({position=0,data}) { const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength); let done=0; while(done<bytes.length) { const n=(await file.write(bytes,done,bytes.length-done,position+done)).bytesWritten; if(!n) throw new Error("Disk write stalled"); done+=n; } },
  async truncate(size){await file.truncate(size);},
  async close(){if(!closed){closed=true;await file.close();}},
  async abort(){if(!closed){closed=true;await file.close();} await fsp.unlink(staging).catch(()=>{});},
 };
 try { const result=await writeCombinedPolyToWritable(takeKey,take,writable,name,opts); await fsp.rename(staging,dest); return result; }
 catch(error){await writable.abort();throw error;}
}
const result=await writeWave(wavName,options);
if(reference) { await writeWave(refName,{...options,selectedSourceChannels:new Set([reference])}); result.referenceName=refName; }
outputFps=take[0]._combineFpsValue || ixmlRateToFpsValue(take[0].ixmlInfo) || outputFps;
const delivery={fpsValue:outputFps,startTimecode:samplesToTimecode(take[0].oldTimeReference,take[0].sampleRate,parseFps(outputFps),{wrapDay:true})+(verifiedTc?"":"（原始 metadata，未经合板确认）"),referenceName:refName,referenceChannel:args.reference};
await fsp.writeFile(path.join(out,stem+"_合板说明.txt"),"\uFEFF"+syncWorkflowText(result,delivery),{encoding:"utf8",flag:args.overwrite?"w":"wx"});
await fsp.writeFile(path.join(out,stem+"_channels.json"),JSON.stringify(syncPackageManifest(result,delivery),null,2),{encoding:"utf8",flag:args.overwrite?"w":"wx"});
console.log(`Saved ${wavName}: ${result.channels}ch, ${result.bitsPerSample}bit. Source files unchanged.`);
if(result.clippedSamples || result.invalidSamples) console.warn(`WARNING: PCM24 conversion clipped ${result.clippedSamples} samples, invalid ${result.invalidSamples}. Use archive or lower input gain.`);

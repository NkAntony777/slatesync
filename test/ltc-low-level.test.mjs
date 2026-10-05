import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { audioRecord } from "./helpers.mjs";
import { encodeLtcAudio, encodeVoiceLike, incrementTc } from "./ltc-encode.mjs";
import { createLtcDecoder } from "../src/ltc-decoder.js";
import { LTC_WORKER_CODE } from "../src/ltc-worker.js";
import { readDataView } from "../src/wave.js";
import { parseFps, framesToSamples, timecodeToFrames } from "../src/timecode.js";
import { normalizeLtcAnalysisSignal, ltcFailureSummary } from "../src/ltc-signal.js";
import { buildTakeDiagnostics } from "../src/ltc-diagnostics.js";

const values=["23.976","24","25","29.97","29.97df","30"];
const rand=state=>((state.v=(state.v*1664525+1013904223)>>>0)/4294967296)*2-1;
const decoder=createLtcDecoder({readDataView,candidateFpsValues:()=>values,defaultFpsValue:()=>"25",fpsSelectLabel:value=>value});
async function detectBoth(record, preferred="25", allowSoftSync=false) {
  const main=await decoder.detectAuto(record,parseFps(preferred),{allowSoftSync});
  let message;
  const context=vm.createContext({self:{postMessage:result=>{message=result;}},Float32Array,DataView,Math,BigInt,Number,String,Set,Map,Array});
  vm.runInContext(LTC_WORKER_CODE,context);
  const buffer=await record.file.slice(record.dataOffset,record.dataOffset+record.dataSize).arrayBuffer();
  context.self.onmessage({data:{id:1,buffer,record:{sampleRate:record.sampleRate,channels:record.channels,bitsPerSample:record.bitsPerSample,audioFormat:record.audioFormat,isFloat:record.isFloat,blockAlign:record.blockAlign},preferredValue:preferred,values,allowSoftSync}});
  assert.equal(message.ok,true,message.error);
  return [main,message.result];
}

for(const amplitude of [0.5,0.02,0.005,0.001,0.0003,0.00003]) {
  test(`PCM16 LTC amplitude ${amplitude}: main/worker recover start, raw diagnostics retained`,async()=>{
    const {data}=encodeLtcAudio({durationSeconds:2.5,amplitude});
    const record=await audioRecord("weak.wav",[data]);
    const both=await detectBoth(record);
    for(const auto of both) {
      assert.ok(auto.best,"Expected LTC detection"); assert.equal(auto.best.fpsValue,"25");
      assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference)-172800000n))<=2);
      if(amplitude<0.035) assert.ok(auto.best.analysisGain>1);
      assert.ok(auto.channelReports[0].peak<amplitude+1/32768);
      assert.ok(auto.channelReports[0].candidateCount>0);
    }
    assert.equal(BigInt(both[1].best.newTimeReference),both[0].best.newTimeReference);
  });
}

for(const [rate,value,delay] of [[24,"24",1],[24000/1001,"23.976",0],[30000/1001,"29.97df",0]]) {
 test(`weak ${value} fps, delay ${delay}: time reference is inferred not first lock`,async()=>{
  const drop=value.endsWith("df");
  const {data}=encodeLtcAudio({fps:rate,nominalFps:Math.round(rate),durationSeconds:3,amplitude:0.001,startDelaySeconds:delay,drop});
  const record=await audioRecord("weak.wav",[data]); const both=await detectBoth(record,value);
  const fps=parseFps(value),expected=framesToSamples(timecodeToFrames("01:00:00:00",fps),48000,fps)-BigInt(delay*48000);
  for(const auto of both) { assert.ok(auto.best); assert.equal(auto.best.fpsValue,value); assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference)-expected))<=2); }
 });
}

test("float32 quiet LTC, DC offset and low noise recover with warning",async()=>{
  const {data}=encodeLtcAudio({durationSeconds:3,amplitude:0.00001});
  let seed=117;
  for(let i=0;i<data.length;i++) { seed=(seed*1664525+1013904223)>>>0; data[i]+=0.003+(seed/4294967296-0.5)*0.000001; }
  const record=await audioRecord("weak-float.wav",[data],{bits:32,float:true});
  const [auto,worker]=await detectBoth(record);
  assert.ok(auto.best); assert.ok(worker.best);
  const diag=buildTakeDiagnostics({takeKey:"test",label:"test",groupRecords:[record],report:[{record,pass:"full",channelReports:auto.channelReports,results:auto.results}],detected:{...auto.best,sourceRecord:record},fpsValue:"25"});
  assert.ok(diag.issues.some(issue=>issue.code==="recovered-low-level"));
});

for(const kind of ["silence","voice","noise","sine","sub-quantization"]) {
 test(`${kind} is never accepted as low-level LTC (including enhanced mode)`,async()=>{
  let data;
  if(kind==="voice") data=encodeVoiceLike({durationSeconds:2,amplitude:0.0003});
  else {
   data=new Float32Array(96000); let seed=713;
   for(let i=0;i<data.length;i++) {
    seed=(seed*1664525+1013904223)>>>0;
    data[i]=kind==="noise"?(seed/4294967296-0.5)*0.001:kind==="sine"?Math.sin(i*2*Math.PI*1000/48000)*0.001:0;
   }
   if(kind==="sub-quantization") data=encodeLtcAudio({durationSeconds:2,amplitude:0.000001}).data;
  }
  const record=await audioRecord("not-ltc.wav",[data]);
  const both=await detectBoth(record,"25",true);
  for(const auto of both) assert.equal(auto.best,null);
 });
}

test("fallback mode never returns a wrong timecode under interference",async()=>{
 // P0 regression. docs/LTC识别强化方案.md §4.1 measured a 65.8% wrong-lock rate here
 // (errors up to 809909 frames, ~33h). A refusal to lock is always acceptable;
 // returning a wrong TimeReference is not.
 const levels=[0.25,0.30,0.35,0.40,0.45,0.50,0.60];
 let locks=0,wrong=0;
 for(const seed of [1,2,3,5,8,13]) {
  for(const voice of levels) {
   const {data}=encodeLtcAudio({durationSeconds:3,amplitude:0.03});
   const talk=encodeVoiceLike({durationSeconds:3,amplitude:voice});
   let state=seed>>>0;
   const rand=()=>((state=(state*1664525+1013904223)>>>0)/4294967296)*2-1;
   for(let i=0;i<data.length;i++) data[i]+=talk[i]+0.02*rand();
   const record=await audioRecord("stress.wav",[data]);
   const auto=await decoder.detectAuto(record,parseFps("25"),{allowSoftSync:true});
   if(!auto.best) continue;
   locks++;
   const errFrames=Number(BigInt(auto.best.newTimeReference)-172800000n)/1920;
   if(Math.abs(errFrames)>1.01) { wrong++; assert.fail(`seed ${seed} voice ${voice}: read ${auto.best.timecode}, off by ${errFrames.toFixed(1)} frames`); }
   assert.equal(auto.best.requiresConfirmation,true);
  }
 }
 assert.equal(wrong,0);
 assert.ok(locks>0,"stress matrix must still exercise at least one lock, otherwise this test is vacuous");
});

test("fallback mode still recovers runs that satisfy the strict grammar",async()=>{
 // The tightened budget must not throw away corroborated locks: these need
 // 3+ consecutive incrementing frames, which is what the 25 wrong locks never had.
 const cases=[
  {label:"white noise",ltc:0.05,seed:13,mix:(data,dur,state)=>{
   for(let i=0;i<data.length;i++) data[i]+=0.10*rand(state);
  }},
  {label:"voice-like",ltc:0.03,seed:1,mix:(data,dur,state)=>{
   const talk=encodeVoiceLike({durationSeconds:dur,amplitude:0.30});
   for(let i=0;i<data.length;i++) data[i]+=talk[i];
  }},
 ];
 for(const {label,ltc,seed,mix} of cases) {
  const duration=4;
  const {data}=encodeLtcAudio({durationSeconds:duration,amplitude:ltc});
  const state={v:seed>>>0};
  mix(data,duration,state);
  const record=await audioRecord("recover.wav",[data]);
  const both=await detectBoth(record,"25",true);
  for(const auto of both) {
   assert.ok(auto.best,`${label}: expected a fallback lock`);
   assert.equal(auto.best.softSync,true,`${label}: should come from the fallback path`);
   assert.ok(auto.best.lockedFrames>=3,`${label}: only ${auto.best.lockedFrames} locked frames`);
   assert.equal(auto.best.requiresConfirmation,true);
   assert.ok(Math.abs(Number(BigInt(auto.best.newTimeReference)-172800000n)/1920)<=1.01,`${label}: ${auto.best.timecode} is off`);
  }
 }
});

test("failure messages distinguish silence, low level, instability and read errors",()=>{
 assert.equal(ltcFailureSummary([{channelReports:[{peak:0}]}]).code,"silent");
 assert.equal(ltcFailureSummary([{channelReports:[{peak:0.002}]}]).code,"low-level");
 assert.equal(ltcFailureSummary([{channelReports:[{peak:0.2,rejectReason:"aperiodic"}]}]).code,"not-periodic");
 assert.equal(ltcFailureSummary([],new Error("bad wav")).code,"scan-error");
 assert.equal(normalizeLtcAnalysisSignal(new Float32Array(20)).analysisGain,1);
});

test("test encoder skips correct labels at DF minute boundary and not tenth minute",()=>{
 assert.deepEqual(incrementTc({hh:0,mm:0,ss:59,ff:29,nominal:30,drop:true}),{hh:0,mm:1,ss:0,ff:2,nominal:30,drop:true});
 assert.deepEqual(incrementTc({hh:0,mm:9,ss:59,ff:29,nominal:30,drop:true}),{hh:0,mm:10,ss:0,ff:0,nominal:30,drop:true});
 assert.deepEqual(incrementTc({hh:0,mm:0,ss:59,ff:59,nominal:60,drop:true}),{hh:0,mm:1,ss:0,ff:4,nominal:60,drop:true});
});

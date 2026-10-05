// Recognition-matrix benchmark for the feed-forward LTC decoder.
// Run: node docs/ltc-compare/bench-ff.mjs  (from repo root)
import { encodeLtcAudio, encodeVoiceLike } from "file:///D:/game/den/test/ltc-encode.mjs";
import { parseFps, framesToSamples, timecodeToFrames } from "file:///D:/game/den/src/timecode.js";
import { decodeFile } from "./ff-decoder.mjs";

const SR = 48000, DUR = 6;
const EXPECTED = framesToSamples(timecodeToFrames("01:00:00:00", parseFps("25")), SR, parseFps("25"));

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
function onePole(data, sampleRate, { type, cutoff }) {
  const out = new Float32Array(data.length);
  const dt = 1 / sampleRate, rc = 1 / (2 * Math.PI * cutoff);
  if (type === "lp") { const a = dt / (rc + dt); let y = data[0] || 0;
    for (let i = 0; i < data.length; i++) { y += a * (data[i] - y); out[i] = y; } }
  else { const a = rc / (rc + dt); let prevIn = data[0] || 0, y = 0;
    for (let i = 0; i < data.length; i++) { y = a * (y + data[i] - prevIn); prevIn = data[i]; out[i] = y; } }
  return out;
}

{
  const d = encodeLtcAudio({ durationSeconds: 2, amplitude: 0.5 }).data;
  const b = decodeFile(d, 25);
  console.log(`[sanity] clean 2s -> ${b ? `fs=${b.fileStartFrame.toFixed(2)} support=${b.support}/${b.total}` : "NO LOCK"}`);
}

const CASES = [];
CASES.push(["clean 0.5", encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.5 }).data, false]);
CASES.push(["low -30dBFS (0.03)", encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.03 }).data, false]);
for (const a of [0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 0.80, 1.20, 2.00]) {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.05 }).data; const r = rng(13);
  for (let i = 0; i < d.length; i++) d[i] += a * r();
  CASES.push([`white ${a.toFixed(2)} (SNR ${(20 * Math.log10(0.05 / (a / Math.sqrt(3)))).toFixed(1)}dB)`, d, false]);
}
for (const a of [0.10, 0.20, 0.30, 0.50, 0.80, 1.20]) {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.03 }).data;
  const v = encodeVoiceLike({ durationSeconds: DUR, amplitude: a });
  for (let i = 0; i < d.length; i++) d[i] += v[i];
  CASES.push([`voice ${a.toFixed(2)} (SNR ~${(20 * Math.log10(0.03 / (a / Math.sqrt(3)))).toFixed(1)}dB)`, d, false]);
}
CASES.push(["LTC 0.05 + 50Hz hum stack 0.15", (() => {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.05 }).data;
  for (let i = 0; i < d.length; i++) { const t = i / SR;
    d[i] += 0.15 * (Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 100 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t)) / 1.8; }
  return d; })(), false]);
CASES.push(["LTC 0.10 band-limited 400-3200Hz", (() => {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.10 }).data;
  return onePole(onePole(d, SR, { type: "hp", cutoff: 400 }), SR, { type: "lp", cutoff: 3200 }); })(), false]);
CASES.push(["LTC 0.20 + soft clip", (() => {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.9 }).data;
  for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * 2.2) / Math.tanh(2.2);
  return d; })(), false]);
CASES.push(["LTC clock +0.4% (vari-speed)", encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.10, fps: 25 * 1.004, nominalFps: 25 }).data, false]);
CASES.push(["LTC + 1s of dropout", (() => {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.10, startDelaySeconds: 1 }).data;
  for (let i = SR * 2; i < SR * 3; i++) d[i] = 0;
  return d; })(), false]);
CASES.push(["LTC -60dBFS (0.001) + noise 0.02", (() => {
  const d = encodeLtcAudio({ durationSeconds: DUR, amplitude: 0.001 }).data; const r = rng(23);
  for (let i = 0; i < d.length; i++) d[i] += 0.02 * r();
  return d; })(), false]);
{ const d = new Float32Array(DUR * SR); const r = rng(7); for (let i = 0; i < d.length; i++) d[i] = 0.30 * r(); CASES.push(["pure noise 0.30 (must reject)", d, true]); }
{ const d = new Float32Array(DUR * SR); const r = rng(31); for (let i = 0; i < d.length; i++) d[i] = 0.80 * r(); CASES.push(["pure noise 0.80 (must reject)", d, true]); }
CASES.push(["pure voice 0.30 (must reject)", encodeVoiceLike({ durationSeconds: DUR, amplitude: 0.30 }), true]);

// The 1s-delay scenario: LTC physically starts at sample 48000 with TC
// 01:00:00:00, so the extrapolated value at file sample 0 is 89975 frames —
// matching what the repo decoder reports (err -47999 samples).
const EXPECT_OVERRIDE = { "LTC + 1s of dropout": 172752000n };

console.log("\ncase                                 verdict      err(frames)  support");
let right = 0, wrong = 0, miss = 0, fl = 0;
for (const [name, data, mustReject] of CASES) {
  const t0 = Date.now();
  const b = decodeFile(data, 25);
  const ms = Date.now() - t0;
  if (mustReject) {
    if (b) { fl++; console.log(`${name.padEnd(38)} FALSE LOCK fs=${b.fileStartFrame.toFixed(1)}`); }
    else console.log(`${name.padEnd(38)} reject ok  (${ms}ms)`);
    continue;
  }
  if (!b) { miss++; console.log(`${name.padEnd(38)} no-lock`); continue; }
  const exp = EXPECT_OVERRIDE[name] ?? EXPECTED;
  const errF = Number(b.timeRef - exp) / 1920;
  const good = Math.abs(errF) <= 1.01;
  good ? right++ : wrong++;
  console.log(`${name.padEnd(38)} ${(good ? "ok" : "WRONG").padEnd(11)} ${errF.toFixed(1).padStart(11)}  ${b.support}/${b.total} (${ms}ms)`);
}
console.log(`\nright=${right}  WRONG=${wrong}  no-lock=${miss}  false-lock=${fl}`);
